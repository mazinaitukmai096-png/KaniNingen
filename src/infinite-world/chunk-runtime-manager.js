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
    this.floatingOrigin = new FloatingOrigin();
    this.performance = new PerformanceLedger();
    this.cache = new Map();
    this.identityAudit = new Map();
    this.activeDataKeys = new Set();
    this.renderedKeys = new Set();
    this.centerChunkX = null;
    this.centerChunkZ = null;
    this.accessTick = 0;
    this.transitionChain = Promise.resolve();
    this.preparationChain = Promise.resolve();
    this.isShutdown = false;
    this.latestTransition = null;
    this.pendingPrefetchKeys = new Set();
    this.preparedTransitions = new Map();
    this.preparedPlanRegistry = new Set();
    this.preferredPreparationKey = null;
    this.preparedPlanEpoch = 0;
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
    };
  }

  initialize(centerChunkX = 0, centerChunkZ = 0) {
    return this.transitionToChunk(centerChunkX, centerChunkZ);
  }

  transitionToChunk(chunkXInput, chunkZInput) {
    const chunkX = assertLogicalChunkCoordinate(chunkXInput, 'centerChunkX');
    const chunkZ = assertLogicalChunkCoordinate(chunkZInput, 'centerChunkZ');
    this.counts.transitionsRequested += 1;
    this.transitionPendingCount += 1;
    const operation = this.transitionChain.then(() => this.#performTransition(chunkX, chunkZ))
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
      ready: false,
      discarded: false,
      released: false,
      promise: null,
    };
    this.preparedPlanRegistry.add(plan);
    return plan;
  }

  #targetRenderOrigin(chunkX, chunkZ) {
    return Object.freeze({
      initialized: true,
      renderOriginChunkX: chunkX,
      renderOriginChunkZ: chunkZ,
      rebaseCount: this.renderOrigin.rebaseCount
        + (this.renderOrigin.renderOriginChunkX === chunkX && this.renderOrigin.renderOriginChunkZ === chunkZ ? 0 : 1),
    });
  }

  async #requestChunkData(coordinate, { priority, consumerId, epoch }) {
    const generationStartedAt = this.clock();
    const request = this.chunkDataService.requestChunk({
      chunkX: coordinate.chunkX,
      chunkZ: coordinate.chunkZ,
      priority,
      consumerId,
      epoch,
    });
    const chunkData = await request.promise;
    this.performance.record('generation', this.clock() - generationStartedAt);
    return chunkData;
  }

  async #ensureChunkData(coordinate, {
    priority = CHUNK_DATA_PRIORITY.PLAYER_DATA,
    consumerId = 'runtime-prefetch',
    epoch = 0,
  } = {}) {
    const existing = this.cache.get(coordinate.key);
    if (existing?.data) {
      existing.lastUsed = ++this.accessTick;
      return Object.freeze({ data: existing.data, generated: false });
    }
    const chunkData = await this.#requestChunkData(coordinate, { priority, consumerId, epoch });
    if (chunkData === null) return Object.freeze({ data: null, generated: false, cancelled: true });
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

  async #discardPreparedTransition(plan) {
    if (!plan || plan.released) return;
    plan.discarded = true;
    this.chunkDataService.cancelConsumer({ consumerId: plan.consumerId, epoch: plan.epoch });
    for (const projected of plan.projectedByKey.values()) {
      await this.renderAdapter.discardProjected?.(projected);
    }
    plan.projectedByKey.clear();
    if (this.preparedTransitions.get(plan.key) === plan) this.preparedTransitions.delete(plan.key);
    plan.released = true;
    this.preparedPlanRegistry.delete(plan);
    this.counts.discardedPreparedTransitions += 1;
  }

  #markUnpreferredPlans(preferredKey) {
    const stale = [];
    for (const [key, plan] of this.preparedTransitions) {
      if (key === preferredKey) continue;
      plan.discarded = true;
      this.preparedTransitions.delete(key);
      stale.push(plan);
    }
    return stale;
  }

  async #prepareTransitionPlan(plan, { yieldBetweenUnits }) {
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
      if (result.cancelled || plan.discarded) return null;
      if (yieldBetweenUnits && result.generated) await this.yieldToHost();
    }
    const targetOrigin = this.#targetRenderOrigin(plan.chunkX, plan.chunkZ);
    for (const coordinate of plan.renderCoordinates) {
      if (plan.key !== this.preferredPreparationKey && this.centerChunkX !== null) {
        await this.#discardPreparedTransition(plan);
        return null;
      }
      const entry = this.cache.get(coordinate.key);
      if (!entry?.data) throw new Error(`prepared ChunkData is undefined: ${coordinate.key}`);
      if (this.renderedKeys.has(coordinate.key)) continue;
      const projectionStartedAt = this.clock();
      const projected = await this.renderAdapter.projectChunk(entry.data, targetOrigin, {
        deferredRegistration: true,
      });
      this.performance.record('projection', this.clock() - projectionStartedAt);
      plan.projectedByKey.set(coordinate.key, projected);
      this.counts.preparedProjections += 1;
      if (yieldBetweenUnits) await this.yieldToHost();
    }
    if (plan.discarded) return null;
    plan.ready = true;
    this.counts.preparedTransitions += 1;
    return plan;
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

  async #ensurePreparedTransition(chunkX, chunkZ, { initial }) {
    const key = createChunkKey(chunkX, chunkZ);
    this.preferredPreparationKey = key;
    const stalePlans = this.#markUnpreferredPlans(key);
    const currentKey = this.centerChunkX === null ? null : createChunkKey(this.centerChunkX, this.centerChunkZ);
    let plan = this.preparedTransitions.get(key);
    if (!plan || plan.fromCenterKey !== currentKey || plan.discarded) {
      if (plan) await this.#discardPreparedTransition(plan);
      plan = this.#createPreparedTransitionPlan(chunkX, chunkZ, currentKey);
      this.preparedTransitions.set(key, plan);
      this.preparationPendingCount += 1;
      const operation = this.preparationChain.then(async () => {
        for (const stale of stalePlans) await this.#discardPreparedTransition(stale);
        return this.#prepareTransitionPlan(plan, { yieldBetweenUnits: !initial });
      }).finally(() => { this.preparationPendingCount -= 1; });
      plan.promise = operation;
      this.preparationChain = operation.catch(() => {});
    }
    const prepared = await plan.promise;
    for (const stale of stalePlans) await this.#discardPreparedTransition(stale);
    if (!prepared || prepared.discarded || !prepared.ready) {
      throw new Error(`transition preparation was superseded for ${key}`);
    }
    return prepared;
  }

  async #performTransition(chunkX, chunkZ) {
    if (this.isShutdown) throw new Error('chunk runtime manager is shut down');
    if (this.centerChunkX === chunkX && this.centerChunkZ === chunkZ) {
      this.counts.transitionsCoalesced += 1;
      return this.latestTransition;
    }
    const initial = this.centerChunkX === null;
    const before = { ...this.counts };
    const usePreparedTransition = this.#canPrepareTransition(chunkX, chunkZ);
    const prepared = usePreparedTransition
      ? await this.#ensurePreparedTransition(chunkX, chunkZ, { initial }) : null;
    const startedAt = this.clock();
    const desiredDataCoordinates = prepared?.dataCoordinates ?? squareChunkCoordinates(chunkX, chunkZ, 2);
    const desiredDataKeys = new Set(desiredDataCoordinates.map(coordinate => coordinate.key));
    const desiredRenderCoordinates = prepared?.renderCoordinates ?? squareChunkCoordinates(chunkX, chunkZ, 1);
    const desiredRenderKeys = new Set(desiredRenderCoordinates.map(coordinate => coordinate.key));
    if (!prepared) await this.#materializeMissingData(desiredDataCoordinates, { chunkX, chunkZ });
    const originChange = this.floatingOrigin.setCenterChunk(chunkX, chunkZ);
    const origin = this.floatingOrigin.snapshot();
    this.renderOrigin = origin;
    const rebaseStartedAt = this.clock();
    await this.renderAdapter.rebase(origin);
    if (originChange.changed) this.performance.record('rebase', this.clock() - rebaseStartedAt);

    for (const coordinate of desiredDataCoordinates) {
      const entry = this.cache.get(coordinate.key);
      if (!entry?.data) throw new Error(`prepared ChunkData is undefined: ${coordinate.key}`);
      entry.lastUsed = ++this.accessTick;
      if (!this.activeDataKeys.has(coordinate.key)) this.counts.dataActivated += 1;
      else this.counts.cacheHits += 1;
    }
    for (const key of this.activeDataKeys) {
      if (!desiredDataKeys.has(key)) this.counts.dataDeactivated += 1;
    }
    this.activeDataKeys = desiredDataKeys;

    for (const key of sortedKeys(this.renderedKeys)) {
      if (desiredRenderKeys.has(key)) continue;
      const unloadStartedAt = this.clock();
      await this.renderAdapter.unloadChunk(key);
      this.performance.record('unload', this.clock() - unloadStartedAt);
      this.renderedKeys.delete(key);
      this.counts.renderUnloaded += 1;
    }
    for (const coordinate of desiredRenderCoordinates) {
      if (this.renderedKeys.has(coordinate.key)) continue;
      let projected = prepared?.projectedByKey.get(coordinate.key);
      if (!projected) {
        const entry = this.cache.get(coordinate.key);
        const projectionStartedAt = this.clock();
        projected = await this.renderAdapter.projectChunk(entry.data, origin);
        this.performance.record('projection', this.clock() - projectionStartedAt);
      }
      // Ownership moves out of the prepared plan before scene attachment. A
      // superseded-plan cleanup can therefore only dispose projections that
      // are still staged and never a projection being loaded or already live.
      prepared?.projectedByKey.delete(coordinate.key);
      const loadStartedAt = this.clock();
      try {
        await this.renderAdapter.loadProjected(projected);
      } catch (error) {
        if (projected?.lifecycle === 'staged') {
          await this.renderAdapter.discardProjected?.(projected);
        }
        throw error;
      }
      this.performance.record('load', this.clock() - loadStartedAt);
      this.renderedKeys.add(coordinate.key);
      this.counts.renderLoaded += 1;
    }
    if (prepared) await this.#discardPreparedTransition(prepared);

    this.centerChunkX = chunkX;
    this.centerChunkZ = chunkZ;
    this.activeDataKeyList = Object.freeze(sortedKeys(this.activeDataKeys));
    this.renderedKeyList = Object.freeze(sortedKeys(this.renderedKeys));
    this.committedTransitionContract = createRuntimeTransitionContract({
      generation: ++this.committedTransitionGeneration,
      centerChunkX: chunkX,
      centerChunkZ: chunkZ,
      renderedKeys: this.renderedKeyList,
      activeDataKeys: this.activeDataKeyList,
    });
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
      durationMs,
      transitionContract: this.committedTransitionContract,
    });
    return this.latestTransition;
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

  #validateRuntimeInvariants() {
    if (this.activeDataKeys.size !== 25) throw new Error(`active data set must remain 25, got ${this.activeDataKeys.size}`);
    if (this.renderedKeys.size !== 9) throw new Error(`render set must remain 9, got ${this.renderedKeys.size}`);
    if (this.cache.size > this.cacheCapacity) throw new Error('cache exceeded its explicit capacity');
    for (const key of this.renderedKeys) {
      if (!this.activeDataKeys.has(key)) throw new Error(`rendered chunk is outside active data set: ${key}`);
    }
    const renderCoverage = this.renderAdapter.renderCoverageSnapshot?.();
    if (renderCoverage) {
      const expected = sortedKeys(this.renderedKeys);
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
      .filter(([key]) => !this.activeDataKeys.has(key) && !this.renderedKeys.has(key))
      .sort((a, b) => a[1].lastUsed - b[1].lastUsed
        || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    for (const [key] of candidates) {
      if (this.cache.size <= this.cacheCapacity) break;
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
      || this.pendingPrefetchKeys.size > 0;
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
      transitionContract: this.committedTransitionContract,
      streaming: this.getStreamingState(),
      counts: Object.freeze({ ...this.counts }),
      latestTransition: this.latestTransition,
      performance,
      warnings: evaluateW1APerformanceWarnings(performance),
      chunkDataService: this.chunkDataService.snapshot?.() ?? null,
    });
  }

  async shutdown() {
    if (this.isShutdown) return;
    await this.transitionChain;
    await this.preparationChain;
    for (const plan of [...this.preparedPlanRegistry]) await this.#discardPreparedTransition(plan);
    for (const key of sortedKeys(this.renderedKeys)) {
      const startedAt = this.clock();
      await this.renderAdapter.unloadChunk(key);
      this.performance.record('unload', this.clock() - startedAt);
      this.counts.renderUnloaded += 1;
    }
    this.renderedKeys.clear();
    this.activeDataKeys.clear();
    this.cache.clear();
    this.identityAudit.clear();
    this.pendingPrefetchKeys.clear();
    await this.renderAdapter.shutdown();
    this.chunkDataService.cancelConsumer({ consumerId: 'runtime-prefetch', epoch: 0 });
    this.chunkDataService.cancelConsumer({ consumerId: 'runtime-transition' });
    if (this.ownsChunkDataService) await this.chunkDataService.shutdown();
    this.isShutdown = true;
  }
}
