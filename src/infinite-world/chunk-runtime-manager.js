import {
  assertLogicalChunkCoordinate,
  createChunkKey,
  squareChunkCoordinates,
} from './chunk-coordinates.js';
import { FloatingOrigin } from './floating-origin.js';
import { evaluateW1APerformanceWarnings, PerformanceLedger } from './performance-metrics.js';

function defaultClock() {
  return globalThis.performance?.now?.() ?? Date.now();
}

function sortedKeys(values) {
  return [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export class ChunkRuntimeManager {
  constructor({ generator, renderAdapter, cacheCapacity = 81, clock = defaultClock } = {}) {
    if (typeof generator?.generateChunk !== 'function') throw new TypeError('generator.generateChunk is required');
    for (const method of ['rebase', 'projectChunk', 'loadProjected', 'unloadChunk', 'shutdown']) {
      if (typeof renderAdapter?.[method] !== 'function') throw new TypeError(`renderAdapter.${method} is required`);
    }
    if (!Number.isSafeInteger(cacheCapacity) || cacheCapacity < 25) {
      throw new RangeError('cacheCapacity must retain at least the active 5x5 data set');
    }
    if (typeof clock !== 'function') throw new TypeError('clock must be a function');
    this.generator = generator;
    this.renderAdapter = renderAdapter;
    this.cacheCapacity = cacheCapacity;
    this.clock = clock;
    this.floatingOrigin = new FloatingOrigin();
    this.performance = new PerformanceLedger();
    this.cache = new Map();
    this.activeDataKeys = new Set();
    this.renderedKeys = new Set();
    this.centerChunkX = null;
    this.centerChunkZ = null;
    this.accessTick = 0;
    this.transitionChain = Promise.resolve();
    this.isShutdown = false;
    this.latestTransition = null;
    this.counts = {
      generated: 0,
      cacheHits: 0,
      dataActivated: 0,
      dataDeactivated: 0,
      dataEvicted: 0,
      renderLoaded: 0,
      renderUnloaded: 0,
    };
  }

  initialize(centerChunkX = 0, centerChunkZ = 0) {
    return this.transitionToChunk(centerChunkX, centerChunkZ);
  }

  transitionToChunk(chunkXInput, chunkZInput) {
    const chunkX = assertLogicalChunkCoordinate(chunkXInput, 'centerChunkX');
    const chunkZ = assertLogicalChunkCoordinate(chunkZInput, 'centerChunkZ');
    const operation = this.transitionChain.then(() => this.#performTransition(chunkX, chunkZ));
    this.transitionChain = operation.catch(() => {});
    return operation;
  }

  async #performTransition(chunkX, chunkZ) {
    if (this.isShutdown) throw new Error('chunk runtime manager is shut down');
    if (this.centerChunkX === chunkX && this.centerChunkZ === chunkZ) {
      return this.latestTransition;
    }
    const startedAt = this.clock();
    const initial = this.centerChunkX === null;
    const before = { ...this.counts };
    const originChange = this.floatingOrigin.setCenterChunk(chunkX, chunkZ);
    const origin = this.floatingOrigin.snapshot();
    const rebaseStartedAt = this.clock();
    await this.renderAdapter.rebase(origin);
    if (originChange.changed) this.performance.record('rebase', this.clock() - rebaseStartedAt);

    const desiredDataCoordinates = squareChunkCoordinates(chunkX, chunkZ, 2);
    const desiredDataKeys = new Set(desiredDataCoordinates.map(coordinate => coordinate.key));
    const missingCoordinates = desiredDataCoordinates.filter(coordinate => !this.cache.has(coordinate.key));

    await Promise.all(missingCoordinates.map(async coordinate => {
      const generationStartedAt = this.clock();
      const chunkData = await this.generator.generateChunk(coordinate.chunkX, coordinate.chunkZ);
      this.performance.record('generation', this.clock() - generationStartedAt);
      if (!chunkData || chunkData.chunkX !== coordinate.chunkX || chunkData.chunkZ !== coordinate.chunkZ) {
        throw new Error(`generator returned invalid ChunkData for ${coordinate.key}`);
      }
      const existing = this.cache.get(coordinate.key);
      if (existing && (existing.data.chunkId !== chunkData.chunkId
        || existing.data.contentHash !== chunkData.contentHash)) {
        throw new Error(`same chunk key produced differing identity/content: ${coordinate.key}`);
      }
      if (!existing) {
        this.cache.set(coordinate.key, { data: chunkData, lastUsed: ++this.accessTick });
        this.counts.generated += 1;
      }
    }));

    for (const coordinate of desiredDataCoordinates) {
      const entry = this.cache.get(coordinate.key);
      entry.lastUsed = ++this.accessTick;
      if (!this.activeDataKeys.has(coordinate.key)) this.counts.dataActivated += 1;
      else if (!missingCoordinates.some(missing => missing.key === coordinate.key)) this.counts.cacheHits += 1;
    }
    for (const key of this.activeDataKeys) {
      if (!desiredDataKeys.has(key)) this.counts.dataDeactivated += 1;
    }
    this.activeDataKeys = desiredDataKeys;

    const desiredRenderCoordinates = squareChunkCoordinates(chunkX, chunkZ, 1);
    const desiredRenderKeys = new Set(desiredRenderCoordinates.map(coordinate => coordinate.key));
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
      const entry = this.cache.get(coordinate.key);
      if (!entry?.data) throw new Error(`undefined ChunkData for rendered chunk ${coordinate.key}`);
      const projectionStartedAt = this.clock();
      const projected = await this.renderAdapter.projectChunk(entry.data, origin);
      this.performance.record('projection', this.clock() - projectionStartedAt);
      const loadStartedAt = this.clock();
      await this.renderAdapter.loadProjected(projected);
      this.performance.record('load', this.clock() - loadStartedAt);
      this.renderedKeys.add(coordinate.key);
      this.counts.renderLoaded += 1;
    }

    this.centerChunkX = chunkX;
    this.centerChunkZ = chunkZ;
    this.#evictInactiveCacheEntries();
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
      durationMs,
    });
    return this.latestTransition;
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

  recordFrame(durationMs) {
    return this.performance.record('frame', durationMs);
  }

  snapshot() {
    const performance = this.performance.snapshot();
    return Object.freeze({
      centerChunkX: this.centerChunkX,
      centerChunkZ: this.centerChunkZ,
      renderOrigin: this.floatingOrigin.snapshot(),
      activeDataCount: this.activeDataKeys.size,
      renderedCount: this.renderedKeys.size,
      cacheSize: this.cache.size,
      cacheCapacity: this.cacheCapacity,
      activeDataKeys: Object.freeze(sortedKeys(this.activeDataKeys)),
      renderedKeys: Object.freeze(sortedKeys(this.renderedKeys)),
      counts: Object.freeze({ ...this.counts }),
      latestTransition: this.latestTransition,
      performance,
      warnings: evaluateW1APerformanceWarnings(performance),
    });
  }

  async shutdown() {
    if (this.isShutdown) return;
    await this.transitionChain;
    for (const key of sortedKeys(this.renderedKeys)) {
      const startedAt = this.clock();
      await this.renderAdapter.unloadChunk(key);
      this.performance.record('unload', this.clock() - startedAt);
      this.counts.renderUnloaded += 1;
    }
    this.renderedKeys.clear();
    this.activeDataKeys.clear();
    this.cache.clear();
    await this.renderAdapter.shutdown();
    this.isShutdown = true;
  }
}
