import { createW8ParityChunkGenerator } from './w8-parity-chunk-generator.js';
import {
  CHUNK_DATA_PRIORITY,
  CHUNK_GENERATOR_MESSAGE,
  CHUNK_GENERATOR_PROTOCOL_VERSION,
  createChunkDataRequestKey,
} from './chunk-data-service-protocol.js';
import { createW8ForestHorizonManifest } from './forest-horizon-manifest.js';
import { createChunkGenerationStageRecorder } from './chunk-generation-stage-timing.js';
import { createRoadGenerationTimingRecorder } from './road-generation-timing.js';
import {
  createWorldGenerationScheduler,
  isWorldGenerationCancellation,
  normalizeWorldGenerationRequestEnvelope,
} from './world-generation-scheduler.js';

function clock() {
  return globalThis.performance?.now?.() ?? Date.now();
}

function clockOrigin() {
  const value = globalThis.performance?.timeOrigin;
  return Number.isFinite(value) ? value : Date.now() - clock();
}

function pipelineTiming(
  request,
  generationStartedAtMs,
  generationCompletedAtMs,
  responseSentAtMs = clock(),
  requestReceivedAtMs = null,
) {
  if (request?.pipelineDiagnostics !== true) return {};
  return {
    pipelineTiming: Object.freeze({
      workerTimeOriginMs: clockOrigin(),
      requestReceivedAtMs,
      generationStartedAtMs,
      generationCompletedAtMs,
      responseSentAtMs,
    }),
  };
}

function generatorMetadata(generator) {
  return Object.freeze({
    worldSeed: generator.worldSeed,
    worldSeedHash: generator.worldSeedHash,
    generatorVersion: generator.generatorVersion,
    experienceSpawn: generator.experienceSpawn,
    reviewSpawn: generator.reviewSpawn,
  });
}

function errorResponse(error, request) {
  return {
    type: CHUNK_GENERATOR_MESSAGE.ERROR,
    protocolVersion: CHUNK_GENERATOR_PROTOCOL_VERSION,
    requestId: request?.requestId ?? null,
    serviceGeneration: request?.serviceGeneration ?? null,
    name: error?.name ?? 'Error',
    message: error?.message ?? String(error),
    recoverable: false,
  };
}

