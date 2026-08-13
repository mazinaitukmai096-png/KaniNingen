import {
  assertLogicalChunkCoordinate,
  createChunkKey,
  squareChunkCoordinates,
} from './chunk-coordinates.js';
import { FloatingOrigin } from './floating-origin.js';
import { validateTerrainEdgePair } from './legacy-core/g2/terrain-edge.js';
import { evaluateW1APerformanceWarnings, PerformanceLedger } from './runtime-timing.js';
import { ChunkDataService } from './chunk-data-service.js';
import { CHUNK_DATA_PRIORITY } from './chunk-data-service-protocol.js';
import { createInlineChunkGeneratorTransport } from './inline-chunk-generator-transport.js';
import { createRuntimeTransitionContract } from './runtime-transition-contract.js';

function defaultClock() {
  return globalThis.performance?.now?.() ?? Date.now();
}

function defaultYieldToHost() {
  return new Promise(resolve => globalThis.setTimeout(resolve, 0));
}

function sortedKeys(values) {
  return [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function percentile(values, ratio) {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.floor((ordered.length - 1) * ratio))];
}

const TERRAIN_PRESENTATION_STAGED_CENTER_LIMIT = 3;
const TERRAIN_READY_CHUNK_DATA_DIAGNOSTIC_OWNER_LIMIT = 256;
const TERRAIN_DEPENDENCY_WAIT_SAMPLE_LIMIT = 512;

export class ChunkRuntimeManager {
  constructor({
    chunkDataService = null,
    // Compatibility for older isolated runtime tests. Production boot supplies
    // chunkDataService explicitly; generation still crosses the Service boundary.
    generator = null,
    renderAdapter,
    cacheCapacity = 81,
    identityAuditCapacity = 4096,
    chunkIndex = null,
    clock = defaultClock,
    yieldToHost = defaultYieldToHost,
    onPipelineEvent = null,
  } = {}) {
    if (chunkDataService === null && generator === null) {
      throw new TypeError('chunkDataService is required');
    }
    if (chunkDataService !== null && typeof chunkDataService.requestChunk !== 'function') {
      throw new TypeError('chunkDataService.requestChunk is required');
    }
    for (const method of ['rebase', 'projectChunk', 'loadProjected', 'unloadChunk', 'shutdown']) {
      if (typeof renderAdapter?.[method] !== 'function') throw new TypeError(`renderAdapter.${method} is required`);
    }
    if (!Number.isSafeInteger(cacheCapacity) || cacheCapacity < 25) {
      throw new RangeError('cacheCapacity must retain at least the active 5x5 data set');
    }
    if (!Number.isSafeInteger(identityAuditCapacity) || identityAuditCapacity < cacheCapacity) {
      throw new RangeError('identityAuditCapacity must be an integer at least as large as cacheCapacity');
    }
    if (chunkIndex !== null && (typeof chunkIndex.registerChunk !== 'function'
      || typeof chunkIndex.snapshot !== 'function')) {
      throw new TypeError('chunkIndex must provide registerChunk and snapshot');
    }
    if (typeof clock !== 'function') throw new TypeError('clock must be a function');
    if (typeof yieldToHost !== 'function') throw new TypeError('yieldToHost must be a function');
    if (onPipelineEvent !== null && typeof onPipelineEvent !== 'function') {
      throw new TypeError('onPipelineEvent must be a function when provided');
    }
    this.chunkDataService = chunkDataService ?? new ChunkDataService({
      transport: createInlineChunkGeneratorTransport({ generator }),
      cacheCapacity,
    });
    this.ownsChunkDataService = chunkDataService === null;
    this.renderAdapter = renderAdapter;
    this.cacheCapacity = cacheCapacity;
    this.identityAuditCapacity = identityAuditCapacity;
    this.chunkIndex = chunkIndex;
    this.clock = clock;
    this.yieldToHost = yieldToHost;
    this.onPipelineEvent = onPipelineEvent;
    this.floatingOrigin = new FloatingOrigin();
    this.performance = new PerformanceLedger();
    this.cache = new Map();
    this.identityAudit = new Map();
    this.activeDataKeys = new Set();
    this.renderedKeys = new Set();
    this.provisionalTerrainKeys = new Set();
    this.provisionalTerrainPromises = new Map();
    this.deferredRenderReleaseKeys = new Set();
    this.transitionProtectedDataKeys = new Set();
    this.centerChunkX = null;
    this.centerChunkZ = null;
    this.accessTick = 0;
    this.transitionChain = Promise.resolve();
    this.preparationChain = Promise.resolve();
    this.terrainPresentationPreparationChain = Promise.resolve();
    this.terrainPresentationAdapter = null;
    this.terrainPresentationEntries = new Map();
    this.terrainPresentationDesiredIdentities = new Set();
    this.terrainPresentationGenerationEpoch = 0;
    this.terrainPresentationClaimTargetKey = null;
    this.terrainPresentationInFlightIdentity = null;
    this.terrainPresentationPendingIdentity = null;
    this.terrainPresentationPlayerCenter = null;
    this.terrainPresentationReuseRatioSum = 0;
    this.terrainPresentationReuseRatioSampleCount = 0;
    this.terrainPresentationLastCompletedCenter = null;
    this.terrainPresentationJumpHistogram = new Map();
    this.terrainPresentationReuseByJump = new Map();
    this.terrainPresentationSchedulerIdleStartedAtMs = null;
    this.terrainPresentationSchedulerIdleWithPendingStartedAtMs = null;
    this.terrainPresentationSchedulerIdlePendingIdentity = null;
    this.terrainPresentationLifecycleHistory = [];
    this.isShutdown = false;
    this.latestTransition = null;
    this.pendingPrefetchKeys = new Set();
    this.preparedTransitions = new Map();
    this.preparedPlanRegistry = new Set();
    this.preferredPreparationKey = null;
    this.preparedPlanEpoch = 0;
    this.terrainReadyPlan = null;
    this.terrainReadyPlanEpoch = 0;
    this.terrainReadyProjectedByKey = new Map();
    this.terrainReadyDesiredDataKeys = new Set();
    this.residentRequiredDataKeys = new Set();
    this.terrainReadyDesiredRenderKeys = new Set();
    this.terrainReadyQueuedAtByKey = new Map();
    this.terrainReadyReadyKeys = new Set();
    this.terrainReadyChunkDataOperations = new Map();
    this.terrainReadyChunkDataOwnerDiagnostics = new Map();
    this.terrainDependencyLatestBatch = null;
    this.terrainDependencyWaitSamples = [];
    this.terrainReadyLastOwnerSetDiff = Object.freeze({
      unchanged: 0,
      entering: 0,
      leaving: 0,
    });
    this.terrainReadyLastPrefetchSetDiff = Object.freeze({
      unchanged: 0,
      entering: 0,
      leaving: 0,
    });
    this.terrainReadyStartedAtMs = null;
    this.terrainReadyLastActivityAtMs = null;
    this.terrainReadyArrivalStartedAtMs = null;
    this.terrainReadyCoverageMissOwnerKey = null;
    this.transitionEpoch = 0;
    this.committedTransitionGeneration = 0;
    this.committedTransitionContract = null;
    this.transitionPendingCount = 0;
    this.preparationPendingCount = 0;
    this.renderOrigin = this.floatingOrigin.snapshot();
    this.activeDataKeyList = Object.freeze([]);
    this.renderedKeyList = Object.freeze([]);
    this.counts = {
      generated: 0,
      cacheHits: 0,
      dataActivated: 0,
      dataDeactivated: 0,
      dataEvicted: 0,
      renderLoaded: 0,
      renderUnloaded: 0,
      transitionsRequested: 0,
      transitionsPerformed: 0,
      transitionsCoalesced: 0,
      identityAuditEvicted: 0,
      prefetched: 0,
      preparedTransitions: 0,
      discardedPreparedTransitions: 0,
      preparedProjections: 0,
      maxCacheSize: 0,
      maxActiveDataCount: 0,
      maxRenderedCount: 0,
      deferredRenderReleases: 0,
      renderReleaseFailures: 0,
      terrainReadyPlansRequested: 0,
      terrainReadyPlansCompleted: 0,
      terrainReadyOwnersRequested: 0,
      terrainReadyOwnersGenerated: 0,
      terrainReadyOwnersProjected: 0,
      terrainReadyOwnersReady: 0,
      terrainReadyOwnerReuses: 0,
      terrainReadyPlayerArrivals: 0,
      terrainReadyCoverageMisses: 0,
      terrainReadyGateBlockedFrames: 0,
      terrainReadyRequiredProjections: 0,
      terrainReadyDuplicateGenerations: 0,
      terrainReadyCancelledWork: 0,
      terrainReadyStaleCompletions: 0,
      terrainReadyStalePublishes: 0,
      residentCoverageMisses: 0,
      residentOwnerEvictions: 0,
      residentSameOwnerRerequests: 0,
      requiredCancellationsByPrefetch: 0,
      residentFullWindowRebuilds: 0,
      terrainReadyMaximumQueueDepth: 0,
      terrainReadyMaximumOldestWaitMs: 0,
      chunkDataSubscribersTransferred: 0,
      chunkDataSubscribersEntered: 0,
      chunkDataSubscribersLeft: 0,
      chunkDataUnderlyingRequestsReused: 0,
      chunkDataUnderlyingRequestsCancelled: 0,
      chunkDataDuplicateRequests: 0,
      chunkDataWorkerCancelRequests: 0,
      chunkDataResponsesInsertedAfterPlanSupersede: 0,
      chunkDataSameOwnerRerequestCount: 0,
      terrainDependencyBatchesRegistered: 0,
      terrainDependencyBatchesCompleted: 0,
      terrainDependencyOwnersRegistered: 0,
      terrainDependencyOwnersCompleted: 0,
      terrainDependencyCacheHits: 0,
      terrainDependencyMaximumRegistrationMs: 0,
      terrainPresentationGenerationsRequested: 0,
      terrainPresentationGenerationsStarted: 0,
      terrainPresentationGenerationsCompleted: 0,
      terrainPresentationGenerationsReady: 0,
      terrainPresentationGenerationsClaimed: 0,
      terrainPresentationGenerationsDiscarded: 0,
      terrainPresentationGenerationsCancelled: 0,
      terrainPresentationGenerationsCoalesced: 0,
      terrainPresentationCatchupSteps: 0,
      terrainPresentationReuseRatio: 0,
      terrainPresentationDuplicateGenerations: 0,
      terrainPresentationStalePublishes: 0,
      terrainPresentationRequiredOuterComposes: 0,
      terrainPresentationRequiredClipmapBuilds: 0,
      terrainPresentationMaximumStagedCount: 0,
      terrainPresentationMaximumGeometryCount: 0,
      terrainPresentationMaximumUploadBytes: 0,
      terrainPresentationMaximumSliceMs: 0,
      terrainSchedulerIdleCount: 0,
      terrainSchedulerIdleMs: 0,
      terrainSchedulerIdleWithPendingCount: 0,
      terrainSchedulerIdleWithPendingMs: 0,
      terrainPresentationMaximumPendingWaitMs: 0,
      terrainPresentationCompletedUnclaimedDiscards: 0,
    };
  }

  configureTerrainPresentationAdapter(adapter) {
    if (this.isShutdown) throw new Error('chunk runtime manager is shut down');
    for (const method of ['prepare', 'claim', 'discard']) {
      if (typeof adapter?.[method] !== 'function') {
        throw new TypeError(`Terrain presentation adapter.${method} is required`);
      }
    }
    if (this.terrainPresentationAdapter && this.terrainPresentationAdapter !== adapter) {
      throw new Error('Terrain presentation adapter is already configured');
    }
    this.terrainPresentationAdapter = adapter;
    return true;
  }

