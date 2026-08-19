import {
  CHUNK_DATA_PRIORITY,
  createCanonicalTreeCellRequestKey,
  createChunkGeneratorSchedulerEnvelope,
} from './chunk-data-service-protocol.js';
import { createW8ForestHorizonManifest } from './forest-horizon-manifest.js';
import {
  createWorldGenerationScheduler,
  WORLD_GENERATION_STATE,
} from './world-generation-scheduler.js';

/**
 * Stage 2B-0 transport.  It deliberately has the same small surface that the
 * module Worker transport will implement in Stage 2B-1.
 */
export function createInlineChunkGeneratorTransport({
  generator,
  clock = () => globalThis.performance?.now?.() ?? Date.now(),
  schedulerOptions = null,
  onSchedulerEvent = null,
} = {}) {
  if (typeof generator?.generateChunk !== 'function') {
    throw new TypeError('generator.generateChunk is required');
  }
  let isShutdown = false;
  let generatedCount = 0;
  let forestHorizonGeneratedCount = 0;
  let presentationOwnerGeneratedCount = 0;
  let canonicalTreeCellGeneratedCount = 0;
  let canonicalMajorRoadOwnerQueryCount = 0;
  let initialized = false;
  let diagnosticRequestCount = 0;
  let lastGeneratorSnapshot = null;
  let shutdownPromise = null;
  let controlRequestId = 1_000_000_000;
  const forestHorizonCancelledBeforeEpoch = new Map();
  const scheduler = createWorldGenerationScheduler({
    clock,
    onEvent: onSchedulerEvent,
    ...(schedulerOptions ?? {}),
  });

  const metadata = () => Object.freeze({
    worldSeed: generator.worldSeed,
    worldSeedHash: generator.worldSeedHash,
    generatorVersion: generator.generatorVersion,
    experienceSpawn: generator.experienceSpawn,
    reviewSpawn: generator.reviewSpawn,
  });

  const runOperation = ({ envelope, operation, onCancel = null }) => {
    if (isShutdown) return Promise.reject(new Error('inline ChunkData transport is shut down'));
    const handle = scheduler.schedule({ envelope, execute: operation, onCancel });
    return handle.promise.then(result => {
      if (result.state === WORLD_GENERATION_STATE.COMPLETED) return result.value;
      if (result.state === WORLD_GENERATION_STATE.CANCELLED) return null;
      throw result.error;
    });
  };

  return Object.freeze({
    async initialize() {
      if (isShutdown) throw new Error('inline ChunkData transport is shut down');
      initialized = true;
      return metadata();
    },
    async generateChunk({
      requestId = ++controlRequestId,
      chunkX,
      chunkZ,
      priority = CHUNK_DATA_PRIORITY.GAMEPLAY_REQUIRED,
      required = priority <= CHUNK_DATA_PRIORITY.GAMEPLAY_REQUIRED,
      createdAtMs = clock(),
      deadlineAtMs = null,
      consumerId = 'chunk-data-service',
      epoch = 0,
      telemetryCorrelationId = null,
      telemetryTarget = null,
      telemetryStream = null,
      scheduler: suppliedScheduler = null,
    } = {}) {
      const envelope = createChunkGeneratorSchedulerEnvelope({
        requestId,
        operationKind: 'chunk',
        priority,
        required,
        createdAtMs,
        deadlineAtMs,
        consumerId,
        epoch,
        correlationId: telemetryCorrelationId,
        target: telemetryTarget,
        stream: telemetryStream,
        scheduler: suppliedScheduler,
      });
      return runOperation({ envelope, operation: execution => {
        generatedCount += 1;
        return generator.generateChunk(chunkX, chunkZ, {
          requestId,
          priority,
          scheduler: envelope,
          checkpoint: execution.checkpoint,
        });
      } });
    },
    async generateForestHorizonManifest({
      chunkX,
      chunkZ,
      consumerId = 'distant-owner-query',
      epoch = 0,
      priority = CHUNK_DATA_PRIORITY.DISTANT_OWNER,
      required = false,
      createdAtMs = clock(),
      deadlineAtMs = null,
      telemetryCorrelationId = null,
      telemetryTarget = 'tree',
      telemetryStream = 'distant',
      scheduler: suppliedScheduler = null,
    } = {}) {
      if (epoch < (forestHorizonCancelledBeforeEpoch.get(consumerId) ?? 0)) return null;
      const requestId = ++controlRequestId;
      const envelope = createChunkGeneratorSchedulerEnvelope({
        requestId,
        operationKind: 'forest-horizon',
        priority,
        required,
        createdAtMs,
        deadlineAtMs,
        consumerId,
        epoch,
        correlationId: telemetryCorrelationId,
        target: telemetryTarget,
        stream: telemetryStream,
        scheduler: suppliedScheduler,
      });
      return runOperation({ envelope, operation: async execution => {
        forestHorizonGeneratedCount += 1;
        if (typeof generator.generateForestHorizonManifest === 'function') {
          return generator.generateForestHorizonManifest(chunkX, chunkZ, {
            scheduler: envelope,
            checkpoint: execution.checkpoint,
          });
        }
        return createW8ForestHorizonManifest(await generator.generateChunk(chunkX, chunkZ, {
          scheduler: envelope,
          checkpoint: execution.checkpoint,
        }));
      } });
    },
    async generatePresentationOwner({
      chunkX,
      chunkZ,
      priority = CHUNK_DATA_PRIORITY.DISTANT_OWNER,
      required = true,
      createdAtMs = clock(),
      deadlineAtMs = null,
      consumerId = 'presentation-owner-service',
      epoch = 0,
      telemetryCorrelationId = null,
      telemetryTarget = 'distant',
      telemetryStream = 'distant',
      scheduler: suppliedScheduler = null,
    } = {}) {
      if (typeof generator.generatePresentationOwner !== 'function') {
        throw new Error('generator does not expose PresentationOwner generation');
      }
      const requestId = ++controlRequestId;
      const envelope = createChunkGeneratorSchedulerEnvelope({
        requestId,
        operationKind: 'presentation-owner',
        priority,
        required,
        createdAtMs,
        deadlineAtMs,
        consumerId,
        epoch,
        correlationId: telemetryCorrelationId,
        target: telemetryTarget,
        stream: telemetryStream,
        scheduler: suppliedScheduler === null ? null : {
          ...suppliedScheduler,
          requestId,
          operationKind: 'presentation-owner',
        },
      });
      return runOperation({ envelope, operation: execution => {
        presentationOwnerGeneratedCount += 1;
        return generator.generatePresentationOwner(chunkX, chunkZ, {
          scheduler: envelope,
          checkpoint: execution.checkpoint,
        });
      } });
    },
    async generateCanonicalTreeCell({
      macroX,
      macroZ,
      priority = CHUNK_DATA_PRIORITY.DISTANT_OWNER,
      required = true,
      createdAtMs = clock(),
      deadlineAtMs = null,
      consumerId = 'macro-coarse-world',
      epoch = 0,
      telemetryCorrelationId = null,
      telemetryTarget = 'tree',
      telemetryStream = 'distant',
      scheduler: suppliedScheduler = null,
    } = {}) {
      if (typeof generator.generateCanonicalTreeCell !== 'function') {
        throw new Error('generator does not expose canonical Tree-cell generation');
      }
      const key = createCanonicalTreeCellRequestKey(macroX, macroZ);
      const requestId = ++controlRequestId;
      const envelope = createChunkGeneratorSchedulerEnvelope({
        requestId,
        operationKind: 'canonical-tree-cell',
        priority,
        required,
        createdAtMs,
        deadlineAtMs,
        ownerKey: key,
        resourceKind: 'canonical-tree-cell',
        representationClass: 'coarse',
        consumerId,
        epoch,
        correlationId: telemetryCorrelationId,
        target: telemetryTarget,
        stream: telemetryStream,
        scheduler: suppliedScheduler === null ? null : {
          ...suppliedScheduler,
          requestId,
          operationKind: 'canonical-tree-cell',
          ownerKey: key,
          resourceKind: 'canonical-tree-cell',
          representationClass: 'coarse',
        },
      });
      return runOperation({ envelope, operation: execution => {
        canonicalTreeCellGeneratedCount += 1;
        return generator.generateCanonicalTreeCell(macroX, macroZ, {
          scheduler: envelope,
          checkpoint: execution.checkpoint,
        });
      } });
    },
    cancelForestHorizonRequests({
      consumerId = 'distant-owner-query',
      epoch = null,
      beforeEpoch = null,
    } = {}) {
      const cutoff = Number.isSafeInteger(beforeEpoch)
        ? beforeEpoch
        : Number.isSafeInteger(epoch) ? epoch + 1 : Number.MAX_SAFE_INTEGER;
      forestHorizonCancelledBeforeEpoch.set(
        consumerId,
        Math.max(forestHorizonCancelledBeforeEpoch.get(consumerId) ?? 0, cutoff),
      );
      return scheduler.cancelWhere(envelope => (
        envelope.operationKind === 'forest-horizon'
        && envelope.consumerId === consumerId
        && envelope.epoch < cutoff
      ), 'stale-forest-horizon-epoch');
    },
    cancelGenerationRequest({ requestId, reason = 'consumer-cancelled' } = {}) {
      return scheduler.cancel({ requestId, reason });
    },
    findSettlementsNear(centerWorldX, centerWorldZ, radiusMeters, options = {}) {
      const requestId = ++controlRequestId;
      const envelope = createChunkGeneratorSchedulerEnvelope({
        requestId,
        operationKind: 'settlement-query',
        priority: options.priority ?? CHUNK_DATA_PRIORITY.GAMEPLAY_REQUIRED,
        required: options.required ?? true,
        createdAtMs: options.createdAtMs ?? clock(),
        deadlineAtMs: options.deadlineAtMs ?? null,
        consumerId: options.consumerId ?? 'settlement-query',
        correlationId: options.telemetryCorrelationId ?? null,
        target: options.telemetryTarget ?? 'settlement',
        stream: options.telemetryStream ?? 'distant',
        scheduler: options.scheduler ?? null,
      });
      return runOperation({ envelope, operation: () => generator.distributor.findSettlementsNear(
        centerWorldX, centerWorldZ, radiusMeters,
      ) });
    },
    resolveSettlementPresentationTemplate({ candidate, ...options } = {}) {
      const requestId = ++controlRequestId;
      const envelope = createChunkGeneratorSchedulerEnvelope({
        requestId,
        operationKind: 'settlement-template',
        priority: options.priority ?? CHUNK_DATA_PRIORITY.PLAYER_RENDER,
        required: options.required ?? true,
        createdAtMs: options.createdAtMs ?? clock(),
        deadlineAtMs: options.deadlineAtMs ?? null,
        consumerId: options.consumerId ?? 'settlement-template',
        correlationId: options.telemetryCorrelationId ?? null,
        target: options.telemetryTarget ?? 'building',
        stream: options.telemetryStream ?? 'distant',
        scheduler: options.scheduler ?? null,
      });
      return runOperation({ envelope, operation: () => {
        if (typeof generator.resolveSettlementPresentationTemplate !== 'function') {
          throw new Error('Chunk generator does not expose Settlement presentation templates');
        }
        return generator.resolveSettlementPresentationTemplate({ candidate });
      } });
    },
    resolveCanonicalMajorRoadOwnerCoverage({
      centerWorldX,
      centerWorldZ,
      radiusMeters,
      ...options
    } = {}) {
      const requestId = ++controlRequestId;
      const envelope = createChunkGeneratorSchedulerEnvelope({
        requestId,
        operationKind: 'canonical-major-road-owner-query',
        priority: options.priority ?? CHUNK_DATA_PRIORITY.GAMEPLAY_REQUIRED,
        required: options.required ?? true,
        createdAtMs: options.createdAtMs ?? clock(),
        deadlineAtMs: options.deadlineAtMs ?? null,
        consumerId: options.consumerId ?? 'canonical-major-road-owner-query',
        correlationId: options.telemetryCorrelationId ?? null,
        target: options.telemetryTarget ?? 'road',
        stream: options.telemetryStream ?? 'distant',
        scheduler: options.scheduler ?? null,
      });
      return runOperation({ envelope, operation: async execution => {
        if (typeof generator.resolveCanonicalMajorRoadOwnerCoverage !== 'function') {
          throw new Error('Chunk generator does not expose canonical MAJOR Road owner coverage');
        }
        canonicalMajorRoadOwnerQueryCount += 1;
        const coverage = await generator.resolveCanonicalMajorRoadOwnerCoverage({
          centerWorldX,
          centerWorldZ,
          radiusMeters,
        });
        execution.checkpoint();
        return coverage;
      } });
    },
    requestDiagnostics(options = {}) {
      const requestId = ++controlRequestId;
      const envelope = createChunkGeneratorSchedulerEnvelope({
        requestId,
        operationKind: 'diagnostics',
        priority: options.priority ?? CHUNK_DATA_PRIORITY.ULTRA_WARM,
        required: false,
        createdAtMs: options.createdAtMs ?? clock(),
        deadlineAtMs: options.deadlineAtMs ?? null,
        consumerId: 'diagnostics',
        scheduler: options.scheduler ?? null,
      });
      return runOperation({ envelope, operation: async () => {
        diagnosticRequestCount += 1;
        lastGeneratorSnapshot = await generator.snapshot?.() ?? null;
        return lastGeneratorSnapshot;
      } });
    },
    snapshot() {
      return Object.freeze({
        kind: 'inline', generatedCount, forestHorizonGeneratedCount,
        presentationOwnerGeneratedCount, canonicalTreeCellGeneratedCount,
        canonicalMajorRoadOwnerQueryCount,
        diagnosticRequestCount, initialized, isShutdown,
        scheduler: scheduler.snapshot(),
        generatorSnapshot: lastGeneratorSnapshot,
      });
    },
    async shutdown() {
      if (shutdownPromise) return shutdownPromise;
      isShutdown = true;
      shutdownPromise = (async () => {
        await scheduler.shutdown({
          reason: 'inline-transport-shutdown',
          cancelInFlight: false,
        });
        try {
          await generator.shutdown?.();
        } finally {
          generator = null;
          lastGeneratorSnapshot = null;
          forestHorizonCancelledBeforeEpoch.clear();
        }
      })();
      return shutdownPromise;
    },
  });
}