export function createChunkGeneratorWorkerCore({
  postMessage,
  generatorFactory = createW8ParityChunkGenerator,
  schedulerOptions = null,
} = {}) {
  if (typeof postMessage !== 'function') throw new TypeError('postMessage is required');
  let generator = null;
  let serviceGeneration = 0;
  let isShutdown = false;
  let roadTimingRecorder = null;
  const forestHorizonCancelledBeforeEpoch = new Map();
  const scheduler = createWorldGenerationScheduler({
    clock,
    ...(schedulerOptions ?? {}),
  });

  const schedulerDefaults = request => {
    if (request.type === CHUNK_GENERATOR_MESSAGE.GENERATE) {
      return {
        requestId: request.requestId,
        operationKind: 'chunk',
        priority: CHUNK_DATA_PRIORITY.GAMEPLAY_REQUIRED,
        required: true,
        createdAtMs: clock(),
        consumerId: 'chunk-data-service',
      };
    }
    if (request.type === CHUNK_GENERATOR_MESSAGE.GENERATE_FOREST_HORIZON) {
      return {
        requestId: request.requestId,
        operationKind: 'forest-horizon',
        priority: CHUNK_DATA_PRIORITY.DISTANT_OWNER,
        required: false,
        createdAtMs: clock(),
        consumerId: request.consumerId,
        epoch: request.epoch,
        target: 'tree',
        stream: 'distant',
      };
    }
    if (request.type === CHUNK_GENERATOR_MESSAGE.FIND_SETTLEMENTS) {
      return {
        requestId: request.requestId,
        operationKind: 'settlement-query',
        priority: CHUNK_DATA_PRIORITY.GAMEPLAY_REQUIRED,
        required: true,
        createdAtMs: clock(),
        consumerId: 'settlement-query',
        target: 'settlement',
        stream: 'distant',
      };
    }
    if (request.type === CHUNK_GENERATOR_MESSAGE.RESOLVE_SETTLEMENT_TEMPLATE) {
      return {
        requestId: request.requestId,
        operationKind: 'settlement-template',
        priority: CHUNK_DATA_PRIORITY.PLAYER_RENDER,
        required: true,
        createdAtMs: clock(),
        consumerId: 'settlement-template',
        target: 'building',
        stream: 'distant',
      };
    }
    return {
      requestId: request.requestId,
      operationKind: 'diagnostics',
      priority: CHUNK_DATA_PRIORITY.ULTRA_WARM,
      required: false,
      createdAtMs: clock(),
      consumerId: 'diagnostics',
    };
  };

  const schedulerResponse = (execution, requestReceivedAtMs = null) => Object.freeze({
    schemaVersion: execution.envelope.schemaVersion,
    operationKind: execution.envelope.operationKind,
    priority: execution.envelope.priority,
    effectivePriority: execution.effectivePriority,
    required: execution.envelope.required,
    deadlineAtMs: execution.envelope.deadlineAtMs,
    startedAtMs: execution.startedAtMs,
    queueTimeMs: execution.queueTimeMs,
    workerReceivedAtMs: requestReceivedAtMs,
    workerQueueResidentMs: Number.isFinite(requestReceivedAtMs)
      ? Math.max(0, execution.startedAtMs - requestReceivedAtMs) : null,
    priorityAgingSteps: execution.priorityAgingSteps,
    deadlineMiss: execution.deadlineMiss,
    backlogAtStart: execution.backlogAtStart,
  });

  const createRoadTimingContext = (request, execution) => {
    if (request.pipelineDiagnostics !== true) return null;
    roadTimingRecorder ??= createRoadGenerationTimingRecorder();
    return {
      recorder: roadTimingRecorder,
      deadlineAtMs: execution?.envelope?.deadlineAtMs ?? null,
      deadlineMissAtStart: execution?.deadlineMiss === true,
      cold: false,
      run: null,
      completedRun: null,
    };
  };

  const postGenerationResponse = ({
    request,
    response,
    execution,
    requestReceivedAtMs,
    generationStartedAtMs,
    generationCompletedAtMs,
    stageRecorder,
    roadTimingContext,
  }) => {
    if (request.pipelineDiagnostics !== true) {
      postMessage(response);
      return;
    }
    const responsePostStartedAtMs = clock();
    postMessage({
      ...response,
      ...pipelineTiming(
        request,
        generationStartedAtMs,
        generationCompletedAtMs,
        responsePostStartedAtMs,
        requestReceivedAtMs,
      ),
    });
    const responsePostCompletedAtMs = clock();
    postMessage({
      type: CHUNK_GENERATOR_MESSAGE.PIPELINE_TIMING,
      protocolVersion: CHUNK_GENERATOR_PROTOCOL_VERSION,
      requestId: request.requestId,
      serviceGeneration,
      chunkKey: createChunkDataRequestKey(request.chunkX, request.chunkZ),
      operationKind: request.scheduler?.operationKind ?? null,
      workerTimeOriginMs: clockOrigin(),
      requestReceivedAtMs,
      generationStartedAtMs,
      generationCompletedAtMs,
      generationTotalMs: Math.max(0, generationCompletedAtMs - generationStartedAtMs),
      responsePostStartedAtMs,
      responsePostCompletedAtMs,
      postMessageCallMs: Math.max(0, responsePostCompletedAtMs - responsePostStartedAtMs),
      stageTiming: stageRecorder?.snapshot() ?? null,
      roadTiming: roadTimingContext?.completedRun ?? null,
      roadTimingSummary: roadTimingContext?.recorder?.snapshot() ?? null,
      scheduler: execution ? schedulerResponse(execution, requestReceivedAtMs) : null,
    });
  };

  const processMessage = async (request, execution = null, requestReceivedAtMs = null) => {
    if (isShutdown) return;
    try {
      if (request?.protocolVersion !== CHUNK_GENERATOR_PROTOCOL_VERSION) {
        throw new Error(`unsupported Chunk generator protocol: ${request?.protocolVersion}`);
      }
      if (request.type === CHUNK_GENERATOR_MESSAGE.INITIALIZE) {
        generator = await generatorFactory({
          worldSeed: request.worldSeed,
          ...(request.settlementRoadGraphGeneratorId
            ? { settlementRoadGraphGeneratorId: request.settlementRoadGraphGeneratorId }
            : {}),
        });
        serviceGeneration = request.serviceGeneration;
        postMessage({
          type: CHUNK_GENERATOR_MESSAGE.INITIALIZED,
          protocolVersion: CHUNK_GENERATOR_PROTOCOL_VERSION,
          serviceGeneration,
          metadata: generatorMetadata(generator),
        });
        return;
      }
      if (!generator || request.serviceGeneration !== serviceGeneration) return;
      execution?.checkpoint();
      if (request.type === CHUNK_GENERATOR_MESSAGE.GENERATE) {
        const stageRecorder = request.pipelineDiagnostics === true
          ? createChunkGenerationStageRecorder() : null;
        const roadTimingContext = createRoadTimingContext(request, execution);
        const startedAt = clock();
        const chunkData = await generator.generateChunk(request.chunkX, request.chunkZ, {
          scheduler: execution?.envelope ?? null,
          checkpoint: execution?.checkpoint ?? null,
          ...(stageRecorder ? { stageRecorder } : {}),
          ...(roadTimingContext ? { roadTimingContext } : {}),
        });
        execution?.checkpoint();
        const completedAt = clock();
        postGenerationResponse({
          request,
          execution,
          requestReceivedAtMs,
          generationStartedAtMs: startedAt,
          generationCompletedAtMs: completedAt,
          stageRecorder,
          roadTimingContext,
          response: {
          type: CHUNK_GENERATOR_MESSAGE.GENERATED,
          protocolVersion: CHUNK_GENERATOR_PROTOCOL_VERSION,
          requestId: request.requestId,
          serviceGeneration,
          chunkKey: createChunkDataRequestKey(request.chunkX, request.chunkZ),
          chunkId: chunkData.chunkId,
          contentHash: chunkData.contentHash,
          chunkData,
          generationMs: Math.max(0, completedAt - startedAt),
          scheduler: execution ? schedulerResponse(execution, requestReceivedAtMs) : null,
          },
        });
        return;
      }
      if (request.type === CHUNK_GENERATOR_MESSAGE.GENERATE_FOREST_HORIZON) {
        if (request.epoch < (forestHorizonCancelledBeforeEpoch.get(request.consumerId) ?? 0)) {
          return;
        }
        const stageRecorder = request.pipelineDiagnostics === true
          ? createChunkGenerationStageRecorder() : null;
        const roadTimingContext = createRoadTimingContext(request, execution);
        const startedAt = clock();
        const manifest = typeof generator.generateForestHorizonManifest === 'function'
          ? await generator.generateForestHorizonManifest(request.chunkX, request.chunkZ, {
            scheduler: execution?.envelope ?? null,
            checkpoint: execution?.checkpoint ?? null,
            ...(stageRecorder ? { stageRecorder } : {}),
            ...(roadTimingContext ? { roadTimingContext } : {}),
          })
          : createW8ForestHorizonManifest(
            await generator.generateChunk(request.chunkX, request.chunkZ, {
              scheduler: execution?.envelope ?? null,
              checkpoint: execution?.checkpoint ?? null,
              ...(stageRecorder ? { stageRecorder } : {}),
              ...(roadTimingContext ? { roadTimingContext } : {}),
            }),
          );
        execution?.checkpoint();
        const completedAt = clock();
        postGenerationResponse({
          request,
          execution,
          requestReceivedAtMs,
          generationStartedAtMs: startedAt,
          generationCompletedAtMs: completedAt,
          stageRecorder,
          roadTimingContext,
          response: {
          type: CHUNK_GENERATOR_MESSAGE.GENERATED_FOREST_HORIZON,
          protocolVersion: CHUNK_GENERATOR_PROTOCOL_VERSION,
          requestId: request.requestId,
          serviceGeneration,
          chunkKey: createChunkDataRequestKey(request.chunkX, request.chunkZ),
          chunkId: manifest.chunkId,
          contentHash: manifest.contentHash,
          manifest,
          generationMs: Math.max(0, completedAt - startedAt),
          scheduler: execution ? schedulerResponse(execution, requestReceivedAtMs) : null,
          },
        });
        return;
      }
      if (request.type === CHUNK_GENERATOR_MESSAGE.FIND_SETTLEMENTS) {
        const startedAt = clock();
        const settlements = await generator.distributor.findSettlementsNear(
          request.centerWorldX,
          request.centerWorldZ,
          request.radiusMeters,
        );
        execution?.checkpoint();
        const completedAt = clock();
        postMessage({
          type: CHUNK_GENERATOR_MESSAGE.SETTLEMENTS,
          protocolVersion: CHUNK_GENERATOR_PROTOCOL_VERSION,
          requestId: request.requestId,
          serviceGeneration,
          settlements,
          operationMs: Math.max(0, completedAt - startedAt),
          scheduler: execution ? schedulerResponse(execution) : null,
          ...pipelineTiming(request, startedAt, completedAt),
        });
        return;
      }
      if (request.type === CHUNK_GENERATOR_MESSAGE.RESOLVE_SETTLEMENT_TEMPLATE) {
        if (typeof generator.resolveSettlementPresentationTemplate !== 'function') {
          throw new Error('Chunk generator does not expose Settlement presentation templates');
        }
        const startedAt = clock();
        const template = await generator.resolveSettlementPresentationTemplate({
          candidate: request.candidate,
        });
        execution?.checkpoint();
        const completedAt = clock();
        postMessage({
          type: CHUNK_GENERATOR_MESSAGE.SETTLEMENT_TEMPLATE,
          protocolVersion: CHUNK_GENERATOR_PROTOCOL_VERSION,
          requestId: request.requestId,
          serviceGeneration,
          template,
          operationMs: Math.max(0, completedAt - startedAt),
          scheduler: execution ? schedulerResponse(execution) : null,
          ...pipelineTiming(request, startedAt, completedAt),
        });
        return;
      }
      if (request.type === CHUNK_GENERATOR_MESSAGE.REQUEST_DIAGNOSTICS) {
        const startedAt = clock();
        const generatorSnapshot = await generator.snapshot?.() ?? null;
        execution?.checkpoint();
        const completedAt = clock();
        postMessage({
          type: CHUNK_GENERATOR_MESSAGE.DIAGNOSTICS,
          protocolVersion: CHUNK_GENERATOR_PROTOCOL_VERSION,
          requestId: request.requestId,
          serviceGeneration,
          generatorSnapshot,
          workerSchedulerSnapshot: scheduler.snapshot(),
          operationMs: Math.max(0, completedAt - startedAt),
          scheduler: execution ? schedulerResponse(execution) : null,
          ...pipelineTiming(request, startedAt, completedAt),
        });
        return;
      }
      throw new Error(`unknown Chunk generator message: ${request.type}`);
    } catch (error) {
      if (isWorldGenerationCancellation(error)) throw error;
      postMessage(errorResponse(error, request));
    }
  };

  return Object.freeze({
    receive(request) {
      const requestReceivedAtMs = clock();
      if (request?.type === CHUNK_GENERATOR_MESSAGE.CANCEL_GENERATION
        && request.protocolVersion === CHUNK_GENERATOR_PROTOCOL_VERSION
        && request.serviceGeneration === serviceGeneration) {
        scheduler.cancel({ requestId: request.requestId, reason: request.reason });
        return Promise.resolve();
      }
      if (request?.type === CHUNK_GENERATOR_MESSAGE.CANCEL_FOREST_HORIZON
        && request.protocolVersion === CHUNK_GENERATOR_PROTOCOL_VERSION) {
        const beforeEpoch = Number.isSafeInteger(request.beforeEpoch)
          ? request.beforeEpoch : Number.MAX_SAFE_INTEGER;
        forestHorizonCancelledBeforeEpoch.set(
          request.consumerId,
          Math.max(
            forestHorizonCancelledBeforeEpoch.get(request.consumerId) ?? 0,
            beforeEpoch,
          ),
        );
        scheduler.cancelWhere(envelope => (
          envelope.operationKind === 'forest-horizon'
          && envelope.consumerId === request.consumerId
          && envelope.epoch < beforeEpoch
        ), 'stale-forest-horizon-epoch');
        return Promise.resolve();
      }
      if (request?.type === CHUNK_GENERATOR_MESSAGE.INITIALIZE) {
        return processMessage(request, null, requestReceivedAtMs);
      }
      if (!request || request.protocolVersion !== CHUNK_GENERATOR_PROTOCOL_VERSION) {
        return processMessage(request, null, requestReceivedAtMs);
      }
      const envelope = normalizeWorldGenerationRequestEnvelope(
        request.scheduler,
        schedulerDefaults(request),
      );
      const handle = scheduler.schedule({
        envelope,
        execute: execution => processMessage(request, execution, requestReceivedAtMs),
      });
      return handle.promise.then(() => undefined);
    },
    async shutdown() {
      isShutdown = true;
      await scheduler.shutdown({ reason: 'worker-core-shutdown', cancelInFlight: false });
      await generator?.shutdown?.();
      generator = null;
      forestHorizonCancelledBeforeEpoch.clear();
    },
  });
}