  invalidateTerrainPresentationGenerations() {
    this.terrainPresentationDesiredIdentities = new Set();
    this.terrainPresentationClaimTargetKey = null;
    let discarded = 0;
    for (const entry of [...this.terrainPresentationEntries.values()]) {
      if (this.#discardTerrainPresentationEntry(entry, {
        cancelled: entry.state !== 'ready',
        force: true,
        reason: 'invalidated',
      })) {
        discarded += 1;
      }
    }
    this.terrainPresentationInFlightIdentity = null;
    this.terrainPresentationPendingIdentity = null;
    this.#updateTerrainPresentationSchedulerIdleState();
    return discarded;
  }

  initialize(centerChunkX = 0, centerChunkZ = 0) {
    return this.transitionToChunk(centerChunkX, centerChunkZ);
  }

  transitionToChunk(chunkXInput, chunkZInput, { required = false } = {}) {
    const chunkX = assertLogicalChunkCoordinate(chunkXInput, 'centerChunkX');
    const chunkZ = assertLogicalChunkCoordinate(chunkZInput, 'centerChunkZ');
    if (typeof required !== 'boolean') throw new TypeError('required must be a boolean');
    const key = createChunkKey(chunkX, chunkZ);
    if (required) {
      const prepared = this.preparedTransitions.get(key);
      if (prepared && !prepared.discarded) prepared.required = true;
    }
    this.counts.transitionsRequested += 1;
    if (this.onPipelineEvent) this.#recordPipelineEvent('runtime-transition-requested', {
      ownerKey: createChunkKey(chunkX, chunkZ),
      chunkX,
      chunkZ,
      fromChunkX: this.centerChunkX,
      fromChunkZ: this.centerChunkZ,
      transitionPendingCount: this.transitionPendingCount,
      preparationPendingCount: this.preparationPendingCount,
    });
    this.transitionPendingCount += 1;
    const operation = this.transitionChain.then(() => this.#performTransition(
      chunkX,
      chunkZ,
      { required },
    ))
      .finally(() => { this.transitionPendingCount -= 1; });
    this.transitionChain = operation.catch(() => {});
    return operation;
  }

  prefetchChunk(chunkXInput, chunkZInput) {
    const chunkX = assertLogicalChunkCoordinate(chunkXInput, 'prefetchChunkX');
    const chunkZ = assertLogicalChunkCoordinate(chunkZInput, 'prefetchChunkZ');
    const key = createChunkKey(chunkX, chunkZ);
    if (this.isShutdown) return Promise.reject(new Error('chunk runtime manager is shut down'));
    if (this.cache.has(key) || this.pendingPrefetchKeys.has(key)) return Promise.resolve(false);
    this.pendingPrefetchKeys.add(key);
    this.preparationPendingCount += 1;
    const operation = this.preparationChain.then(async () => {
      const result = await this.#ensureChunkData({ chunkX, chunkZ, key });
      if (result.generated) this.counts.prefetched += 1;
      return result.generated;
    }).finally(() => {
      this.pendingPrefetchKeys.delete(key);
      this.preparationPendingCount -= 1;
    });
    this.preparationChain = operation.catch(() => {});
    return operation;
  }

  /**
   * Prepares the full target 5x5 data set and the target 3x3 render set before
   * the player crosses the boundary. Prepared projections are deliberately not
   * attached to the scene until the matching transition commits.
   */
  prepareTransition(chunkXInput, chunkZInput) {
    const chunkX = assertLogicalChunkCoordinate(chunkXInput, 'preparedCenterChunkX');
    const chunkZ = assertLogicalChunkCoordinate(chunkZInput, 'preparedCenterChunkZ');
    if (this.isShutdown) return Promise.reject(new Error('chunk runtime manager is shut down'));
    const key = createChunkKey(chunkX, chunkZ);
    if (this.onPipelineEvent) this.#recordPipelineEvent('runtime-prefetch-requested', {
      ownerKey: key,
      chunkX,
      chunkZ,
      fromChunkX: this.centerChunkX,
      fromChunkZ: this.centerChunkZ,
      preparationPendingCount: this.preparationPendingCount,
    });
    this.preferredPreparationKey = key;
    const stalePlans = this.#markUnpreferredPlans(key);
    const currentKey = this.centerChunkX === null ? null : createChunkKey(this.centerChunkX, this.centerChunkZ);
    const existing = this.preparedTransitions.get(key);
    if (existing && existing.fromCenterKey === currentKey && !existing.discarded) {
      if (!stalePlans.length) return existing.promise;
      const cleanup = this.preparationChain.then(async () => {
        for (const stale of stalePlans) await this.#discardPreparedTransition(stale);
      });
      this.preparationChain = cleanup.catch(() => {});
      return Promise.all([existing.promise, cleanup]).then(([prepared]) => prepared);
    }
    const plan = this.#createPreparedTransitionPlan(chunkX, chunkZ, currentKey);
    this.preparedTransitions.set(key, plan);
    if (this.#markPreparedPlanReadyFromExistingWork(plan)) {
      const cleanup = this.#awaitDiscardedPreparedPlans(stalePlans)
        .then(() => plan);
      plan.promise = cleanup;
      return cleanup;
    }
    this.preparationPendingCount += 1;
    const operation = this.preparationChain.then(async () => {
      for (const stale of stalePlans) await this.#discardPreparedTransition(stale);
      return this.#prepareTransitionPlan(plan, { yieldBetweenUnits: true });
    })
      .finally(() => { this.preparationPendingCount -= 1; });
    plan.promise = operation;
    this.preparationChain = operation.catch(() => {});
    return operation;
  }

  /**
   * Replaces serial next-center preparation with one owner-keyed READY set.
   * Completed staged projections remain reusable across corridor supersession;
   * only owners absent from the latest authoritative set are discarded.
   */
  updateTerrainReadySet(input) {
    if (this.isShutdown) return Promise.reject(new Error('chunk runtime manager is shut down'));
    if (input?.schemaVersion !== 'runtime-terrain-ready-set-1'
      || typeof input.signature !== 'string'
      || !Array.isArray(input.dataCoordinates)
      || !Array.isArray(input.renderCoordinates)) {
      throw new TypeError('valid Runtime Terrain READY set is required');
    }
    const dataKeys = new Set();
    for (const coordinate of input.dataCoordinates) {
      const key = createChunkKey(coordinate.chunkX, coordinate.chunkZ);
      if (key !== coordinate.key || dataKeys.has(key)) throw new Error(`invalid duplicate READY data owner: ${key}`);
      if (!Number.isSafeInteger(coordinate.priorityClass) || coordinate.priorityClass < 0
        || !Number.isFinite(coordinate.arrivalSeconds) || coordinate.arrivalSeconds < 0
        || typeof coordinate.renderRequired !== 'boolean'
        || (coordinate.residentRequired !== undefined
          && typeof coordinate.residentRequired !== 'boolean')) {
        throw new TypeError(`invalid READY owner descriptor: ${key}`);
      }
      dataKeys.add(key);
    }
    const renderKeys = new Set();
    for (const coordinate of input.renderCoordinates) {
      const key = createChunkKey(coordinate.chunkX, coordinate.chunkZ);
      if (key !== coordinate.key || renderKeys.has(key) || !dataKeys.has(key)) {
        throw new Error(`invalid duplicate READY render owner: ${key}`);
      }
      renderKeys.add(key);
    }
    if (dataKeys.size > this.cacheCapacity) {
      throw new Error(`Runtime Terrain READY set exceeds cache capacity: ${dataKeys.size}/${this.cacheCapacity}`);
    }
    const residentKeys = input.residentCoverage?.schemaVersion === 'resident-world-coverage-1'
      ? new Set(input.residentRequiredOwnerKeys ?? [])
      : new Set(dataKeys);
    if (residentKeys.size === 0 || residentKeys.size > this.cacheCapacity
      || [...residentKeys].some(key => !dataKeys.has(key))) {
      throw new Error('Runtime Resident required coverage is invalid or exceeds cache capacity');
    }
    const current = this.terrainReadyPlan;
    if (current?.signature === input.signature && !current.discarded && !current.failed) {
      return current.promise;
    }

    const now = this.clock();
    const previousDataKeys = this.terrainReadyDesiredDataKeys;
    const previousResidentKeys = this.residentRequiredDataKeys;
    const previousPrefetchKeys = new Set(
      [...previousDataKeys].filter(key => !previousResidentKeys.has(key)),
    );
    const nextPrefetchKeys = new Set([...dataKeys].filter(key => !residentKeys.has(key)));
    const previousRenderKeys = this.terrainReadyDesiredRenderKeys;
    const previousPendingKeys = new Set([...previousDataKeys].filter(key => (
      this.#terrainReadyOwnerNeedsWork(key)
    )));
    const unchangedKeys = new Set([...residentKeys].filter(key => previousResidentKeys.has(key)));
    const enteringKeys = new Set([...residentKeys].filter(key => !previousResidentKeys.has(key)));
    const leavingKeys = new Set([...previousResidentKeys].filter(key => !residentKeys.has(key)));
    const prefetchUnchangedKeys = new Set(
      [...nextPrefetchKeys].filter(key => previousPrefetchKeys.has(key)),
    );
    const prefetchEnteringKeys = new Set(
      [...nextPrefetchKeys].filter(key => !previousPrefetchKeys.has(key)),
    );
    const prefetchLeavingKeys = new Set(
      [...previousPrefetchKeys].filter(key => !nextPrefetchKeys.has(key)),
    );
    const epoch = ++this.terrainReadyPlanEpoch;
    this.terrainReadyLastOwnerSetDiff = Object.freeze({
      unchanged: unchangedKeys.size,
      entering: enteringKeys.size,
      leaving: leavingKeys.size,
    });
    this.terrainReadyLastPrefetchSetDiff = Object.freeze({
      unchanged: prefetchUnchangedKeys.size,
      entering: prefetchEnteringKeys.size,
      leaving: prefetchLeavingKeys.size,
    });
    if (enteringKeys.size > 0 || leavingKeys.size > 0 || previousResidentKeys.size === 0) {
      this.chunkDataService.replaceProtectedOwnerKeys?.(residentKeys);
    }
    if (this.terrainReadyStartedAtMs === null) this.terrainReadyStartedAtMs = now;
    this.terrainReadyLastActivityAtMs = now;
    this.counts.terrainReadyPlansRequested += 1;
    if (current && !current.discarded) {
      current.discarded = true;
      const subscriberChanges = this.#supersedeTerrainReadyChunkDataOperations({
        desiredDataKeys: dataKeys,
        residentRequiredKeys: residentKeys,
        nextPlanEpoch: epoch,
      });
      const obsoletePendingCount = [...previousPendingKeys].filter(key => (
        !dataKeys.has(key) || (previousRenderKeys.has(key) && !renderKeys.has(key))
      )).length;
      this.counts.terrainReadyCancelledWork += Math.max(
        subscriberChanges.subscribersLeft,
        obsoletePendingCount,
      );
    }
    this.terrainReadyDesiredDataKeys = dataKeys;
    this.residentRequiredDataKeys = residentKeys;
    this.terrainReadyDesiredRenderKeys = renderKeys;
    this.#updateTerrainPresentationDesiredCenters(input);
    for (const key of [...this.terrainReadyQueuedAtByKey.keys()]) {
      if (!dataKeys.has(key)) this.terrainReadyQueuedAtByKey.delete(key);
    }
    for (const coordinate of input.dataCoordinates) {
      if (!previousDataKeys.has(coordinate.key) && this.#terrainReadyOwnerNeedsWork(coordinate.key)) {
        this.terrainReadyQueuedAtByKey.set(coordinate.key, now);
      }
      if (!previousDataKeys.has(coordinate.key) && !this.#terrainReadyOwnerNeedsWork(coordinate.key)) {
        this.counts.terrainReadyOwnerReuses += 1;
      }
    }
    const workCoordinates = Object.freeze(input.dataCoordinates.filter(coordinate => (
      !previousDataKeys.has(coordinate.key)
        || this.#terrainReadyOwnerNeedsWork(coordinate.key)
    )));
    if (previousResidentKeys.size > 0 && unchangedKeys.size > 0) {
      const residentWorkCount = workCoordinates.filter(
        coordinate => residentKeys.has(coordinate.key),
      ).length;
      if (residentWorkCount >= residentKeys.size) this.counts.residentFullWindowRebuilds += 1;
    }
    const plan = {
      signature: input.signature,
      epoch,
      consumerId: 'runtime-terrain-ready',
      input,
      discarded: false,
      failed: false,
      ready: false,
      terrainDependencyBatch: null,
      promise: null,
      startedAtMs: now,
      workCoordinates,
    };
    this.terrainReadyPlan = plan;
    plan.terrainDependencyBatch = this.#registerTerrainDependencyBatch(plan);
    this.preparationPendingCount += 1;
    const operation = this.preparationChain.then(() => this.#prepareTerrainReadyPlan(plan))
      .catch(error => {
        plan.failed = true;
        throw error;
      })
      .finally(() => { this.preparationPendingCount -= 1; });
    plan.promise = operation;
    this.preparationChain = operation.catch(() => {});
    this.counts.terrainReadyMaximumQueueDepth = Math.max(
      this.counts.terrainReadyMaximumQueueDepth,
      this.#terrainReadyQueueDepth(),
    );
    if (this.onPipelineEvent) this.#recordPipelineEvent('runtime-terrain-ready-set-requested', {
      epoch,
      signature: input.signature,
      visibleCenterChunkX: input.visibleCenterChunkX,
      visibleCenterChunkZ: input.visibleCenterChunkZ,
      corridorEndpointOwnerKey: input.corridorEndpointOwnerKey,
      corridorCenterCount: input.corridorCenters?.length ?? null,
      dataOwnerCount: dataKeys.size,
      residentOwnerCount: residentKeys.size,
      residentEnteringOwnerCount: enteringKeys.size,
      residentLeavingOwnerCount: leavingKeys.size,
      prefetchOwnerCount: nextPrefetchKeys.size,
      renderOwnerCount: renderKeys.size,
      queueDepth: this.#terrainReadyQueueDepth(),
    });
    return operation;
  }

  #terrainPresentationRevision() {
    const revision = this.terrainPresentationAdapter?.revision?.() ?? 'default';
    if (typeof revision !== 'string' || !revision) {
      throw new TypeError('Terrain presentation revision must be a non-empty string');
    }
    return revision;
  }

  #terrainPresentationIdentity(centerKey, revision = this.#terrainPresentationRevision()) {
    return `${centerKey}|${revision}`;
  }

  #createTerrainPresentationEntry({
    chunkX,
    chunkZ,
    revision,
    priorityIndex = 0,
    arrivalSeconds = 0,
    dataCoordinates = null,
    renderCoordinates = null,
    required = false,
  }) {
    const centerKey = createChunkKey(chunkX, chunkZ);
    const identity = this.#terrainPresentationIdentity(centerKey, revision);
    const now = this.clock();
    const entry = {
      identity,
      centerKey,
      chunkX,
      chunkZ,
      revision,
      priorityIndex,
      arrivalSeconds,
      dataCoordinates: dataCoordinates ?? squareChunkCoordinates(chunkX, chunkZ, 2),
      renderCoordinates: renderCoordinates ?? squareChunkCoordinates(chunkX, chunkZ, 1),
      state: 'waiting',
      promise: null,
      presentationGeneration: null,
      requestAtMs: now,
      pendingEnteredAtMs: null,
      pendingPromotedAtMs: null,
      inFlightStartedAtMs: null,
      startedAtMs: null,
      nearReadyAtMs: null,
      outerReadyAtMs: null,
      clipmapReadyAtMs: null,
      presentationReadyAtMs: null,
      completedAtMs: null,
      claimAtMs: null,
      claimedAtMs: null,
      attachAtMs: null,
      oldReleaseAtMs: null,
      requiredAtMs: required ? now : null,
      arrivalAtMs: required ? now : null,
      geometryCount: 0,
      uploadBytes: 0,
      maximumSliceMs: 0,
      reuseRatio: null,
      jumpDistanceChunks: null,
      lastUsedAtMs: now,
      cancellationRecorded: false,
      schedulerIdleStartedAtMs: null,
      schedulerIdleEndedAtMs: null,
      discardedAtMs: null,
      discardReason: null,
    };
    this.terrainPresentationEntries.set(identity, entry);
    this.counts.terrainPresentationGenerationsRequested += 1;
    return entry;
  }

  #terrainPresentationEntryForCenterKey(centerKey) {
    if (centerKey === null) return null;
    return [...this.terrainPresentationEntries.values()].find(entry => (
      entry.centerKey === centerKey && entry.state !== 'discarded'
    )) ?? null;
  }

  #setTerrainPresentationPending(entry) {
    const nextIdentity = entry
      && entry.state === 'waiting'
      && entry.identity !== this.terrainPresentationInFlightIdentity
      ? entry.identity : null;
    const previousIdentity = this.terrainPresentationPendingIdentity;
    if (previousIdentity === nextIdentity) return;
    this.terrainPresentationPendingIdentity = nextIdentity;
    if (nextIdentity !== null) {
      const next = this.terrainPresentationEntries.get(nextIdentity);
      if (next && next.pendingEnteredAtMs === null) next.pendingEnteredAtMs = this.clock();
    }
    if (previousIdentity !== null) {
      const previous = this.terrainPresentationEntries.get(previousIdentity);
      if (previous && previous.centerKey !== this.terrainPresentationClaimTargetKey
        && previous.identity !== this.terrainPresentationInFlightIdentity
        && previous.state === 'waiting') {
        this.#discardTerrainPresentationEntry(previous, { reason: 'pending-coalesced' });
        this.counts.terrainPresentationGenerationsCoalesced += 1;
      }
    }
  }

  #updateTerrainPresentationMaximumPendingWait(entry, now = this.clock()) {
    if (!entry || entry.pendingEnteredAtMs === null) return;
    this.counts.terrainPresentationMaximumPendingWaitMs = Math.max(
      this.counts.terrainPresentationMaximumPendingWaitMs,
      Math.max(0, now - entry.pendingEnteredAtMs),
    );
  }

  #closeTerrainPresentationSchedulerIdlePendingEntry(now) {
    if (this.terrainPresentationSchedulerIdlePendingIdentity === null) return;
    const entry = this.terrainPresentationEntries.get(
      this.terrainPresentationSchedulerIdlePendingIdentity,
    );
    if (entry && entry.schedulerIdleEndedAtMs === null) entry.schedulerIdleEndedAtMs = now;
    this.terrainPresentationSchedulerIdlePendingIdentity = null;
  }

  #updateTerrainPresentationSchedulerIdleState(now = this.clock()) {
    const noInFlight = this.terrainPresentationInFlightIdentity === null;
    const pendingEntry = this.terrainPresentationPendingIdentity === null
      ? null : this.terrainPresentationEntries.get(this.terrainPresentationPendingIdentity) ?? null;
    const hasPending = noInFlight && pendingEntry?.state === 'waiting'
      && this.#terrainPresentationDependenciesReady(pendingEntry);
    const hasEligibleWork = noInFlight && [...this.terrainPresentationEntries.values()]
      .some(entry => entry.state === 'waiting'
        && this.#terrainPresentationDependenciesReady(entry));

    if (hasEligibleWork) {
      if (this.terrainPresentationSchedulerIdleStartedAtMs === null) {
        this.terrainPresentationSchedulerIdleStartedAtMs = now;
        this.counts.terrainSchedulerIdleCount += 1;
      }
    } else if (this.terrainPresentationSchedulerIdleStartedAtMs !== null) {
      this.counts.terrainSchedulerIdleMs += Math.max(
        0,
        now - this.terrainPresentationSchedulerIdleStartedAtMs,
      );
      this.terrainPresentationSchedulerIdleStartedAtMs = null;
    }

    if (hasPending) {
      this.#updateTerrainPresentationMaximumPendingWait(pendingEntry, now);
      if (this.terrainPresentationSchedulerIdleWithPendingStartedAtMs === null) {
        this.terrainPresentationSchedulerIdleWithPendingStartedAtMs = now;
        this.counts.terrainSchedulerIdleWithPendingCount += 1;
      }
      if (this.terrainPresentationSchedulerIdlePendingIdentity !== pendingEntry.identity) {
        this.#closeTerrainPresentationSchedulerIdlePendingEntry(now);
        this.terrainPresentationSchedulerIdlePendingIdentity = pendingEntry.identity;
        if (pendingEntry.schedulerIdleStartedAtMs === null) {
          pendingEntry.schedulerIdleStartedAtMs = now;
        }
      }
    } else {
      if (this.terrainPresentationSchedulerIdleWithPendingStartedAtMs !== null) {
        this.counts.terrainSchedulerIdleWithPendingMs += Math.max(
          0,
          now - this.terrainPresentationSchedulerIdleWithPendingStartedAtMs,
        );
        this.terrainPresentationSchedulerIdleWithPendingStartedAtMs = null;
      }
      this.#closeTerrainPresentationSchedulerIdlePendingEntry(now);
    }
  }

  #terrainPresentationSchedulerIdleSnapshot(now = this.clock()) {
    this.#updateTerrainPresentationSchedulerIdleState(now);
    const pendingEntry = this.terrainPresentationPendingIdentity === null
      ? null : this.terrainPresentationEntries.get(this.terrainPresentationPendingIdentity) ?? null;
    this.#updateTerrainPresentationMaximumPendingWait(pendingEntry, now);
    return Object.freeze({
      terrainSchedulerIdleCount: this.counts.terrainSchedulerIdleCount,
      terrainSchedulerIdleMs: this.counts.terrainSchedulerIdleMs
        + (this.terrainPresentationSchedulerIdleStartedAtMs === null ? 0
          : Math.max(0, now - this.terrainPresentationSchedulerIdleStartedAtMs)),
      terrainSchedulerIdleWithPendingCount:
        this.counts.terrainSchedulerIdleWithPendingCount,
      terrainSchedulerIdleWithPendingMs: this.counts.terrainSchedulerIdleWithPendingMs
        + (this.terrainPresentationSchedulerIdleWithPendingStartedAtMs === null ? 0
          : Math.max(0, now - this.terrainPresentationSchedulerIdleWithPendingStartedAtMs)),
      maxPendingWaitMs: this.counts.terrainPresentationMaximumPendingWaitMs,
    });
  }

  #recordTerrainPresentationLifecycle(entry, outcome) {
    this.terrainPresentationLifecycleHistory.push(Object.freeze({
      identity: entry.identity,
      centerKey: entry.centerKey,
      outcome,
      requestAtMs: entry.requestAtMs,
      pendingEnteredAtMs: entry.pendingEnteredAtMs,
      pendingPromotedAtMs: entry.pendingPromotedAtMs,
      inFlightStartedAtMs: entry.inFlightStartedAtMs,
      startedAtMs: entry.startedAtMs,
      completedAtMs: entry.completedAtMs,
      claimAtMs: entry.claimAtMs,
      claimedAtMs: entry.claimedAtMs,
      attachAtMs: entry.attachAtMs,
      schedulerIdleStartedAtMs: entry.schedulerIdleStartedAtMs,
      schedulerIdleEndedAtMs: entry.schedulerIdleEndedAtMs,
      discardedAtMs: entry.discardedAtMs,
      discardReason: entry.discardReason,
    }));
    if (this.terrainPresentationLifecycleHistory.length > 32) {
      this.terrainPresentationLifecycleHistory.shift();
    }
  }

  #updateTerrainPresentationDesiredCenters(input) {
    if (!this.terrainPresentationAdapter) return;
    const revision = this.#terrainPresentationRevision();
    const currentKey = this.centerChunkX === null
      ? null : createChunkKey(this.centerChunkX, this.centerChunkZ);
    const visibleChunkX = assertLogicalChunkCoordinate(
      input.visibleCenterChunkX,
      'terrainPresentationVisibleCenterChunkX',
    );
    const visibleChunkZ = assertLogicalChunkCoordinate(
      input.visibleCenterChunkZ,
      'terrainPresentationVisibleCenterChunkZ',
    );
    const visibleKey = createChunkKey(visibleChunkX, visibleChunkZ);
    this.terrainPresentationPlayerCenter = Object.freeze({
      chunkX: visibleChunkX,
      chunkZ: visibleChunkZ,
      key: visibleKey,
    });
    const centers = input.corridorCenters ?? [];
    const target = visibleKey !== currentKey
      ? { chunkX: visibleChunkX, chunkZ: visibleChunkZ, key: visibleKey,
        arrivalSeconds: 0 }
      : centers.find(center => createChunkKey(center.chunkX, center.chunkZ) !== currentKey)
        ?? null;
    const desired = new Set();
    let targetEntry = null;
    if (target) {
      const targetKey = createChunkKey(target.chunkX, target.chunkZ);
      const identity = this.#terrainPresentationIdentity(targetKey, revision);
      desired.add(identity);
      targetEntry = this.terrainPresentationEntries.get(identity);
      if (targetEntry?.state === 'failed' || targetEntry?.state === 'discarded') {
        this.#discardTerrainPresentationEntry(targetEntry, {
          force: true,
          reason: 'retry-replaced',
        });
        targetEntry = null;
      }
      if (!targetEntry) {
        targetEntry = this.#createTerrainPresentationEntry({
          chunkX: target.chunkX,
          chunkZ: target.chunkZ,
          revision,
          arrivalSeconds: target.arrivalSeconds ?? 0,
        });
      } else {
        targetEntry.priorityIndex = 0;
        targetEntry.arrivalSeconds = target.arrivalSeconds ?? 0;
        targetEntry.lastUsedAtMs = this.clock();
      }
    }
    this.terrainPresentationDesiredIdentities = desired;
    this.#setTerrainPresentationPending(targetEntry);
    for (const entry of [...this.terrainPresentationEntries.values()]) {
      if (desired.has(entry.identity)
        || entry.identity === this.terrainPresentationInFlightIdentity
        || entry.identity === this.terrainPresentationPendingIdentity
        || entry.centerKey === this.terrainPresentationClaimTargetKey) continue;
      this.#discardTerrainPresentationEntry(entry, { reason: 'desired-center-superseded' });
    }
    this.#pruneTerrainPresentationEntries();
    this.#scheduleEligibleTerrainPresentationGenerations();
  }

  #terrainPresentationDependenciesReady(entry) {
    return entry.dataCoordinates.every(coordinate => this.cache.has(coordinate.key))
      && entry.renderCoordinates.every(coordinate => this.#isTerrainRenderReady(coordinate.key));
  }

  #scheduleEligibleTerrainPresentationGenerations() {
    if (!this.terrainPresentationAdapter || this.isShutdown) return;
    if (this.terrainPresentationInFlightIdentity !== null) {
      this.#updateTerrainPresentationSchedulerIdleState();
      return;
    }
    const claimEntry = this.#terrainPresentationEntryForCenterKey(
      this.terrainPresentationClaimTargetKey,
    );
    const pendingEntry = this.terrainPresentationPendingIdentity === null
      ? null : this.terrainPresentationEntries.get(this.terrainPresentationPendingIdentity);
    const desiredEntry = [...this.terrainPresentationEntries.values()]
      .filter(entry => entry.state === 'waiting'
        && this.terrainPresentationDesiredIdentities.has(entry.identity))
      .sort((left, right) => left.priorityIndex - right.priorityIndex
        || left.arrivalSeconds - right.arrivalSeconds
        || left.identity.localeCompare(right.identity))[0] ?? null;
    const entry = [claimEntry, pendingEntry, desiredEntry].find(candidate => (
      candidate?.state === 'waiting' && this.#terrainPresentationDependenciesReady(candidate)
    ));
    if (entry) {
      this.#scheduleTerrainPresentationGeneration(entry);
      return;
    }
    this.#updateTerrainPresentationSchedulerIdleState();
  }

  #scheduleTerrainPresentationGeneration(entry) {
    if (entry.state !== 'waiting') return entry.promise;
    if (this.terrainPresentationInFlightIdentity !== null) {
      if (entry.centerKey !== this.terrainPresentationClaimTargetKey) {
        this.#setTerrainPresentationPending(entry);
      }
      return null;
    }
    const promotedAtMs = this.clock();
    if (this.terrainPresentationPendingIdentity === entry.identity) {
      entry.pendingPromotedAtMs = promotedAtMs;
      this.#updateTerrainPresentationMaximumPendingWait(entry, promotedAtMs);
    }
    this.terrainPresentationInFlightIdentity = entry.identity;
    entry.inFlightStartedAtMs = promotedAtMs;
    entry.state = 'queued';
    if (this.terrainPresentationPendingIdentity === entry.identity) {
      this.terrainPresentationPendingIdentity = null;
    }
    this.#updateTerrainPresentationSchedulerIdleState(promotedAtMs);
    entry.nearReadyAtMs = promotedAtMs;
    const generationEpoch = ++this.terrainPresentationGenerationEpoch;
    const operation = this.terrainPresentationPreparationChain.then(async () => {
      if (!this.#isTerrainPresentationEntryCurrent(entry)) {
        this.#discardTerrainPresentationEntry(entry, {
          cancelled: true,
          force: true,
          reason: 'stale-before-build',
        });
        return null;
      }
      entry.state = 'building';
      entry.startedAtMs = this.clock();
      this.counts.terrainPresentationGenerationsStarted += 1;
      const result = await this.terrainPresentationAdapter.prepare({
        identity: entry.identity,
        generationEpoch,
        centerChunkX: entry.chunkX,
        centerChunkZ: entry.chunkZ,
        activeDataKeys: Object.freeze(entry.dataCoordinates.map(value => value.key)),
        renderedKeys: Object.freeze(entry.renderCoordinates.map(value => value.key)),
        getChunkData: (chunkX, chunkZ) => this.getChunkData(chunkX, chunkZ),
        renderOrigin: this.#targetRenderOrigin(entry.chunkX, entry.chunkZ),
        isCurrent: () => this.#isTerrainPresentationEntryCurrent(entry),
        isUrgent: () => {
          if (!this.#isTerrainPresentationEntryCurrent(entry)) return false;
          const committedCenterKey = this.centerChunkX === null
            ? null : createChunkKey(this.centerChunkX, this.centerChunkZ);
          return entry.requiredAtMs !== null
            || this.terrainPresentationClaimTargetKey === entry.centerKey
            || (this.terrainPresentationPlayerCenter !== null
              && this.terrainPresentationPlayerCenter.key !== committedCenterKey);
        },
      });
      if (!result?.presentationGeneration) {
        if (this.#isTerrainPresentationEntryCurrent(entry)) {
          throw new Error(`Terrain presentation generation was not prepared: ${entry.identity}`);
        }
        return null;
      }
      if (!this.#isTerrainPresentationEntryCurrent(entry)) {
        this.terrainPresentationAdapter.discard(result.presentationGeneration);
        this.#discardTerrainPresentationEntry(entry, {
          cancelled: true,
          force: true,
          reason: 'stale-after-build',
        });
        return null;
      }
      entry.presentationGeneration = result.presentationGeneration;
      entry.state = 'ready';
      entry.outerReadyAtMs = result.outerReadyAtMs
        ?? result.presentationGeneration.outerReadyAtMs
        ?? result.preparedAtMs
        ?? result.presentationGeneration.preparedAtMs
        ?? this.clock();
      entry.clipmapReadyAtMs = result.clipmapReadyAtMs
        ?? result.presentationGeneration.clipmapReadyAtMs
        ?? result.preparedAtMs
        ?? result.presentationGeneration.preparedAtMs
        ?? this.clock();
      entry.presentationReadyAtMs = result.presentationReadyAtMs
        ?? result.presentationGeneration.presentationReadyAtMs
        ?? result.preparedAtMs
        ?? result.presentationGeneration.preparedAtMs
        ?? this.clock();
      entry.geometryCount = result.geometryCount
        ?? result.presentationGeneration.geometryCount ?? 0;
      entry.uploadBytes = result.uploadBytes
        ?? result.presentationGeneration.uploadBytes ?? 0;
      entry.maximumSliceMs = result.maximumSliceMs
        ?? result.presentationGeneration.maximumSliceMs ?? 0;
      entry.reuseRatio = result.clipmapMetrics?.reuseRatio
        ?? result.presentationGeneration.clipmapMetrics?.reuseRatio
        ?? null;
      if (this.terrainPresentationLastCompletedCenter !== null) {
        entry.jumpDistanceChunks = Math.max(
          Math.abs(entry.chunkX - this.terrainPresentationLastCompletedCenter.chunkX),
          Math.abs(entry.chunkZ - this.terrainPresentationLastCompletedCenter.chunkZ),
        );
        const jumpBand = entry.jumpDistanceChunks <= 1 ? '1'
          : entry.jumpDistanceChunks === 2 ? '2'
            : entry.jumpDistanceChunks <= 5 ? '3-5' : '6+';
        this.terrainPresentationJumpHistogram.set(
          jumpBand,
          (this.terrainPresentationJumpHistogram.get(jumpBand) ?? 0) + 1,
        );
        if (Number.isFinite(entry.reuseRatio)) {
          const reuse = this.terrainPresentationReuseByJump.get(jumpBand)
            ?? { sum: 0, count: 0 };
          reuse.sum += entry.reuseRatio;
          reuse.count += 1;
          this.terrainPresentationReuseByJump.set(jumpBand, reuse);
        }
      }
      this.terrainPresentationLastCompletedCenter = Object.freeze({
        chunkX: entry.chunkX,
        chunkZ: entry.chunkZ,
      });
      entry.completedAtMs = this.clock();
      this.counts.terrainPresentationGenerationsCompleted += 1;
      this.counts.terrainPresentationGenerationsReady += 1;
      if (Number.isFinite(entry.reuseRatio)) {
        this.terrainPresentationReuseRatioSum += entry.reuseRatio;
        this.terrainPresentationReuseRatioSampleCount += 1;
        this.counts.terrainPresentationReuseRatio = this.terrainPresentationReuseRatioSum
          / this.terrainPresentationReuseRatioSampleCount;
      }
      this.counts.terrainPresentationMaximumGeometryCount = Math.max(
        this.counts.terrainPresentationMaximumGeometryCount,
        entry.geometryCount,
      );
      this.counts.terrainPresentationMaximumUploadBytes = Math.max(
        this.counts.terrainPresentationMaximumUploadBytes,
        entry.uploadBytes,
      );
      this.counts.terrainPresentationMaximumSliceMs = Math.max(
        this.counts.terrainPresentationMaximumSliceMs,
        entry.maximumSliceMs,
      );
      this.#updateTerrainPresentationMaximumStagedCount();
      if (this.onPipelineEvent) this.#recordPipelineEvent(
        'runtime-terrain-presentation-generation-ready',
        {
          ownerKey: entry.centerKey,
          identity: entry.identity,
          generationEpoch,
          geometryCount: entry.geometryCount,
          uploadBytes: entry.uploadBytes,
          maximumSliceMs: entry.maximumSliceMs,
          durationMs: Math.max(0, entry.presentationReadyAtMs - entry.requestAtMs),
        },
      );
      return entry;
    }).catch(error => {
      if (this.#isTerrainPresentationEntryCurrent(entry)) entry.state = 'failed';
      throw error;
    }).finally(() => {
      if (this.terrainPresentationInFlightIdentity === entry.identity) {
        this.terrainPresentationInFlightIdentity = null;
      }
      if (entry.state === 'ready'
        && !this.terrainPresentationDesiredIdentities.has(entry.identity)
        && entry.centerKey !== this.terrainPresentationClaimTargetKey) {
        this.#discardTerrainPresentationEntry(entry, {
          reason: 'completed-obsolete-before-claim',
        });
      }
      this.#scheduleEligibleTerrainPresentationGenerations();
    });
    entry.promise = operation;
    this.terrainPresentationPreparationChain = operation.catch(() => {});
    return operation;
  }

  #isTerrainPresentationEntryCurrent(entry) {
    if (this.isShutdown || this.terrainPresentationEntries.get(entry.identity) !== entry) {
      return false;
    }
    return entry.revision === this.#terrainPresentationRevision();
  }

  #recordTerrainPresentationCancellation(entry) {
    if (entry.cancellationRecorded) return;
    entry.cancellationRecorded = true;
    this.counts.terrainPresentationGenerationsCancelled += 1;
  }

  #updateTerrainPresentationMaximumStagedCount() {
    const stagedCount = [...this.terrainPresentationEntries.values()]
      .filter(entry => entry.state === 'ready').length;
    this.counts.terrainPresentationMaximumStagedCount = Math.max(
      this.counts.terrainPresentationMaximumStagedCount,
      stagedCount,
    );
  }

  #pruneTerrainPresentationEntries() {
    const entries = [...this.terrainPresentationEntries.values()];
    if (entries.length <= TERRAIN_PRESENTATION_STAGED_CENTER_LIMIT) return;
    const removable = entries
      .filter(entry => !this.terrainPresentationDesiredIdentities.has(entry.identity)
        && entry.identity !== this.terrainPresentationInFlightIdentity
        && entry.identity !== this.terrainPresentationPendingIdentity
        && entry.centerKey !== this.terrainPresentationClaimTargetKey)
      .sort((left, right) => left.lastUsedAtMs - right.lastUsedAtMs
        || left.identity.localeCompare(right.identity));
    while (this.terrainPresentationEntries.size > TERRAIN_PRESENTATION_STAGED_CENTER_LIMIT
      && removable.length) {
      this.#discardTerrainPresentationEntry(removable.shift(), {
        reason: 'staged-limit-pruned',
      });
    }
  }

  #discardTerrainPresentationEntry(entry, {
    cancelled = false,
    force = false,
    reason = 'obsolete',
  } = {}) {
    if (!entry || this.terrainPresentationEntries.get(entry.identity) !== entry) return false;
    if (!force && (entry.identity === this.terrainPresentationInFlightIdentity
      || entry.centerKey === this.terrainPresentationClaimTargetKey)) return false;
    this.terrainPresentationEntries.delete(entry.identity);
    if (this.terrainPresentationPendingIdentity === entry.identity) {
      this.terrainPresentationPendingIdentity = null;
    }
    const wasCompletedUnclaimed = entry.presentationGeneration && entry.claimedAtMs === null;
    if (entry.presentationGeneration) {
      this.terrainPresentationAdapter?.discard(entry.presentationGeneration);
      this.counts.terrainPresentationGenerationsDiscarded += 1;
      if (wasCompletedUnclaimed) {
        this.counts.terrainPresentationCompletedUnclaimedDiscards += 1;
      }
    } else if (cancelled) this.#recordTerrainPresentationCancellation(entry);
    const discardedAtMs = this.clock();
    entry.state = 'discarded';
    entry.discardedAtMs = discardedAtMs;
    entry.discardReason = reason;
    if (entry.schedulerIdleEndedAtMs === null && entry.schedulerIdleStartedAtMs !== null) {
      entry.schedulerIdleEndedAtMs = discardedAtMs;
    }
    this.#recordTerrainPresentationLifecycle(entry, 'discarded');
    return true;
  }

  recordTerrainCoverageGateBlocked(chunkXInput, chunkZInput) {
    const chunkX = assertLogicalChunkCoordinate(chunkXInput, 'terrainGateChunkX');
    const chunkZ = assertLogicalChunkCoordinate(chunkZInput, 'terrainGateChunkZ');
    const key = createChunkKey(chunkX, chunkZ);
    this.counts.terrainReadyGateBlockedFrames += 1;
    if (this.terrainReadyCoverageMissOwnerKey !== key) {
      this.terrainReadyCoverageMissOwnerKey = key;
      this.counts.terrainReadyCoverageMisses += 1;
      if (this.residentRequiredDataKeys.has(key)) this.counts.residentCoverageMisses += 1;
    }
    if (this.onPipelineEvent) this.#recordPipelineEvent('runtime-terrain-ready-coverage-miss', {
      ownerKey: key,
      chunkX,
      chunkZ,
      queueDepth: this.#terrainReadyQueueDepth(),
    });
  }

  recordTerrainCoverageGateRestored() {
    this.terrainReadyCoverageMissOwnerKey = null;
  }

  #terrainReadyRequestPriority(coordinate, plan, { terrainDependency = false } = {}) {
    if (terrainDependency) {
      const playerOwnerKey = createChunkKey(
        plan.input.visibleCenterChunkX,
        plan.input.visibleCenterChunkZ,
      );
      if (coordinate.key === playerOwnerKey) return CHUNK_DATA_PRIORITY.PLAYER_DATA;
      if (this.#isLatestTerrainRenderDependency(coordinate, plan)) {
        return CHUNK_DATA_PRIORITY.PLAYER_RENDER;
      }
      return CHUNK_DATA_PRIORITY.GAMEPLAY_REQUIRED;
    }
    if (coordinate.priorityClass === 2) return CHUNK_DATA_PRIORITY.DISTANT_OWNER;
    if (coordinate.priorityClass >= 3) return CHUNK_DATA_PRIORITY.ULTRA_WARM;
    return coordinate.priorityClass <= 1
      ? CHUNK_DATA_PRIORITY.PLAYER_DATA : CHUNK_DATA_PRIORITY.PLAYER_RENDER;
  }

  #isLatestTerrainRenderDependency(coordinate, plan) {
    return Math.abs(coordinate.chunkX - plan.input.visibleCenterChunkX) <= 1
      && Math.abs(coordinate.chunkZ - plan.input.visibleCenterChunkZ) <= 1;
  }

  #recordTerrainReadyOwnerRequest(coordinate, { plan, priority, requiresRender }) {
    this.counts.terrainReadyOwnersRequested += 1;
    if (this.onPipelineEvent) this.#recordPipelineEvent('runtime-terrain-ready-owner-requested', {
      ownerKey: coordinate.key,
      chunkX: coordinate.chunkX,
      chunkZ: coordinate.chunkZ,
      epoch: plan.epoch,
      priority,
      priorityClass: coordinate.priorityClass,
      arrivalSeconds: coordinate.arrivalSeconds,
      renderRequired: requiresRender,
    });
  }

  #recordTerrainDependencyWaitSample(batch, value) {
    if (!Number.isFinite(value) || value < 0) return;
    batch.waitSamples.push(value);
    if (batch !== this.terrainDependencyLatestBatch) return;
    this.terrainDependencyWaitSamples.push(value);
    if (this.terrainDependencyWaitSamples.length > TERRAIN_DEPENDENCY_WAIT_SAMPLE_LIMIT) {
      this.terrainDependencyWaitSamples.shift();
    }
  }

  #registerTerrainDependencyBatch(plan) {
    const coordinates = plan.input.dataCoordinates.filter(coordinate => (
      coordinate.visibleRequired === true
    ));
    if (coordinates.length !== 25) {
      throw new Error(`latest Terrain dependency batch must contain 25 owners, got ${coordinates.length}`);
    }
    const renderOwnerCount = coordinates.filter(coordinate => (
      this.#isLatestTerrainRenderDependency(coordinate, plan)
    )).length;
    if (renderOwnerCount !== 9) {
      throw new Error(`latest Terrain dependency render set must contain 9 owners, got ${renderOwnerCount}`);
    }
    const registrationStartedAtMs = this.clock();
    const batch = {
      planEpoch: plan.epoch,
      targetCenterKey: createChunkKey(
        plan.input.visibleCenterChunkX,
        plan.input.visibleCenterChunkZ,
      ),
      targetRequestedAtMs: plan.startedAtMs,
      ownerCount: coordinates.length,
      renderOwnerCount,
      cacheHitCount: 0,
      registeredCount: 0,
      newRequestCount: 0,
      reusedRequestCount: 0,
      completedCount: 0,
      cancelledCount: 0,
      firstRegisteredAtMs: null,
      allRegisteredAtMs: null,
      allResolvedAtMs: null,
      registrationDurationMs: 0,
      waitMs: null,
      lastOwnerWaitMs: 0,
      waitSamples: [],
      promise: null,
    };
    this.terrainDependencyLatestBatch = batch;
    const completions = coordinates.map(coordinate => {
      const cached = this.cache.get(coordinate.key)?.data ?? null;
      if (cached) {
        batch.cacheHitCount += 1;
        batch.completedCount += 1;
        this.counts.terrainDependencyCacheHits += 1;
        return Promise.resolve(Object.freeze({ coordinate, result: Object.freeze({
          data: cached,
          generated: false,
        }) }));
      }
      const registeredAtMs = this.clock();
      if (batch.firstRegisteredAtMs === null) batch.firstRegisteredAtMs = registeredAtMs;
      batch.registeredCount += 1;
      const reusedPending = this.terrainReadyChunkDataOperations.has(coordinate.key);
      if (reusedPending) {
        batch.reusedRequestCount += 1;
      } else {
        batch.newRequestCount += 1;
        this.#recordTerrainReadyOwnerRequest(coordinate, {
          plan,
          priority: this.#terrainReadyRequestPriority(coordinate, plan, {
            terrainDependency: true,
          }),
          requiresRender: this.#isLatestTerrainRenderDependency(coordinate, plan),
        });
      }
      return this.#ensureTerrainReadyChunkData(coordinate, {
        priority: this.#terrainReadyRequestPriority(coordinate, plan, {
          terrainDependency: true,
        }),
        plan,
        deadlineAtMs: plan.startedAtMs,
        required: true,
        intentionalPendingReuse: true,
      }).then(result => {
        const waitMs = Math.max(0, this.clock() - registeredAtMs);
        if (result?.cancelled) {
          batch.cancelledCount += 1;
        } else {
          batch.completedCount += 1;
          this.counts.terrainDependencyOwnersCompleted += 1;
          batch.lastOwnerWaitMs = Math.max(batch.lastOwnerWaitMs, waitMs);
          this.#recordTerrainDependencyWaitSample(batch, waitMs);
        }
        return Object.freeze({ coordinate, result });
      });
    });
    batch.allRegisteredAtMs = this.clock();
    batch.registrationDurationMs = Math.max(0, batch.allRegisteredAtMs - registrationStartedAtMs);
    this.counts.terrainDependencyBatchesRegistered += 1;
    this.counts.terrainDependencyOwnersRegistered += batch.registeredCount;
    this.counts.terrainDependencyMaximumRegistrationMs = Math.max(
      this.counts.terrainDependencyMaximumRegistrationMs,
      batch.registrationDurationMs,
    );
    batch.promise = Promise.all(completions).then(results => {
      batch.allResolvedAtMs = this.clock();
      batch.waitMs = Math.max(0, batch.allResolvedAtMs - batch.targetRequestedAtMs);
      if (batch === this.terrainDependencyLatestBatch && batch.cancelledCount === 0) {
        this.counts.terrainDependencyBatchesCompleted += 1;
      }
      return Object.freeze({ results: Object.freeze(results), cancelled: batch.cancelledCount > 0 });
    }, error => Object.freeze({ error }));
    if (this.onPipelineEvent) this.#recordPipelineEvent(
      'runtime-terrain-dependency-batch-registered',
      {
        epoch: plan.epoch,
        targetCenterKey: batch.targetCenterKey,
        ownerCount: batch.ownerCount,
        cacheHitCount: batch.cacheHitCount,
        registeredCount: batch.registeredCount,
        newRequestCount: batch.newRequestCount,
        reusedRequestCount: batch.reusedRequestCount,
        registrationDurationMs: batch.registrationDurationMs,
      },
    );
    return batch;
  }

  async #prepareTerrainReadyPlan(plan) {
    await this.#discardObsoleteTerrainReadyProjections();
    const dependencyOutcome = await plan.terrainDependencyBatch.promise;
    if (dependencyOutcome.error) throw dependencyOutcome.error;
    if (plan.discarded || dependencyOutcome.cancelled) return null;
    for (const coordinate of plan.workCoordinates) {
      if (coordinate.visibleRequired === true && !this.cache.has(coordinate.key)) {
        throw new Error(`latest Terrain dependency is unresolved: ${coordinate.key}`);
      }
    }
    for (const coordinate of plan.workCoordinates) {
      if (plan.discarded) return null;
      const requiresRender = this.terrainReadyDesiredRenderKeys.has(coordinate.key);
      let result = Object.freeze({ data: this.cache.get(coordinate.key)?.data ?? null, generated: false });
      if (!result.data) {
        const priority = this.#terrainReadyRequestPriority(coordinate, plan);
        this.#recordTerrainReadyOwnerRequest(coordinate, {
          plan,
          priority,
          requiresRender,
        });
        result = await this.#ensureTerrainReadyChunkData(coordinate, {
          priority,
          plan,
          deadlineAtMs: plan.startedAtMs + coordinate.arrivalSeconds * 1000,
          required: coordinate.residentRequired === true,
        });
        if (result.generated) {
          this.counts.terrainReadyOwnersGenerated += 1;
          await this.yieldToHost();
        }
      }
      if (result.cancelled) return null;
      if (plan.discarded && !this.terrainReadyDesiredDataKeys.has(coordinate.key)) {
        this.counts.terrainReadyStaleCompletions += 1;
        return null;
      }
      if (!requiresRender) {
        this.#completeTerrainReadyQueueOwner(coordinate.key);
        this.#scheduleEligibleTerrainPresentationGenerations();
        continue;
      }
      if (this.#isTerrainRenderReady(coordinate.key)) {
        this.terrainReadyReadyKeys.add(coordinate.key);
        this.#completeTerrainReadyQueueOwner(coordinate.key);
        this.#scheduleEligibleTerrainPresentationGenerations();
        continue;
      }
      const entry = this.cache.get(coordinate.key);
      if (!entry?.data) throw new Error(`READY ChunkData is undefined: ${coordinate.key}`);
      const projectionStartedAt = this.clock();
      const projected = await this.renderAdapter.projectChunk(entry.data, this.renderOrigin, {
        deferredRegistration: true,
      });
      this.performance.record('projection', this.clock() - projectionStartedAt);
      this.counts.preparedProjections += 1;
      this.counts.terrainReadyOwnersProjected += 1;
      if (!this.terrainReadyDesiredRenderKeys.has(coordinate.key)) {
        await this.renderAdapter.discardProjected?.(projected);
        this.counts.terrainReadyStaleCompletions += 1;
        return null;
      }
      this.terrainReadyProjectedByKey.set(coordinate.key, projected);
      this.terrainReadyReadyKeys.add(coordinate.key);
      this.#completeTerrainReadyQueueOwner(coordinate.key);
      this.counts.terrainReadyOwnersReady += 1;
      this.terrainReadyLastActivityAtMs = this.clock();
      if (this.onPipelineEvent) this.#recordPipelineEvent('runtime-terrain-ready-owner-ready', {
        ownerKey: coordinate.key,
        chunkX: coordinate.chunkX,
        chunkZ: coordinate.chunkZ,
        epoch: plan.epoch,
        arrivalSeconds: coordinate.arrivalSeconds,
        queueDepth: this.#terrainReadyQueueDepth(),
      });
      this.#scheduleEligibleTerrainPresentationGenerations();
      await this.yieldToHost();
    }
    if (plan.discarded) return null;
    plan.ready = true;
    this.#scheduleEligibleTerrainPresentationGenerations();
    this.counts.terrainReadyPlansCompleted += 1;
    this.terrainReadyLastActivityAtMs = this.clock();
    this.counts.terrainReadyMaximumQueueDepth = Math.max(
      this.counts.terrainReadyMaximumQueueDepth,
      this.#terrainReadyQueueDepth(),
    );
    if (this.onPipelineEvent) this.#recordPipelineEvent('runtime-terrain-ready-set-complete', {
      epoch: plan.epoch,
      durationMs: Math.max(0, this.clock() - plan.startedAtMs),
      readyRenderOwnerCount: plan.input.renderCoordinates.filter(coordinate => (
        this.#isTerrainRenderReady(coordinate.key)
      )).length,
      desiredRenderOwnerCount: this.terrainReadyDesiredRenderKeys.size,
      queueDepth: this.#terrainReadyQueueDepth(),
    });
    return plan;
  }

  async #discardObsoleteTerrainReadyProjections() {
    for (const [key, projected] of [...this.terrainReadyProjectedByKey]) {
      if (this.terrainReadyDesiredRenderKeys.has(key)) continue;
      this.terrainReadyProjectedByKey.delete(key);
      this.terrainReadyReadyKeys.delete(key);
      await this.renderAdapter.discardProjected?.(projected);
    }
  }

  #isTerrainRenderReady(key) {
    if (this.renderedKeys.has(key) || this.deferredRenderReleaseKeys.has(key)
      || this.terrainReadyProjectedByKey.has(key)) return true;
    for (const plan of this.preparedPlanRegistry) {
      if (!plan.discarded && plan.projectedByKey.has(key)) return true;
    }
    return false;
  }

  #terrainReadyOwnerNeedsWork(key) {
    if (!this.cache.has(key)) return true;
    return this.terrainReadyDesiredRenderKeys.has(key) && !this.#isTerrainRenderReady(key);
  }

  #terrainReadyQueueDepth() {
    let count = 0;
    for (const key of this.terrainReadyDesiredDataKeys) {
      if (this.#terrainReadyOwnerNeedsWork(key)) count += 1;
    }
    return count;
  }

  #completeTerrainReadyQueueOwner(key) {
    const now = this.clock();
    const queuedAtMs = this.terrainReadyQueuedAtByKey.get(key);
    if (queuedAtMs !== undefined) {
      this.counts.terrainReadyMaximumOldestWaitMs = Math.max(
        this.counts.terrainReadyMaximumOldestWaitMs,
        Math.max(0, now - queuedAtMs),
      );
      this.terrainReadyQueuedAtByKey.delete(key);
    }
    this.counts.terrainReadyMaximumQueueDepth = Math.max(
      this.counts.terrainReadyMaximumQueueDepth,
      this.#terrainReadyQueueDepth(),
    );
  }

  publishTraversalTerrain(chunkXInput, chunkZInput) {
    const chunkX = assertLogicalChunkCoordinate(chunkXInput, 'traversalTerrainChunkX');
    const chunkZ = assertLogicalChunkCoordinate(chunkZInput, 'traversalTerrainChunkZ');
    const key = createChunkKey(chunkX, chunkZ);
    if (this.isShutdown) return Promise.resolve(false);
    if (this.renderedKeys.has(key) || this.provisionalTerrainKeys.has(key)) {
      return Promise.resolve(true);
    }
    if (!this.activeDataKeys.has(key)) return Promise.resolve(false);
    if (typeof this.renderAdapter.projectTerrainChunk !== 'function'
      || typeof this.renderAdapter.loadProjectedTerrain !== 'function'
      || typeof this.renderAdapter.retainTerrainChunk !== 'function'
      || typeof this.renderAdapter.unloadProvisionalTerrain !== 'function') {
      return Promise.resolve(false);
    }
    const pending = this.provisionalTerrainPromises.get(key);
    if (pending) return pending;
    const operation = (async () => {
      let projected = null;
      try {
        const entry = this.cache.get(key);
        if (!entry?.data || !this.activeDataKeys.has(key)) return false;
        projected = await this.renderAdapter.projectTerrainChunk(entry.data, this.renderOrigin);
        if (this.renderedKeys.has(key) || !this.activeDataKeys.has(key)) {
          await this.renderAdapter.discardProjected?.(projected);
          return this.renderedKeys.has(key);
        }
        this.provisionalTerrainKeys.add(key);
        await this.renderAdapter.loadProjectedTerrain(projected);
        return true;
      } catch {
        this.provisionalTerrainKeys.delete(key);
        if (projected && projected.lifecycle === 'staged-terrain') {
          try { await this.renderAdapter.discardProjected?.(projected); } catch { /* fallback below */ }
        }
        return false;
      }
    })().finally(() => this.provisionalTerrainPromises.delete(key));
    this.provisionalTerrainPromises.set(key, operation);
    return operation;
  }

  isTerrainCoveragePublished(chunkXInput, chunkZInput) {
    const chunkX = assertLogicalChunkCoordinate(chunkXInput, 'terrainCoverageChunkX');
    const chunkZ = assertLogicalChunkCoordinate(chunkZInput, 'terrainCoverageChunkZ');
    const key = createChunkKey(chunkX, chunkZ);
    return this.renderedKeys.has(key) || this.provisionalTerrainKeys.has(key);
  }

  isTerrainCoverageProvisional(chunkXInput, chunkZInput) {
    const chunkX = assertLogicalChunkCoordinate(chunkXInput, 'provisionalTerrainChunkX');
    const chunkZ = assertLogicalChunkCoordinate(chunkZInput, 'provisionalTerrainChunkZ');
    return this.provisionalTerrainKeys.has(createChunkKey(chunkX, chunkZ));
  }

  #createPreparedTransitionPlan(chunkX, chunkZ, fromCenterKey) {
    const key = createChunkKey(chunkX, chunkZ);
    const epoch = ++this.preparedPlanEpoch;
    const plan = {
      key,
      epoch,
      consumerId: `runtime-prepared:${key}:${epoch}`,
      chunkX,
      chunkZ,
      fromCenterKey,
      dataCoordinates: squareChunkCoordinates(chunkX, chunkZ, 2),
      renderCoordinates: squareChunkCoordinates(chunkX, chunkZ, 1),
      projectedByKey: new Map(),
      required: false,
      ready: false,
      discarded: false,
      released: false,
      committing: false,
      promise: null,
      startedAtMs: this.clock(),
    };
    for (const coordinate of plan.renderCoordinates) {
      const projected = this.terrainReadyProjectedByKey.get(coordinate.key);
      if (!projected || projected.lifecycle !== 'staged') continue;
      this.terrainReadyProjectedByKey.delete(coordinate.key);
      plan.projectedByKey.set(coordinate.key, projected);
      this.counts.terrainReadyOwnerReuses += 1;
    }
    if (this.onPipelineEvent) this.#recordPipelineEvent('runtime-prefetch-plan-created', {
      ownerKey: key,
      chunkX,
      chunkZ,
      fromCenterKey,
      epoch,
      dataOwnerCount: plan.dataCoordinates.length,
      renderOwnerCount: plan.renderCoordinates.length,
    });
    this.preparedPlanRegistry.add(plan);
    return plan;
  }

  #markPreparedPlanReadyFromExistingWork(plan) {
    if (plan.dataCoordinates.some(coordinate => !this.cache.has(coordinate.key))) return false;
    if (plan.renderCoordinates.some(coordinate => (
      !this.renderedKeys.has(coordinate.key)
        && !this.deferredRenderReleaseKeys.has(coordinate.key)
        && !plan.projectedByKey.has(coordinate.key)
    ))) return false;
    plan.ready = true;
    this.counts.preparedTransitions += 1;
    return true;
  }

  #targetRenderOrigin(chunkX, chunkZ) {
    return Object.freeze({
      initialized: true,
      renderOriginChunkX: chunkX,
      renderOriginChunkZ: chunkZ,
      rebaseCount: this.renderOrigin.rebaseCount
        + (this.renderOrigin.initialized
          && (this.renderOrigin.renderOriginChunkX !== chunkX || this.renderOrigin.renderOriginChunkZ !== chunkZ) ? 1 : 0),
    });
  }

  #beginChunkDataRequest(coordinate, {
    priority, consumerId, epoch, deadlineAtMs = null, required = undefined,
  }) {
    const generationStartedAt = this.clock();
    if (this.onPipelineEvent) this.#recordPipelineEvent('runtime-owner-request-started', {
      ownerKey: coordinate.key,
      chunkX: coordinate.chunkX,
      chunkZ: coordinate.chunkZ,
      priority,
      consumerId,
      epoch,
      deadlineAtMs,
      ...(required === undefined ? {} : { required }),
    });
    const request = this.chunkDataService.requestChunk({
      chunkX: coordinate.chunkX,
      chunkZ: coordinate.chunkZ,
      priority,
      consumerId,
      epoch,
      ...(deadlineAtMs === null ? {} : { deadlineAtMs }),
      ...(required === undefined ? {} : { required }),
    });
    const promise = request.promise.then(chunkData => {
      const requestDurationMs = this.clock() - generationStartedAt;
      this.performance.record('generation', requestDurationMs);
      if (this.onPipelineEvent) this.#recordPipelineEvent('runtime-owner-request-complete', {
        ownerKey: coordinate.key,
        chunkX: coordinate.chunkX,
        chunkZ: coordinate.chunkZ,
        priority,
        consumerId,
        epoch,
        requestDurationMs,
        result: chunkData === null ? 'cancelled' : 'ready',
      });
      return chunkData;
    });
    return Object.freeze({ request, promise });
  }

  async #requestChunkData(coordinate, options) {
    return (await this.#beginChunkDataRequest(coordinate, options).promise);
  }

  #terrainReadyOwnerDiagnostic(key) {
    let entry = this.terrainReadyChunkDataOwnerDiagnostics.get(key);
    if (entry) return entry;
    entry = {
      requestCount: 0,
      cancelCount: 0,
      completionCount: 0,
      cacheInsertCount: 0,
    };
    this.terrainReadyChunkDataOwnerDiagnostics.set(key, entry);
    while (this.terrainReadyChunkDataOwnerDiagnostics.size
      > TERRAIN_READY_CHUNK_DATA_DIAGNOSTIC_OWNER_LIMIT) {
      const oldestKey = this.terrainReadyChunkDataOwnerDiagnostics.keys().next().value;
      if (this.terrainReadyChunkDataOperations.has(oldestKey)) break;
      this.terrainReadyChunkDataOwnerDiagnostics.delete(oldestKey);
    }
    return entry;
  }

  #supersedeTerrainReadyChunkDataOperations({
    desiredDataKeys,
    residentRequiredKeys = this.residentRequiredDataKeys,
    nextPlanEpoch,
  }) {
    let subscribersTransferred = 0;
    let subscribersLeft = 0;
    for (const [key, operation] of this.terrainReadyChunkDataOperations) {
      if (desiredDataKeys.has(key)) {
        if (operation.boundPlanEpoch !== nextPlanEpoch) {
          operation.boundPlanEpoch = nextPlanEpoch;
          operation.transferCount += 1;
          subscribersTransferred += 1;
          this.counts.chunkDataSubscribersTransferred += 1;
          this.counts.chunkDataUnderlyingRequestsReused += 1;
        }
        continue;
      }
      const details = typeof operation.request.cancelWithDetails === 'function'
        ? operation.request.cancelWithDetails()
        : Object.freeze({
          subscriberCancelled: operation.request.cancel(),
          underlyingRequestCancelled: false,
          workerCancelRequested: false,
        });
      if (!details.subscriberCancelled) continue;
      if (residentRequiredKeys.has(key)) {
        this.counts.requiredCancellationsByPrefetch += 1;
      }
      if (this.terrainReadyChunkDataOperations.get(key) === operation) {
        this.terrainReadyChunkDataOperations.delete(key);
      }
      subscribersLeft += 1;
      this.counts.chunkDataSubscribersLeft += 1;
      this.#terrainReadyOwnerDiagnostic(key).cancelCount += 1;
      if (details.underlyingRequestCancelled) {
        this.counts.chunkDataUnderlyingRequestsCancelled += 1;
      }
      if (details.workerCancelRequested) this.counts.chunkDataWorkerCancelRequests += 1;
    }
    return Object.freeze({ subscribersTransferred, subscribersLeft });
  }

  #acceptChunkData(coordinate, chunkData) {
    if (!chunkData || chunkData.chunkX !== coordinate.chunkX || chunkData.chunkZ !== coordinate.chunkZ) {
      throw new Error(`generator returned invalid prefetched ChunkData for ${coordinate.key}`);
    }
    const prior = this.cache.get(coordinate.key);
    if (prior && (prior.data.chunkId !== chunkData.chunkId || prior.data.contentHash !== chunkData.contentHash)) {
      throw new Error(`same chunk key produced differing identity/content: ${coordinate.key}`);
    }
    this.#registerIdentity(coordinate.key, chunkData);
    this.chunkIndex?.registerChunk(chunkData);
    if (!prior) {
      this.cache.set(coordinate.key, { data: chunkData, lastUsed: ++this.accessTick });
      this.counts.generated += 1;
      this.counts.maxCacheSize = Math.max(this.counts.maxCacheSize, this.cache.size);
      this.#evictInactiveCacheEntries();
    }
    return Object.freeze({ data: prior?.data ?? chunkData, generated: !prior });
  }

  async #ensureTerrainReadyChunkData(coordinate, {
    priority,
    plan,
    deadlineAtMs = null,
    required = false,
    intentionalPendingReuse = false,
  }) {
    const existing = this.cache.get(coordinate.key);
    if (existing?.data) {
      existing.lastUsed = ++this.accessTick;
      if (this.onPipelineEvent) this.#recordPipelineEvent('runtime-owner-cache-hit', {
        ownerKey: coordinate.key,
        chunkX: coordinate.chunkX,
        chunkZ: coordinate.chunkZ,
        priority,
        consumerId: `runtime-terrain-ready-owner:${coordinate.key}`,
        epoch: plan.epoch,
      });
      return Object.freeze({ data: existing.data, generated: false });
    }

    const pending = this.terrainReadyChunkDataOperations.get(coordinate.key);
    if (pending) {
      pending.boundPlanEpoch = plan.epoch;
      if (!intentionalPendingReuse) {
        this.counts.chunkDataDuplicateRequests += 1;
        this.counts.chunkDataUnderlyingRequestsReused += 1;
      }
      return pending.promise;
    }

    const ownerDiagnostic = this.#terrainReadyOwnerDiagnostic(coordinate.key);
    if (ownerDiagnostic.requestCount > 0) {
      this.counts.chunkDataSameOwnerRerequestCount += 1;
      if (this.residentRequiredDataKeys.has(coordinate.key)) {
        this.counts.residentSameOwnerRerequests += 1;
      }
    }
    ownerDiagnostic.requestCount += 1;
    const consumerId = `runtime-terrain-ready-owner:${coordinate.key}`;
    const operationEpoch = ownerDiagnostic.requestCount;
    const started = this.#beginChunkDataRequest(coordinate, {
      priority,
      consumerId,
      epoch: operationEpoch,
      deadlineAtMs,
      required,
    });
    const operation = {
      key: coordinate.key,
      request: started.request,
      promise: null,
      startedPlanEpoch: plan.epoch,
      boundPlanEpoch: plan.epoch,
      transferCount: 0,
    };
    this.counts.chunkDataSubscribersEntered += 1;
    operation.promise = started.promise.then(chunkData => {
      if (chunkData === null) return Object.freeze({ data: null, generated: false, cancelled: true });
      ownerDiagnostic.completionCount += 1;
      const result = this.#acceptChunkData(coordinate, chunkData);
      if (result.generated) {
        ownerDiagnostic.cacheInsertCount += 1;
        if (operation.transferCount > 0) {
          this.counts.chunkDataResponsesInsertedAfterPlanSupersede += 1;
        }
      }
      return result;
    }).finally(() => {
      if (this.terrainReadyChunkDataOperations.get(coordinate.key) === operation) {
        this.terrainReadyChunkDataOperations.delete(coordinate.key);
      }
    });
    this.terrainReadyChunkDataOperations.set(coordinate.key, operation);
    return operation.promise;
  }

  async #ensureChunkData(coordinate, {
    priority = CHUNK_DATA_PRIORITY.PLAYER_DATA,
    consumerId = 'runtime-prefetch',
    epoch = 0,
    deadlineAtMs = null,
    required = undefined,
  } = {}) {
    const existing = this.cache.get(coordinate.key);
    if (existing?.data) {
      existing.lastUsed = ++this.accessTick;
      if (this.onPipelineEvent) this.#recordPipelineEvent('runtime-owner-cache-hit', {
        ownerKey: coordinate.key,
        chunkX: coordinate.chunkX,
        chunkZ: coordinate.chunkZ,
        priority,
        consumerId,
        epoch,
      });
      return Object.freeze({ data: existing.data, generated: false });
    }
    const chunkData = await this.#requestChunkData(coordinate, {
      priority, consumerId, epoch, deadlineAtMs, required,
    });
    if (chunkData === null) return Object.freeze({ data: null, generated: false, cancelled: true });
    return this.#acceptChunkData(coordinate, chunkData);
  }

  async #discardPreparedTransition(plan, { force = false } = {}) {
    if (!plan || plan.released) return;
    if (plan.committing && !force) return;
    plan.discarded = true;
    this.chunkDataService.cancelConsumer({ consumerId: plan.consumerId, epoch: plan.epoch });
    for (const [key, projected] of plan.projectedByKey) {
      plan.projectedByKey.delete(key);
      // A rapid successor can make a formerly staged projection part of the
      // live render set before this older plan reaches its cleanup turn. Once
      // load has begun, ownership belongs to the render adapter/runtime and
      // the plan must only release its reference; normal unload/shutdown owns
      // disposal. Calling discardProjected here would attempt to destroy a
      // drawable that is already attached.
      if (projected?.lifecycle === 'loading' || projected?.lifecycle === 'loaded') continue;
      await this.renderAdapter.discardProjected?.(projected);
      if (this.terrainReadyDesiredRenderKeys.has(key) && !this.#isTerrainRenderReady(key)) {
        this.terrainReadyReadyKeys.delete(key);
        this.terrainReadyQueuedAtByKey.set(key, this.clock());
        if (this.terrainReadyPlan) this.terrainReadyPlan.failed = true;
      }
    }
    plan.projectedByKey.clear();
    if (this.preparedTransitions.get(plan.key) === plan) this.preparedTransitions.delete(plan.key);
    plan.released = true;
    this.preparedPlanRegistry.delete(plan);
    this.counts.discardedPreparedTransitions += 1;
  }

  async #awaitDiscardedPreparedPlans(plans) {
    await Promise.all(plans.map(async plan => {
      try { await plan.promise; } catch { /* discard below owns cleanup */ }
      await this.#discardPreparedTransition(plan);
    }));
  }

  #markUnpreferredPlans(preferredKey) {
    const stale = [];
    for (const [key, plan] of this.preparedTransitions) {
      if (key === preferredKey) continue;
      if (plan.committing) continue;
      plan.discarded = true;
      this.chunkDataService.cancelConsumer({ consumerId: plan.consumerId, epoch: plan.epoch });
      this.preparedTransitions.delete(key);
      stale.push(plan);
    }
    return stale;
  }

  async #prepareTransitionPlan(plan, { yieldBetweenUnits }) {
    try {
      if (this.onPipelineEvent) this.#recordPipelineEvent('runtime-prefetch-started', {
        ownerKey: plan.key,
        chunkX: plan.chunkX,
        chunkZ: plan.chunkZ,
        epoch: plan.epoch,
        dataOwnerCount: plan.dataCoordinates.length,
        renderOwnerCount: plan.renderCoordinates.length,
      });
      if (plan.discarded) return null;
      for (const coordinate of plan.dataCoordinates) {
        if (plan.key !== this.preferredPreparationKey && this.centerChunkX !== null) {
          await this.#discardPreparedTransition(plan);
          return null;
        }
        const isRenderCoordinate = plan.renderCoordinates.some(value => value.key === coordinate.key);
        const result = await this.#ensureChunkData(coordinate, {
          priority: isRenderCoordinate
            ? CHUNK_DATA_PRIORITY.PLAYER_RENDER : CHUNK_DATA_PRIORITY.PLAYER_DATA,
          consumerId: plan.consumerId,
          epoch: plan.epoch,
        });
        if (this.onPipelineEvent && result.generated) {
          this.#recordPipelineEvent('runtime-prefetch-owner-ready', {
            ownerKey: coordinate.key,
            targetOwnerKey: plan.key,
            chunkX: coordinate.chunkX,
            chunkZ: coordinate.chunkZ,
            epoch: plan.epoch,
            renderRequired: isRenderCoordinate,
          });
        }
        if (result.cancelled || plan.discarded) {
          await this.#discardPreparedTransition(plan);
          return null;
        }
        if (yieldBetweenUnits && result.generated) await this.yieldToHost();
      }
      const targetOrigin = this.#targetRenderOrigin(plan.chunkX, plan.chunkZ);
      for (const coordinate of plan.renderCoordinates) {
        if (plan.key !== this.preferredPreparationKey && this.centerChunkX !== null) {
          await this.#discardPreparedTransition(plan);
          return null;
        }
        if (plan.projectedByKey.has(coordinate.key)) continue;
        const entry = this.cache.get(coordinate.key);
        if (!entry?.data) throw new Error(`prepared ChunkData is undefined: ${coordinate.key}`);
        if (this.renderedKeys.has(coordinate.key) || this.deferredRenderReleaseKeys.has(coordinate.key)) continue;
        const projectionStartedAt = this.clock();
        const projected = await this.renderAdapter.projectChunk(entry.data, targetOrigin, {
          deferredRegistration: true,
        });
        this.performance.record('projection', this.clock() - projectionStartedAt);
        plan.projectedByKey.set(coordinate.key, projected);
        if (plan.required) this.counts.terrainReadyRequiredProjections += 1;
        if (this.onPipelineEvent) this.#recordPipelineEvent('runtime-terrain-prepared', {
          ownerKey: coordinate.key,
          targetOwnerKey: plan.key,
          chunkX: coordinate.chunkX,
          chunkZ: coordinate.chunkZ,
          epoch: plan.epoch,
        });
        this.counts.preparedProjections += 1;
        if (yieldBetweenUnits && !plan.required) await this.yieldToHost();
      }
      if (plan.discarded) {
        await this.#discardPreparedTransition(plan);
        return null;
      }
      plan.ready = true;
      this.counts.preparedTransitions += 1;
      if (this.onPipelineEvent) this.#recordPipelineEvent('runtime-prefetch-ready', {
        ownerKey: plan.key,
        chunkX: plan.chunkX,
        chunkZ: plan.chunkZ,
        epoch: plan.epoch,
        readyDataOwnerCount: plan.dataCoordinates.filter(coordinate => (
          this.cache.has(coordinate.key)
        )).length,
        preparedTerrainOwnerCount: plan.projectedByKey.size,
        durationMs: Math.max(0, this.clock() - plan.startedAtMs),
      });
      return plan;
    } catch (error) {
      await this.#discardPreparedTransition(plan, { force: true });
      throw error;
    }
  }

  #canPrepareTransition(chunkX, chunkZ) {
    if (this.centerChunkX === null) return this.cacheCapacity >= 25;
    const protectedKeys = new Set(this.activeDataKeys);
    for (const coordinate of squareChunkCoordinates(chunkX, chunkZ, 2)) protectedKeys.add(coordinate.key);
    return this.cacheCapacity >= protectedKeys.size;
  }

  async #materializeMissingData(coordinates, { chunkX, chunkZ }) {
    const missing = coordinates.filter(coordinate => !this.cache.has(coordinate.key));
    const epoch = ++this.transitionEpoch;
    this.chunkDataService.cancelConsumer({ consumerId: 'runtime-transition', beforeEpoch: epoch });
    const renderKeys = new Set(squareChunkCoordinates(chunkX, chunkZ, 1).map(coordinate => coordinate.key));
    const generated = await Promise.all(missing.map(async coordinate => {
      const chunkData = await this.#requestChunkData(coordinate, {
        priority: renderKeys.has(coordinate.key)
          ? CHUNK_DATA_PRIORITY.PLAYER_RENDER : CHUNK_DATA_PRIORITY.PLAYER_DATA,
        consumerId: 'runtime-transition',
        epoch,
      });
      if (!chunkData || chunkData.chunkX !== coordinate.chunkX || chunkData.chunkZ !== coordinate.chunkZ) {
        throw new Error(`ChunkDataService returned invalid ChunkData for ${coordinate.key}`);
      }
      return chunkData;
    }));
    missing.forEach((coordinate, index) => {
      const chunkData = generated[index];
      this.#registerIdentity(coordinate.key, chunkData);
      this.chunkIndex?.registerChunk(chunkData);
      this.cache.set(coordinate.key, { data: chunkData, lastUsed: ++this.accessTick });
      this.counts.generated += 1;
    });
    return missing;
  }

  async #ensurePreparedTransition(chunkX, chunkZ, { initial, required = false }) {
    const key = createChunkKey(chunkX, chunkZ);
    this.preferredPreparationKey = key;
    const stalePlans = this.#markUnpreferredPlans(key);
    const currentKey = this.centerChunkX === null ? null : createChunkKey(this.centerChunkX, this.centerChunkZ);
    let plan = this.preparedTransitions.get(key);
    if (!plan || plan.fromCenterKey !== currentKey || plan.discarded) {
      if (plan) await this.#discardPreparedTransition(plan);
      plan = this.#createPreparedTransitionPlan(chunkX, chunkZ, currentKey);
      plan.required = required;
      this.preparedTransitions.set(key, plan);
      if (this.#markPreparedPlanReadyFromExistingWork(plan)) {
        const cleanup = this.#awaitDiscardedPreparedPlans(stalePlans)
          .then(() => plan);
        plan.promise = cleanup;
      } else {
        this.preparationPendingCount += 1;
        const operation = this.preparationChain.then(async () => {
          for (const stale of stalePlans) await this.#discardPreparedTransition(stale);
          return this.#prepareTransitionPlan(plan, { yieldBetweenUnits: !initial });
        }).finally(() => { this.preparationPendingCount -= 1; });
        plan.promise = operation;
        this.preparationChain = operation.catch(() => {});
      }
    }
    if (required) plan.required = true;
    const prepared = await plan.promise;
    for (const stale of stalePlans) await this.#discardPreparedTransition(stale);
    if (!prepared || prepared.discarded || !prepared.ready) {
      throw new Error(`transition preparation was superseded for ${key}`);
    }
    return prepared;
  }

  async #ensureTerrainPresentationGeneration(chunkX, chunkZ, prepared, { required = false } = {}) {
    if (!this.terrainPresentationAdapter) return null;
    const centerKey = createChunkKey(chunkX, chunkZ);
    const revision = this.#terrainPresentationRevision();
    const identity = this.#terrainPresentationIdentity(centerKey, revision);
    this.terrainPresentationClaimTargetKey = centerKey;
    let entry = this.terrainPresentationEntries.get(identity);
    if (!entry || entry.state === 'failed' || entry.state === 'discarded') {
      if (entry) this.#discardTerrainPresentationEntry(entry, {
        cancelled: true,
        force: true,
        reason: 'required-retry-replaced',
      });
      entry = this.#createTerrainPresentationEntry({
        chunkX,
        chunkZ,
        revision,
        priorityIndex: -1,
        arrivalSeconds: 0,
        dataCoordinates: prepared?.dataCoordinates ?? squareChunkCoordinates(chunkX, chunkZ, 2),
        renderCoordinates: prepared?.renderCoordinates ?? squareChunkCoordinates(chunkX, chunkZ, 1),
        required,
      });
    }
    if (required && entry.requiredAtMs === null) {
      entry.requiredAtMs = this.clock();
      entry.arrivalAtMs = entry.requiredAtMs;
    }
    if (entry.state !== 'ready') {
      if (required) {
        this.counts.terrainPresentationRequiredOuterComposes += 1;
        this.counts.terrainPresentationRequiredClipmapBuilds += 1;
      }
      if (!this.#terrainPresentationDependenciesReady(entry)) {
        throw new Error(`Terrain presentation dependencies are not READY: ${identity}`);
      }
      while (entry.state !== 'ready') {
        if (entry.state === 'failed' || entry.state === 'discarded') break;
        this.#scheduleEligibleTerrainPresentationGenerations();
        if (entry.state === 'waiting') {
          this.#scheduleTerrainPresentationGeneration(entry);
        }
        const pending = entry.promise ?? this.terrainPresentationPreparationChain;
        await pending;
      }
    }
    if (entry.state !== 'ready' || !entry.presentationGeneration) {
      throw new Error(`Terrain presentation generation was superseded: ${identity}`);
    }
    entry.lastUsedAtMs = this.clock();
    return entry;
  }

  async #performTransition(chunkX, chunkZ, { required = false } = {}) {
    if (this.isShutdown) throw new Error('chunk runtime manager is shut down');
    if (this.centerChunkX === chunkX && this.centerChunkZ === chunkZ) {
      await this.#releaseObsoleteRenderOwners(this.renderedKeys, []);
      this.#validateRuntimeInvariants();
      this.counts.transitionsCoalesced += 1;
      return this.latestTransition;
    }
    const initial = this.centerChunkX === null;
    const before = { ...this.counts };
    const usePreparedTransition = this.#canPrepareTransition(chunkX, chunkZ);
    const prepared = usePreparedTransition
      ? await this.#ensurePreparedTransition(chunkX, chunkZ, { initial, required }) : null;
    const terrainPresentationEntry = initial ? null
      : await this.#ensureTerrainPresentationGeneration(
        chunkX,
        chunkZ,
        prepared,
        { required },
      );
    const startedAt = this.clock();
    if (this.onPipelineEvent) this.#recordPipelineEvent('runtime-transition-commit-started', {
      ownerKey: createChunkKey(chunkX, chunkZ),
      chunkX,
      chunkZ,
      prepared: prepared !== null,
      preparedEpoch: prepared?.epoch ?? null,
    });
    const desiredDataCoordinates = prepared?.dataCoordinates ?? squareChunkCoordinates(chunkX, chunkZ, 2);
    const desiredDataKeys = new Set(desiredDataCoordinates.map(coordinate => coordinate.key));
    const desiredRenderCoordinates = prepared?.renderCoordinates ?? squareChunkCoordinates(chunkX, chunkZ, 1);
    const desiredRenderKeys = new Set(desiredRenderCoordinates.map(coordinate => coordinate.key));
    if (!prepared) await this.#materializeMissingData(desiredDataCoordinates, { chunkX, chunkZ });
    const previousOrigin = this.renderOrigin;
    const targetOrigin = this.#targetRenderOrigin(chunkX, chunkZ);
    const physicalBefore = this.#physicalRenderKeys();
    const staged = [];
    const attached = [];
    const publicationSequence = [];
    let replacementCommitted = false;
    this.transitionProtectedDataKeys = desiredDataKeys;
    if (prepared) prepared.committing = true;
    try {
      for (const coordinate of desiredRenderCoordinates) {
        if (physicalBefore.has(coordinate.key)) continue;
        let projected = prepared?.projectedByKey.get(coordinate.key);
        if (!projected) {
          const entry = this.cache.get(coordinate.key);
          if (!entry?.data) throw new Error(`prepared ChunkData is undefined: ${coordinate.key}`);
          const projectionStartedAt = this.clock();
          projected = await this.renderAdapter.projectChunk(entry.data, targetOrigin, {
            deferredRegistration: true,
          });
          this.performance.record('projection', this.clock() - projectionStartedAt);
          if (required) this.counts.terrainReadyRequiredProjections += 1;
        }
        staged.push({ key: coordinate.key, projected });
        publicationSequence.push(Object.freeze({ type: 'replacement-prepared', ownerKey: coordinate.key }));
      }

      if (prepared?.discarded || prepared?.released) {
        throw new Error(`transition preparation was superseded for ${prepared.key}`);
      }
      for (const entry of staged) {
        const loadStartedAt = this.clock();
        const promotedTerrain = this.provisionalTerrainKeys.has(entry.key);
        await this.renderAdapter.loadProjected(entry.projected);
        this.performance.record('load', this.clock() - loadStartedAt);
        prepared?.projectedByKey.delete(entry.key);
        if (promotedTerrain) this.provisionalTerrainKeys.delete(entry.key);
        entry.promotedTerrain = promotedTerrain;
        attached.push(entry);
        if (this.onPipelineEvent) this.#recordPipelineEvent('runtime-terrain-attached', {
          ownerKey: entry.key,
          targetOwnerKey: createChunkKey(chunkX, chunkZ),
          chunkX,
          chunkZ,
          preparedEpoch: prepared?.epoch ?? null,
        });
        publicationSequence.push(Object.freeze({ type: 'replacement-attached', ownerKey: entry.key }));
        this.counts.renderLoaded += 1;
      }

      this.#validateReplacementRenderCoverage(desiredRenderKeys, attached);
      if (this.onPipelineEvent) this.#recordPipelineEvent('runtime-terrain-coverage-verified', {
        ownerKey: createChunkKey(chunkX, chunkZ),
        chunkX,
        chunkZ,
        attachedReplacementCount: attached.length,
        desiredRenderOwnerCount: desiredRenderKeys.size,
        preparedEpoch: prepared?.epoch ?? null,
      });
      publicationSequence.push(Object.freeze({
        type: 'new-coverage-verified',
        ownerKeys: Object.freeze(sortedKeys(desiredRenderKeys)),
      }));

      let dataActivated = 0;
      let cacheHits = 0;
      const desiredDataEntries = [];
      for (const coordinate of desiredDataCoordinates) {
        const entry = this.cache.get(coordinate.key);
        if (!entry?.data) throw new Error(`prepared ChunkData is undefined: ${coordinate.key}`);
        desiredDataEntries.push(entry);
        if (!this.activeDataKeys.has(coordinate.key)) dataActivated += 1;
        else cacheHits += 1;
      }
      let dataDeactivated = 0;
      for (const key of this.activeDataKeys) {
        if (!desiredDataKeys.has(key)) dataDeactivated += 1;
      }
      const activeDataKeyList = Object.freeze(sortedKeys(desiredDataKeys));
      const renderedKeyList = Object.freeze(sortedKeys(desiredRenderKeys));
      const transitionGeneration = this.committedTransitionGeneration + 1;
      const transitionContract = createRuntimeTransitionContract({
        generation: transitionGeneration,
        centerChunkX: chunkX,
        centerChunkZ: chunkZ,
        renderedKeys: renderedKeyList,
        activeDataKeys: activeDataKeyList,
      });

      if (prepared) {
        prepared.committing = false;
        await this.#discardPreparedTransition(prepared, { force: true });
      }

      const rebaseStartedAt = this.clock();
      await this.renderAdapter.rebase(targetOrigin);
      const originChange = this.floatingOrigin.setCenterChunk(chunkX, chunkZ);
      const origin = this.floatingOrigin.snapshot();
      this.renderOrigin = origin;
      if (originChange.changed) this.performance.record('rebase', this.clock() - rebaseStartedAt);

      for (const entry of desiredDataEntries) entry.lastUsed = ++this.accessTick;

      let terrainPresentationClaim = null;
      if (terrainPresentationEntry) {
        terrainPresentationEntry.claimAtMs = this.clock();
        terrainPresentationClaim = this.terrainPresentationAdapter.claim({
          presentationGeneration: terrainPresentationEntry.presentationGeneration,
          transitionContract,
          activeDataKeys: activeDataKeyList,
          renderedKeys: renderedKeyList,
          renderOrigin: origin,
          centerChunkX: chunkX,
          centerChunkZ: chunkZ,
        });
        if (!terrainPresentationClaim?.claimed) {
          this.counts.terrainPresentationStalePublishes += 1;
          throw new Error(`Terrain presentation generation claim failed: ${terrainPresentationClaim?.reason ?? 'unknown'}`);
        }
        terrainPresentationEntry.attachAtMs = this.clock();
        terrainPresentationEntry.claimedAtMs = terrainPresentationEntry.attachAtMs;
        terrainPresentationEntry.state = 'claimed';
        this.#recordTerrainPresentationLifecycle(terrainPresentationEntry, 'claimed');
        this.terrainPresentationEntries.delete(terrainPresentationEntry.identity);
        this.counts.terrainPresentationGenerationsClaimed += 1;
        publicationSequence.push(Object.freeze({
          type: 'terrain-presentation-generation-claimed',
          identity: terrainPresentationEntry.identity,
          ownerKey: terrainPresentationEntry.centerKey,
        }));
        if (this.onPipelineEvent) this.#recordPipelineEvent(
          'runtime-terrain-presentation-generation-claimed',
          {
            ownerKey: terrainPresentationEntry.centerKey,
            identity: terrainPresentationEntry.identity,
            transitionGeneration,
            geometryCount: terrainPresentationEntry.geometryCount,
            uploadBytes: terrainPresentationEntry.uploadBytes,
            requestAtMs: terrainPresentationEntry.requestAtMs,
            nearReadyAtMs: terrainPresentationEntry.nearReadyAtMs,
            outerReadyAtMs: terrainPresentationEntry.outerReadyAtMs,
            clipmapReadyAtMs: terrainPresentationEntry.clipmapReadyAtMs,
            presentationReadyAtMs: terrainPresentationEntry.presentationReadyAtMs,
            claimAtMs: terrainPresentationEntry.claimAtMs,
            claimedAtMs: terrainPresentationEntry.claimedAtMs,
            attachAtMs: terrainPresentationEntry.attachAtMs,
            oldReleaseAtMs: terrainPresentationEntry.oldReleaseAtMs,
            requiredAtMs: terrainPresentationEntry.requiredAtMs,
            arrivalAtMs: terrainPresentationEntry.arrivalAtMs,
          },
        );
      }

      for (const key of physicalBefore) {
        if (!desiredRenderKeys.has(key)) this.deferredRenderReleaseKeys.add(key);
      }
      for (const key of desiredRenderKeys) this.deferredRenderReleaseKeys.delete(key);
      this.activeDataKeys = desiredDataKeys;
      this.renderedKeys = desiredRenderKeys;
      this.centerChunkX = chunkX;
      this.centerChunkZ = chunkZ;
      this.activeDataKeyList = activeDataKeyList;
      this.renderedKeyList = renderedKeyList;
      this.committedTransitionGeneration = transitionGeneration;
      this.committedTransitionContract = transitionContract;
      this.counts.dataActivated += dataActivated;
      if (!initial) {
        if (this.terrainReadyArrivalStartedAtMs === null) {
          this.terrainReadyArrivalStartedAtMs = this.clock();
        }
        this.counts.terrainReadyPlayerArrivals += dataActivated;
      }
      this.counts.cacheHits += cacheHits;
      this.counts.dataDeactivated += dataDeactivated;
      this.transitionProtectedDataKeys = new Set();
      replacementCommitted = true;
      this.terrainPresentationClaimTargetKey = null;
      this.#scheduleEligibleTerrainPresentationGenerations();

      await this.#releaseObsoleteRenderOwners(desiredRenderKeys, publicationSequence);
      if (terrainPresentationEntry) {
        terrainPresentationEntry.oldReleaseAtMs = this.clock();
        if (this.onPipelineEvent) this.#recordPipelineEvent(
          'runtime-terrain-presentation-generation-handoff-completed',
          {
            ownerKey: terrainPresentationEntry.centerKey,
            identity: terrainPresentationEntry.identity,
            transitionGeneration,
            requestAtMs: terrainPresentationEntry.requestAtMs,
            nearReadyAtMs: terrainPresentationEntry.nearReadyAtMs,
            outerReadyAtMs: terrainPresentationEntry.outerReadyAtMs,
            clipmapReadyAtMs: terrainPresentationEntry.clipmapReadyAtMs,
            presentationReadyAtMs: terrainPresentationEntry.presentationReadyAtMs,
            claimAtMs: terrainPresentationEntry.claimAtMs,
            claimedAtMs: terrainPresentationEntry.claimedAtMs,
            attachAtMs: terrainPresentationEntry.attachAtMs,
            oldReleaseAtMs: terrainPresentationEntry.oldReleaseAtMs,
            requiredAtMs: terrainPresentationEntry.requiredAtMs,
            arrivalAtMs: terrainPresentationEntry.arrivalAtMs,
          },
        );
      }
      await this.#releaseObsoleteProvisionalTerrains(desiredRenderKeys);
      this.#evictInactiveCacheEntries();
      this.#validateRuntimeInvariants();
      this.counts.transitionsPerformed += 1;
      this.counts.maxCacheSize = Math.max(this.counts.maxCacheSize, this.cache.size);
      this.counts.maxActiveDataCount = Math.max(this.counts.maxActiveDataCount, this.activeDataKeys.size);
      this.counts.maxRenderedCount = Math.max(this.counts.maxRenderedCount, this.renderedKeys.size);
      const durationMs = this.clock() - startedAt;
      if (!initial) this.performance.record('crossing', durationMs);
      this.latestTransition = Object.freeze({
        initial,
        centerChunkX: chunkX,
        centerChunkZ: chunkZ,
        generatedDelta: this.counts.generated - before.generated,
        dataActivatedDelta: this.counts.dataActivated - before.dataActivated,
        dataDeactivatedDelta: this.counts.dataDeactivated - before.dataDeactivated,
        renderLoadedDelta: this.counts.renderLoaded - before.renderLoaded,
        renderUnloadedDelta: this.counts.renderUnloaded - before.renderUnloaded,
        rebaseDelta: originChange.changed ? 1 : 0,
        prepared: prepared !== null,
        terrainPresentationGenerationIdentity: terrainPresentationEntry?.identity ?? null,
        terrainPresentationClaimed: terrainPresentationClaim?.claimed === true,
        terrainPresentationTimeline: terrainPresentationEntry ? Object.freeze({
          requestAtMs: terrainPresentationEntry.requestAtMs,
          nearReadyAtMs: terrainPresentationEntry.nearReadyAtMs,
          outerReadyAtMs: terrainPresentationEntry.outerReadyAtMs,
          clipmapReadyAtMs: terrainPresentationEntry.clipmapReadyAtMs,
          presentationReadyAtMs: terrainPresentationEntry.presentationReadyAtMs,
          claimAtMs: terrainPresentationEntry.claimAtMs,
          claimedAtMs: terrainPresentationEntry.claimedAtMs,
          attachAtMs: terrainPresentationEntry.attachAtMs,
          oldReleaseAtMs: terrainPresentationEntry.oldReleaseAtMs,
          requiredAtMs: terrainPresentationEntry.requiredAtMs,
          arrivalAtMs: terrainPresentationEntry.arrivalAtMs,
        }) : null,
        terrainPublicationSequence: Object.freeze(publicationSequence),
        deferredRenderReleaseKeys: Object.freeze(sortedKeys(this.deferredRenderReleaseKeys)),
        durationMs,
        transitionContract: this.committedTransitionContract,
      });
      if (this.onPipelineEvent) this.#recordPipelineEvent('runtime-transition-committed', {
        ownerKey: createChunkKey(chunkX, chunkZ),
        chunkX,
        chunkZ,
        transitionGeneration,
        prepared: prepared !== null,
        durationMs,
        attachedReplacementCount: attached.length,
        releasedOwnerCount: publicationSequence.filter(event => (
          event.type === 'old-owner-released'
        )).length,
      });
      return this.latestTransition;
    } catch (error) {
      if (this.onPipelineEvent) this.#recordPipelineEvent('runtime-transition-rejected', {
        ownerKey: createChunkKey(chunkX, chunkZ),
        chunkX,
        chunkZ,
        prepared: prepared !== null,
        name: error?.name ?? 'Error',
        message: error?.message ?? String(error),
      });
      this.transitionProtectedDataKeys = new Set();
      this.terrainPresentationClaimTargetKey = null;
      this.#scheduleEligibleTerrainPresentationGenerations();
      if (replacementCommitted) throw error;
      const rollbackErrors = [];
      for (const entry of [...attached].reverse()) {
        try {
          if (entry.promotedTerrain) {
            await this.renderAdapter.retainTerrainChunk(entry.key);
            this.provisionalTerrainKeys.add(entry.key);
          } else {
            await this.renderAdapter.unloadChunk(entry.key);
          }
          this.counts.renderUnloaded += 1;
        } catch (rollbackError) {
          this.deferredRenderReleaseKeys.add(entry.key);
          rollbackErrors.push(rollbackError);
        }
      }
      for (const entry of staged) {
        if (attached.includes(entry)) continue;
        try {
          await this.renderAdapter.discardProjected?.(entry.projected);
          prepared?.projectedByKey.delete(entry.key);
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
      try {
        await this.renderAdapter.rebase(previousOrigin);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
      if (prepared) {
        prepared.committing = false;
        try {
          await this.#discardPreparedTransition(prepared, { force: true });
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
      if (rollbackErrors.length) {
        throw new AggregateError([error, ...rollbackErrors], 'Terrain transition failed and rollback was incomplete');
      }
      throw error;
    }
  }

  #physicalRenderKeys() {
    return new Set([...this.renderedKeys, ...this.deferredRenderReleaseKeys]);
  }

  #validateReplacementRenderCoverage(desiredRenderKeys, attached) {
    const physical = this.#physicalRenderKeys();
    for (const entry of attached) physical.add(entry.key);
    for (const key of desiredRenderKeys) {
      if (!physical.has(key)) throw new Error(`replacement Terrain is not attached: ${key}`);
    }
    const coverage = this.renderAdapter.renderCoverageSnapshot?.();
    if (!coverage) return;
    const loaded = new Set(coverage.loadedKeys ?? []);
    const terrain = new Set(coverage.terrainKeys ?? coverage.loadedKeys ?? []);
    const invalid = new Set([
      ...(coverage.missingTerrainKeys ?? []),
      ...(coverage.disposedTerrainKeys ?? []),
      ...(coverage.lifecycleMismatchKeys ?? []),
    ]);
    for (const key of desiredRenderKeys) {
      if (!loaded.has(key) || !terrain.has(key) || invalid.has(key)) {
        throw new Error(`replacement Terrain coverage is not renderable: ${key}`);
      }
    }
  }

  async #releaseObsoleteRenderOwners(desiredRenderKeys, publicationSequence) {
    const obsolete = sortedKeys(this.#physicalRenderKeys()).filter(key => !desiredRenderKeys.has(key));
    for (const key of obsolete) {
      const unloadStartedAt = this.clock();
      try {
        await this.renderAdapter.unloadChunk(key);
        this.performance.record('unload', this.clock() - unloadStartedAt);
        this.deferredRenderReleaseKeys.delete(key);
        this.counts.renderUnloaded += 1;
        publicationSequence.push(Object.freeze({ type: 'old-owner-released', ownerKey: key }));
        if (this.onPipelineEvent) this.#recordPipelineEvent('runtime-terrain-old-owner-released', {
          ownerKey: key,
          desiredRenderOwnerCount: desiredRenderKeys.size,
        });
      } catch (error) {
        this.deferredRenderReleaseKeys.add(key);
        this.counts.deferredRenderReleases += 1;
        this.counts.renderReleaseFailures += 1;
        publicationSequence.push(Object.freeze({
          type: 'old-owner-release-deferred',
          ownerKey: key,
          error: String(error?.message ?? error),
        }));
      }
    }
  }

  async #releaseObsoleteProvisionalTerrains(desiredRenderKeys) {
    if (typeof this.renderAdapter.unloadProvisionalTerrain !== 'function') return;
    const obsolete = sortedKeys(this.provisionalTerrainKeys)
      .filter(key => !desiredRenderKeys.has(key));
    for (const key of obsolete) {
      await this.renderAdapter.unloadProvisionalTerrain(key);
      this.provisionalTerrainKeys.delete(key);
    }
  }

  #registerIdentity(key, chunkData) {
    const identity = Object.freeze({ chunkId: chunkData.chunkId, contentHash: chunkData.contentHash });
    const existing = this.identityAudit.get(key);
    if (existing && (existing.chunkId !== identity.chunkId || existing.contentHash !== identity.contentHash)) {
      throw new Error(`regenerated chunk changed identity/content: ${key}`);
    }
    if (existing) this.identityAudit.delete(key);
    this.identityAudit.set(key, identity);
    while (this.identityAudit.size > this.identityAuditCapacity) {
      this.identityAudit.delete(this.identityAudit.keys().next().value);
      this.counts.identityAuditEvicted += 1;
    }
  }

  #recordPipelineEvent(type, details) {
    if (!this.onPipelineEvent) return null;
    try {
      return this.onPipelineEvent(type, details);
    } catch {
      return null;
    }
  }

  #validateRuntimeInvariants() {
    if (this.activeDataKeys.size !== 25) throw new Error(`active data set must remain 25, got ${this.activeDataKeys.size}`);
    if (this.renderedKeys.size !== 9) throw new Error(`render set must remain 9, got ${this.renderedKeys.size}`);
    if (this.cache.size > this.cacheCapacity) throw new Error('cache exceeded its explicit capacity');
    for (const key of this.renderedKeys) {
      if (!this.activeDataKeys.has(key)) throw new Error(`rendered chunk is outside active data set: ${key}`);
    }
    for (const key of this.provisionalTerrainKeys) {
      if (this.renderedKeys.has(key)) throw new Error(`Terrain owner is both committed and provisional: ${key}`);
      if (!this.activeDataKeys.has(key)) throw new Error(`provisional Terrain is outside active data set: ${key}`);
    }
    const renderCoverage = this.renderAdapter.renderCoverageSnapshot?.();
    if (renderCoverage) {
      const expected = sortedKeys(this.#physicalRenderKeys());
      const compare = (label, actual) => {
        const values = [...(actual ?? [])].sort((left, right) => left.localeCompare(right));
        if (values.length !== expected.length || values.some((key, index) => key !== expected[index])) {
          throw new Error(`${label} does not match Runtime rendered keys`);
        }
      };
      compare('loaded render coverage', renderCoverage.loadedKeys);
      compare('terrain render coverage', renderCoverage.terrainKeys);
      if (renderCoverage.missingTerrainKeys?.length) {
        throw new Error(`loaded chunks missing terrain: ${renderCoverage.missingTerrainKeys.join(', ')}`);
      }
      if (renderCoverage.disposedTerrainKeys?.length) {
        throw new Error(`loaded chunks contain disposed terrain: ${renderCoverage.disposedTerrainKeys.join(', ')}`);
      }
      if (renderCoverage.lifecycleMismatchKeys?.length) {
        throw new Error(`loaded chunk lifecycle mismatch: ${renderCoverage.lifecycleMismatchKeys.join(', ')}`);
      }
      const provisional = sortedKeys(renderCoverage.provisionalTerrainKeys ?? []);
      const expectedProvisional = sortedKeys(this.provisionalTerrainKeys);
      if (provisional.length !== expectedProvisional.length
        || provisional.some((key, index) => key !== expectedProvisional[index])) {
        throw new Error('provisional Terrain coverage does not match Runtime owners');
      }
    }
    const chunkIds = new Map();
    const featureIds = new Set();
    for (const key of this.activeDataKeys) {
      const chunkData = this.cache.get(key)?.data;
      if (!chunkData) throw new Error(`active ChunkData is undefined: ${key}`);
      const priorKey = chunkIds.get(chunkData.chunkId);
      if (priorKey && priorKey !== key) throw new Error(`duplicate chunkId across ${priorKey} and ${key}`);
      chunkIds.set(chunkData.chunkId, key);
      const features = [
        ...(chunkData.vegetationCandidates ?? chunkData.vegetationProxies ?? []),
        ...(chunkData.rockCandidates ?? chunkData.rockProxies ?? []),
        ...(chunkData.settlementFeatures ?? []),
      ];
      for (const feature of features) {
        const stableId = feature.candidateId ?? feature.stableId;
        if (typeof stableId !== 'string' || !stableId) throw new Error(`invalid Stable ID in active set: ${key}`);
        if (featureIds.has(stableId)) throw new Error(`duplicate Stable ID in active set: ${stableId}`);
        featureIds.add(stableId);
      }
      for (const [edge, offsetX, offsetZ, opposite] of [
        ['east', 1, 0, 'west'],
        ['south', 0, 1, 'north'],
      ]) {
        const neighbor = this.cache.get(createChunkKey(
          chunkData.chunkX + offsetX,
          chunkData.chunkZ + offsetZ,
        ))?.data;
        if (!neighbor || !this.activeDataKeys.has(createChunkKey(neighbor.chunkX, neighbor.chunkZ))) continue;
        if (chunkData.edgeData[edge].hash !== neighbor.edgeData[opposite].hash) {
          throw new Error(`shared edge hash mismatch: ${key}:${edge}`);
        }
        const validation = validateTerrainEdgePair(chunkData.terrain, edge, neighbor.terrain, opposite);
        if (!validation.valid) throw new Error(`shared terrain edge mismatch: ${key}:${edge}: ${validation.errors.join('; ')}`);
      }
    }
  }

  #evictInactiveCacheEntries() {
    if (this.cache.size <= this.cacheCapacity) return;
    const candidates = [...this.cache.entries()]
      .filter(([key]) => !this.activeDataKeys.has(key)
        && !this.renderedKeys.has(key)
        && !this.provisionalTerrainKeys.has(key)
        && !this.transitionProtectedDataKeys.has(key)
        && !this.residentRequiredDataKeys.has(key))
      .sort((a, b) => a[1].lastUsed - b[1].lastUsed
        || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    for (const [key] of candidates) {
      if (this.cache.size <= this.cacheCapacity) break;
      if (this.residentRequiredDataKeys.has(key)) {
        this.counts.residentOwnerEvictions += 1;
        throw new Error(`Resident owner selected for runtime eviction: ${key}`);
      }
      this.cache.delete(key);
      this.counts.dataEvicted += 1;
    }
    if (this.cache.size > this.cacheCapacity) {
      throw new Error('cache capacity is smaller than protected active data');
    }
  }

  getChunkData(chunkX, chunkZ) {
    return this.cache.get(createChunkKey(chunkX, chunkZ))?.data ?? null;
  }

  /** Lightweight frame reads: no MetricSeries copies, sorting, or Chunk-index snapshot. */
  getRenderOrigin() {
    return this.renderOrigin;
  }

  isCenteredAt(chunkXInput, chunkZInput) {
    const chunkX = assertLogicalChunkCoordinate(chunkXInput, 'centerChunkX');
    const chunkZ = assertLogicalChunkCoordinate(chunkZInput, 'centerChunkZ');
    return this.centerChunkX === chunkX && this.centerChunkZ === chunkZ;
  }

  isStreamingBusy() {
    return this.transitionPendingCount > 0 || this.preparationPendingCount > 0
      || this.pendingPrefetchKeys.size > 0
      || this.terrainPresentationPendingIdentity !== null
      || [...this.terrainPresentationEntries.values()].some(entry => (
        entry.state === 'queued' || entry.state === 'building'
      ));
  }

  getCommittedChunkState() {
    return Object.freeze({
      centerChunkX: this.centerChunkX,
      centerChunkZ: this.centerChunkZ,
      renderOrigin: this.renderOrigin,
      activeDataKeys: this.activeDataKeyList,
      renderedKeys: this.renderedKeyList,
      transitionContract: this.committedTransitionContract,
    });
  }

  getStreamingState() {
    return Object.freeze({
      centerChunkX: this.centerChunkX,
      centerChunkZ: this.centerChunkZ,
      transitionPending: this.transitionPendingCount > 0,
      preparationPending: this.preparationPendingCount > 0,
      pendingPrefetchCount: this.pendingPrefetchKeys.size,
      preparedTransitionCount: this.preparedTransitions.size,
      deferredRenderReleaseCount: this.deferredRenderReleaseKeys.size,
      provisionalTerrainCount: this.provisionalTerrainKeys.size,
      terrainReadyPlanPending: this.terrainReadyPlan !== null
        && !this.terrainReadyPlan.ready
        && !this.terrainReadyPlan.discarded
        && !this.terrainReadyPlan.failed,
      terrainReadyQueueDepth: this.#terrainReadyQueueDepth(),
      terrainPresentationPendingCount: [...this.terrainPresentationEntries.values()]
        .filter(entry => entry.state === 'waiting'
          || entry.state === 'queued' || entry.state === 'building').length,
      terrainPresentationReadyCount: [...this.terrainPresentationEntries.values()]
        .filter(entry => entry.state === 'ready').length,
    });
  }

  terrainLagSpikeDiagnosticSnapshot() {
    const snapshotEntry = entry => {
      if (!entry) return null;
      const dataReadyCount = entry.dataCoordinates.reduce(
        (count, coordinate) => count + Number(this.cache.has(coordinate.key)),
        0,
      );
      const renderReadyCount = entry.renderCoordinates.reduce(
        (count, coordinate) => count + Number(this.#isTerrainRenderReady(coordinate.key)),
        0,
      );
      return Object.freeze({
        identity: entry.identity,
        centerKey: entry.centerKey,
        chunkX: entry.chunkX,
        chunkZ: entry.chunkZ,
        state: entry.state,
        requestAtMs: entry.requestAtMs,
        startedAtMs: entry.startedAtMs,
        completedAtMs: entry.completedAtMs,
        claimedAtMs: entry.claimedAtMs,
        dataReadyCount,
        dataRequiredCount: entry.dataCoordinates.length,
        renderReadyCount,
        renderRequiredCount: entry.renderCoordinates.length,
        dependenciesReady: dataReadyCount === entry.dataCoordinates.length
          && renderReadyCount === entry.renderCoordinates.length,
        reuseRatio: entry.reuseRatio,
        jumpDistanceChunks: entry.jumpDistanceChunks,
      });
    };
    const inFlightEntry = this.terrainPresentationInFlightIdentity === null
      ? null : this.terrainPresentationEntries.get(this.terrainPresentationInFlightIdentity) ?? null;
    const pendingEntry = this.terrainPresentationPendingIdentity === null
      ? null : this.terrainPresentationEntries.get(this.terrainPresentationPendingIdentity) ?? null;
    const dependencyBatch = this.terrainDependencyLatestBatch;
    return Object.freeze({
      playerCenter: this.terrainPresentationPlayerCenter,
      runtimeCenter: this.centerChunkX === null ? null : Object.freeze({
        chunkX: this.centerChunkX,
        chunkZ: this.centerChunkZ,
        key: createChunkKey(this.centerChunkX, this.centerChunkZ),
      }),
      claimTargetKey: this.terrainPresentationClaimTargetKey,
      inFlight: snapshotEntry(inFlightEntry),
      pending: snapshotEntry(pendingEntry),
      readyUnclaimedCount: [...this.terrainPresentationEntries.values()]
        .filter(entry => entry.state === 'ready' && entry.claimedAtMs === null).length,
      generation: Object.freeze({
        requested: this.counts.terrainPresentationGenerationsRequested,
        started: this.counts.terrainPresentationGenerationsStarted,
        completed: this.counts.terrainPresentationGenerationsCompleted,
        claimed: this.counts.terrainPresentationGenerationsClaimed,
        coalesced: this.counts.terrainPresentationGenerationsCoalesced,
        discarded: this.counts.terrainPresentationGenerationsDiscarded,
      }),
      dependency: Object.freeze({
        targetCenterKey: dependencyBatch?.targetCenterKey ?? null,
        ownerReadyCount: dependencyBatch?.completedCount ?? 0,
        ownerRequiredCount: dependencyBatch?.ownerCount ?? 0,
        renderRequiredCount: dependencyBatch?.renderOwnerCount ?? 0,
        allResolvedAtMs: dependencyBatch?.allResolvedAtMs ?? null,
      }),
    });
  }

  #terrainReadySnapshot() {
    const now = this.clock();
    const durationSeconds = this.terrainReadyStartedAtMs === null
      ? 0 : Math.max(0, now - this.terrainReadyStartedAtMs) / 1000;
    const arrivalDurationSeconds = this.terrainReadyArrivalStartedAtMs === null
      ? 0 : Math.max(0, now - this.terrainReadyArrivalStartedAtMs) / 1000;
    const rate = (count, duration) => duration > 0 ? count / duration : 0;
    const queueDepth = this.#terrainReadyQueueDepth();
    let oldestWaitMs = 0;
    for (const [key, queuedAtMs] of this.terrainReadyQueuedAtByKey) {
      if (!this.terrainReadyDesiredDataKeys.has(key) || !this.#terrainReadyOwnerNeedsWork(key)) continue;
      oldestWaitMs = Math.max(oldestWaitMs, Math.max(0, now - queuedAtMs));
    }
    const readyRenderOwnerKeys = sortedKeys(this.terrainReadyDesiredRenderKeys).filter(key => (
      this.#isTerrainRenderReady(key)
    ));
    const centerSnapshot = entry => entry ? Object.freeze({
      chunkX: entry.chunkX,
      chunkZ: entry.chunkZ,
      key: entry.centerKey,
      identity: entry.identity,
      state: entry.state,
      dependenciesReady: entry.state !== 'waiting'
        || this.#terrainPresentationDependenciesReady(entry),
    }) : null;
    const inFlightEntry = this.terrainPresentationInFlightIdentity === null
      ? null : this.terrainPresentationEntries.get(this.terrainPresentationInFlightIdentity) ?? null;
    const pendingEntry = this.terrainPresentationPendingIdentity === null
      ? null : this.terrainPresentationEntries.get(this.terrainPresentationPendingIdentity) ?? null;
    const schedulerIdle = this.#terrainPresentationSchedulerIdleSnapshot(now);
    const terrainPresentationGenerations = Object.freeze(
      [...this.terrainPresentationEntries.values()]
        .sort((left, right) => left.priorityIndex - right.priorityIndex
          || left.identity.localeCompare(right.identity))
        .map(entry => Object.freeze({
          identity: entry.identity,
          centerKey: entry.centerKey,
          state: entry.state,
          priorityIndex: entry.priorityIndex,
          arrivalSeconds: entry.arrivalSeconds,
          requestAtMs: entry.requestAtMs,
          pendingEnteredAtMs: entry.pendingEnteredAtMs,
          pendingPromotedAtMs: entry.pendingPromotedAtMs,
          inFlightStartedAtMs: entry.inFlightStartedAtMs,
          startedAtMs: entry.startedAtMs,
          nearReadyAtMs: entry.nearReadyAtMs,
          outerReadyAtMs: entry.outerReadyAtMs,
          clipmapReadyAtMs: entry.clipmapReadyAtMs,
          presentationReadyAtMs: entry.presentationReadyAtMs,
          completedAtMs: entry.completedAtMs,
          claimAtMs: entry.claimAtMs,
          claimedAtMs: entry.claimedAtMs,
          attachAtMs: entry.attachAtMs,
          schedulerIdleStartedAtMs: entry.schedulerIdleStartedAtMs,
          schedulerIdleEndedAtMs: entry.schedulerIdleEndedAtMs,
          oldReleaseAtMs: entry.oldReleaseAtMs,
          requiredAtMs: entry.requiredAtMs,
          arrivalAtMs: entry.arrivalAtMs,
          geometryCount: entry.geometryCount,
          uploadBytes: entry.uploadBytes,
          maximumSliceMs: entry.maximumSliceMs,
          reuseRatio: entry.reuseRatio,
          jumpDistanceChunks: entry.jumpDistanceChunks,
        })),
    );
    const recentTerrainPresentationGenerations = Object.freeze(
      this.terrainPresentationLifecycleHistory.map(entry => entry),
    );
    const protectedChunkDataKeys = new Set([
      ...this.activeDataKeys,
      ...this.renderedKeys,
      ...this.provisionalTerrainKeys,
      ...this.transitionProtectedDataKeys,
      ...this.residentRequiredDataKeys,
    ]);
    const chunkDataOwnerDiagnostics = Object.freeze(
      [...this.terrainReadyChunkDataOwnerDiagnostics.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([ownerKey, entry]) => Object.freeze({ ownerKey, ...entry })),
    );
    const subscriberAttempts = this.counts.chunkDataSubscribersEntered
      + this.counts.chunkDataUnderlyingRequestsReused;
    const chunkDataServiceSnapshot = this.chunkDataService.snapshot?.() ?? null;
    const completedChunkDataKeys = new Set(chunkDataServiceSnapshot?.completedKeys ?? []);
    const chunkDataSubscriberDiagnostics = Object.freeze({
      schemaVersion: 'runtime-terrain-ready-chunk-data-subscribers-1',
      lastOwnerSetDiff: this.terrainReadyLastOwnerSetDiff,
      lastPrefetchSetDiff: this.terrainReadyLastPrefetchSetDiff,
      chunkDataSubscribersTransferred: this.counts.chunkDataSubscribersTransferred,
      chunkDataSubscribersEntered: this.counts.chunkDataSubscribersEntered,
      chunkDataSubscribersLeft: this.counts.chunkDataSubscribersLeft,
      chunkDataUnderlyingRequestsReused: this.counts.chunkDataUnderlyingRequestsReused,
      chunkDataUnderlyingRequestReuseRatio: subscriberAttempts > 0
        ? this.counts.chunkDataUnderlyingRequestsReused / subscriberAttempts : 0,
      chunkDataUnderlyingRequestsCancelled: this.counts.chunkDataUnderlyingRequestsCancelled,
      chunkDataDuplicateRequests: this.counts.chunkDataDuplicateRequests,
      chunkDataWorkerCancelRequests: this.counts.chunkDataWorkerCancelRequests,
      chunkDataResponsesInsertedAfterPlanSupersede:
        this.counts.chunkDataResponsesInsertedAfterPlanSupersede,
      chunkDataSameOwnerRerequestCount: this.counts.chunkDataSameOwnerRerequestCount,
      activeSubscriberCount: this.terrainReadyChunkDataOperations.size,
      ownerDiagnostics: chunkDataOwnerDiagnostics,
      cachePressure: Object.freeze({
        occupancy: chunkDataServiceSnapshot?.completedCacheSize ?? this.cache.size,
        capacity: chunkDataServiceSnapshot?.cacheCapacity ?? this.cacheCapacity,
        evictions: chunkDataServiceSnapshot?.counts?.completedEvictions
          ?? this.counts.dataEvicted,
        residentEvictions: (chunkDataServiceSnapshot?.counts?.protectedOwnerEvictions ?? 0)
          + this.counts.residentOwnerEvictions,
        protectedOwnerCount: protectedChunkDataKeys.size,
        protectedResidentOwnerCount: [...protectedChunkDataKeys]
          .filter(key => completedChunkDataKeys.has(key)).length,
        capacityOverflowRisk: protectedChunkDataKeys.size
          > (chunkDataServiceSnapshot?.cacheCapacity ?? this.cacheCapacity),
        runtimeOccupancy: this.cache.size,
        runtimeCapacity: this.cacheCapacity,
        runtimeEvictions: this.counts.dataEvicted,
      }),
    });
    const dependencyBatch = this.terrainDependencyLatestBatch;
    const terrainDependencyDiagnostics = Object.freeze({
      schemaVersion: 'runtime-terrain-dependency-batch-diagnostics-1',
      targetCenterKey: dependencyBatch?.targetCenterKey ?? null,
      planEpoch: dependencyBatch?.planEpoch ?? 0,
      terrainDependencyOwnerCount: dependencyBatch?.ownerCount ?? 0,
      terrainDependencyRenderOwnerCount: dependencyBatch?.renderOwnerCount ?? 0,
      terrainDependencyCacheHits: dependencyBatch?.cacheHitCount ?? 0,
      terrainDependencyBatchRegistered: dependencyBatch?.registeredCount ?? 0,
      terrainDependencyNewRequests: dependencyBatch?.newRequestCount ?? 0,
      terrainDependencyReusedRequests: dependencyBatch?.reusedRequestCount ?? 0,
      terrainDependencyCompleted: dependencyBatch?.completedCount ?? 0,
      terrainDependencyCancelled: dependencyBatch?.cancelledCount ?? 0,
      terrainDependencyWaitMs: dependencyBatch?.waitMs ?? null,
      terrainDependencyP50Ms: percentile(this.terrainDependencyWaitSamples, 0.5),
      terrainDependencyP95Ms: percentile(this.terrainDependencyWaitSamples, 0.95),
      terrainDependencyMaxMs: this.terrainDependencyWaitSamples.length === 0
        ? 0 : Math.max(...this.terrainDependencyWaitSamples),
      terrainDependencyLastOwnerWaitMs: dependencyBatch?.lastOwnerWaitMs ?? 0,
      targetToFirstDependencyRequestRegisteredMs:
        dependencyBatch === null || dependencyBatch.firstRegisteredAtMs === null
          ? 0 : Math.max(0,
            dependencyBatch.firstRegisteredAtMs - dependencyBatch.targetRequestedAtMs),
      targetToAllDependencyRequestsRegisteredMs: dependencyBatch === null
        ? 0 : Math.max(0,
          dependencyBatch.allRegisteredAtMs - dependencyBatch.targetRequestedAtMs),
      targetToAllDependenciesResolvedMs:
        dependencyBatch === null || dependencyBatch.allResolvedAtMs === null
          ? null : Math.max(0,
            dependencyBatch.allResolvedAtMs - dependencyBatch.targetRequestedAtMs),
      registrationDurationMs: dependencyBatch?.registrationDurationMs ?? 0,
      maximumRegistrationDurationMs: this.counts.terrainDependencyMaximumRegistrationMs,
      batchesRegistered: this.counts.terrainDependencyBatchesRegistered,
      batchesCompleted: this.counts.terrainDependencyBatchesCompleted,
    });
    return Object.freeze({
      schemaVersion: 'runtime-terrain-ready-diagnostics-1',
      planEpoch: this.terrainReadyPlan?.epoch ?? 0,
      planSignature: this.terrainReadyPlan?.signature ?? null,
      planReady: this.terrainReadyPlan?.ready === true,
      planFailed: this.terrainReadyPlan?.failed === true,
      desiredDataOwnerCount: this.terrainReadyDesiredDataKeys.size,
      residentRequiredOwnerCount: this.residentRequiredDataKeys.size,
      velocityPrefetchOwnerCount: [...this.terrainReadyDesiredDataKeys]
        .filter(key => !this.residentRequiredDataKeys.has(key)).length,
      desiredRenderOwnerCount: this.terrainReadyDesiredRenderKeys.size,
      readyRenderOwnerCount: readyRenderOwnerKeys.length,
      stagedProjectionCount: this.terrainReadyProjectedByKey.size,
      queueDepth,
      oldestWaitMs,
      maximumOldestWaitMs: this.counts.terrainReadyMaximumOldestWaitMs,
      requestedOwnersPerSecond: rate(this.counts.terrainReadyOwnersRequested, durationSeconds),
      generatedOwnersPerSecond: rate(this.counts.terrainReadyOwnersGenerated, durationSeconds),
      projectedOwnersPerSecond: rate(this.counts.terrainReadyOwnersProjected, durationSeconds),
      readyOwnersPerSecond: rate(this.counts.terrainReadyOwnersReady, durationSeconds),
      playerArrivalOwnersPerSecond: rate(
        this.counts.terrainReadyPlayerArrivals,
        arrivalDurationSeconds,
      ),
      readyRenderOwnerKeys: Object.freeze(readyRenderOwnerKeys),
      stagedProjectionKeys: Object.freeze(sortedKeys(this.terrainReadyProjectedByKey.keys())),
      chunkDataSubscriberDiagnostics,
      terrainDependencyDiagnostics,
      terrainPresentationStagedCenterLimit: TERRAIN_PRESENTATION_STAGED_CENTER_LIMIT,
      terrainPresentationScheduling: Object.freeze({
        schemaVersion: 'runtime-terrain-presentation-scheduling-3',
        terrainPresentationGenerationsRequested:
          this.counts.terrainPresentationGenerationsRequested,
        terrainPresentationGenerationsStarted:
          this.counts.terrainPresentationGenerationsStarted,
        terrainPresentationGenerationsCompleted:
          this.counts.terrainPresentationGenerationsCompleted,
        terrainPresentationGenerationsClaimed:
          this.counts.terrainPresentationGenerationsClaimed,
        terrainPresentationGenerationsCancelled:
          this.counts.terrainPresentationGenerationsCancelled,
        terrainPresentationGenerationsCoalesced:
          this.counts.terrainPresentationGenerationsCoalesced,
        terrainPresentationGenerationsDiscarded:
          this.counts.terrainPresentationGenerationsDiscarded,
        terrainPresentationCompletedUnclaimedDiscards:
          this.counts.terrainPresentationCompletedUnclaimedDiscards,
        terrainPresentationCatchupSteps:
          this.counts.terrainPresentationCatchupSteps,
        terrainPresentationReuseRatio:
          this.counts.terrainPresentationReuseRatio,
        terrainPresentationJumpHistogram: Object.freeze(
          Object.fromEntries(['1', '2', '3-5', '6+'].map(band => (
            [band, this.terrainPresentationJumpHistogram.get(band) ?? 0]
          ))),
        ),
        terrainPresentationReuseRatioByJump: Object.freeze(
          Object.fromEntries(['1', '2', '3-5', '6+'].map(band => {
            const reuse = this.terrainPresentationReuseByJump.get(band);
            return [band, reuse?.count > 0 ? reuse.sum / reuse.count : null];
          })),
        ),
        ...schedulerIdle,
        generations: terrainPresentationGenerations,
        recentGenerations: recentTerrainPresentationGenerations,
        inFlightCenter: centerSnapshot(inFlightEntry),
        pendingCenter: centerSnapshot(pendingEntry),
        activeCenter: this.centerChunkX === null ? null : Object.freeze({
          chunkX: this.centerChunkX,
          chunkZ: this.centerChunkZ,
          key: createChunkKey(this.centerChunkX, this.centerChunkZ),
        }),
        playerCenter: this.terrainPresentationPlayerCenter,
      }),
      terrainPresentationGenerations,
      recentTerrainPresentationGenerations,
      residentWorld: Object.freeze({
        requiredOwnerCount: this.residentRequiredDataKeys.size,
        lastOwnerSetDiff: this.terrainReadyLastOwnerSetDiff,
        lastPrefetchSetDiff: this.terrainReadyLastPrefetchSetDiff,
        coverageMiss: this.counts.residentCoverageMisses,
        ownerEviction: (chunkDataServiceSnapshot?.counts?.protectedOwnerEvictions ?? 0)
          + this.counts.residentOwnerEvictions,
        sameOwnerRerequest: this.counts.residentSameOwnerRerequests,
        requiredCancellationByPrefetch: this.counts.requiredCancellationsByPrefetch,
        fullWindowRebuild: this.counts.residentFullWindowRebuilds,
      }),
    });
  }

  recordFrame(durationMs) {
    return this.performance.record('frame', durationMs);
  }

  resetPerformance(names) {
    this.performance.reset(names);
  }

  snapshot() {
    const performance = this.performance.snapshot();
    return Object.freeze({
      centerChunkX: this.centerChunkX,
      centerChunkZ: this.centerChunkZ,
      renderOrigin: this.renderOrigin,
      activeDataCount: this.activeDataKeys.size,
      renderedCount: this.renderedKeys.size,
      cacheSize: this.cache.size,
      cacheCapacity: this.cacheCapacity,
      identityAuditSize: this.identityAudit.size,
      identityAuditCapacity: this.identityAuditCapacity,
      chunkIndex: this.chunkIndex?.snapshot() ?? null,
      activeDataKeys: this.activeDataKeyList,
      pendingPrefetchKeys: Object.freeze(sortedKeys(this.pendingPrefetchKeys)),
      renderedKeys: this.renderedKeyList,
      deferredRenderReleaseKeys: Object.freeze(sortedKeys(this.deferredRenderReleaseKeys)),
      provisionalTerrainKeys: Object.freeze(sortedKeys(this.provisionalTerrainKeys)),
      transitionContract: this.committedTransitionContract,
      streaming: this.getStreamingState(),
      terrainReady: this.#terrainReadySnapshot(),
      counts: Object.freeze({ ...this.counts }),
      latestTransition: this.latestTransition,
      performance,
      warnings: evaluateW1APerformanceWarnings(performance),
      chunkDataService: this.chunkDataService.snapshot?.() ?? null,
    });
  }

  async shutdown() {
    if (this.isShutdown) return;
    this.isShutdown = true;
    if (this.terrainReadyPlan && !this.terrainReadyPlan.discarded) {
      this.terrainReadyPlan.discarded = true;
      this.chunkDataService.cancelConsumer({
        consumerId: this.terrainReadyPlan.consumerId,
        epoch: this.terrainReadyPlan.epoch,
      });
    }
    this.#supersedeTerrainReadyChunkDataOperations({
      desiredDataKeys: new Set(),
      residentRequiredKeys: new Set(),
      nextPlanEpoch: this.terrainReadyPlanEpoch + 1,
    });
    await this.transitionChain;
    await this.preparationChain;
    await this.terrainPresentationPreparationChain;
    this.invalidateTerrainPresentationGenerations();
    for (const plan of [...this.preparedPlanRegistry]) await this.#discardPreparedTransition(plan);
    for (const projected of this.terrainReadyProjectedByKey.values()) {
      await this.renderAdapter.discardProjected?.(projected);
    }
    this.terrainReadyProjectedByKey.clear();
    for (const key of sortedKeys(this.#physicalRenderKeys())) {
      const startedAt = this.clock();
      await this.renderAdapter.unloadChunk(key);
      this.performance.record('unload', this.clock() - startedAt);
      this.counts.renderUnloaded += 1;
    }
    if (typeof this.renderAdapter.unloadProvisionalTerrain === 'function') {
      for (const key of sortedKeys(this.provisionalTerrainKeys)) {
        await this.renderAdapter.unloadProvisionalTerrain(key);
      }
    }
    this.renderedKeys.clear();
    this.provisionalTerrainKeys.clear();
    this.provisionalTerrainPromises.clear();
    this.deferredRenderReleaseKeys.clear();
    this.transitionProtectedDataKeys.clear();
    this.terrainReadyDesiredDataKeys.clear();
    this.residentRequiredDataKeys.clear();
    this.terrainReadyDesiredRenderKeys.clear();
    this.terrainReadyQueuedAtByKey.clear();
    this.terrainReadyReadyKeys.clear();
    this.terrainReadyChunkDataOperations.clear();
    this.terrainReadyChunkDataOwnerDiagnostics.clear();
    this.activeDataKeys.clear();
    this.cache.clear();
    this.identityAudit.clear();
    this.pendingPrefetchKeys.clear();
    await this.renderAdapter.shutdown();
    this.chunkDataService.cancelConsumer({ consumerId: 'runtime-prefetch', epoch: 0 });
    this.chunkDataService.cancelConsumer({ consumerId: 'runtime-terrain-ready' });
    this.chunkDataService.cancelConsumer({ consumerId: 'runtime-transition' });
    this.chunkDataService.replaceProtectedOwnerKeys?.([]);
    if (this.ownsChunkDataService) await this.chunkDataService.shutdown();
  }
}
