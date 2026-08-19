import { createW8ParityChunkGenerator } from './w8-parity-chunk-generator.js';
import {
  CHUNK_DATA_PRIORITY,
  CHUNK_GENERATOR_MESSAGE,
  CHUNK_GENERATOR_PROTOCOL_VERSION,
  createCanonicalTreeCellRequestKey,
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

const WORKER_SCHEDULER_CLOCK_SCHEMA = 'worker-scheduler-clock-1';

function clock() {
  return globalThis.performance?.now?.() ?? Date.now();
}

function clockOrigin() {
  const value = globalThis.performance?.timeOrigin;
  return Number.isFinite(value) ? value : Date.now() - clock();
}

function rebaseSchedulerEnvelope(envelope, schedulerClock, receivedAtMs) {
  if (schedulerClock?.schemaVersion !== WORKER_SCHEDULER_CLOCK_SCHEMA
    || !Number.isFinite(schedulerClock.sentAtMs)
    || !Number.isFinite(receivedAtMs)) return envelope;
  const offsetMs = receivedAtMs - schedulerClock.sentAtMs;
  const translatedTime = value => {
    if (value === null) return null;
    const translated = value + offsetMs;
    // World-generation timestamps are non-negative by contract. An old
    // request can predate a very young Worker clock; zero preserves its
    // already-aged/already-missed status without comparing clock origins.
    return Math.max(0, translated);
  };
  return normalizeWorldGenerationRequestEnvelope({
    ...envelope,
    createdAtMs: translatedTime(envelope.createdAtMs),
    deadlineAtMs: translatedTime(envelope.deadlineAtMs),
    firstVisibleDeadlineMs: translatedTime(envelope.firstVisibleDeadlineMs),
  });
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

function generationRequestKey(request) {
  if (request?.type === CHUNK_GENERATOR_MESSAGE.GENERATE_CANONICAL_TREE_CELL) {
    return createCanonicalTreeCellRequestKey(request.macroX, request.macroZ);
  }
  return createChunkDataRequestKey(request.chunkX, request.chunkZ);
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
  const schedulerClock = schedulerOptions?.clock ?? clock;
  const scheduler = createWorldGenerationScheduler({
    ...(schedulerOptions ?? {}),
    clock: schedulerClock,
  });

  const schedulerDefaults = request => {
    if (request.type === CHUNK_GENERATOR_MESSAGE.GENERATE) {
      return {
        requestId: request.requestId,
        operationKind: 'chunk',
        priority: CHUNK_DATA_PRIORITY.GAMEPLAY_REQUIRED,
        required: true,
        createdAtMs: schedulerClock(),
        consumerId: 'chunk-data-service',
      };
    }
    if (request.type === CHUNK_GENERATOR_MESSAGE.GENERATE_FOREST_HORIZON) {
      return {
        requestId: request.requestId,
        operationKind: 'forest-horizon',
        priority: CHUNK_DATA_PRIORITY.DISTANT_OWNER,
        required: false,
        createdAtMs: schedulerClock(),
        consumerId: request.consumerId,
        epoch: request.epoch,
        target: 'tree',
        stream: 'distant',
      };
    }
    if (request.type === CHUNK_GENERATOR_MESSAGE.GENERATE_PRESENTATION_OWNER) {
      return {
        requestId: request.requestId,
        operationKind: 'presentation-owner',
        priority: CHUNK_DATA_PRIORITY.DISTANT_OWNER,
        required: true,
        createdAtMs: schedulerClock(),
        consumerId: 'presentation-owner-service',
        target: 'distant',
        stream: 'distant',
      };
    }
    if (request.type === CHUNK_GENERATOR_MESSAGE.GENERATE_CANONICAL_TREE_CELL) {
      return {
        requestId: request.requestId,
        operationKind: 'canonical-tree-cell',
        priority: CHUNK_DATA_PRIORITY.DISTANT_OWNER,
        required: true,
        createdAtMs: schedulerClock(),
        ownerKey: createCanonicalTreeCellRequestKey(request.macroX, request.macroZ),
        resourceKind: 'canonical-tree-cell',
        representationClass: 'coarse',
        consumerId: 'macro-coarse-world',
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
        createdAtMs: schedulerClock(),
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
        createdAtMs: schedulerClock(),
        consumerId: 'settlement-template',
        target: 'building',
        stream: 'distant',
      };
    }
    if (request.type === CHUNK_GENERATOR_MESSAGE.RESOLVE_CANONICAL_MAJOR_ROAD_OWNERS) {
      return {
        requestId: request.requestId,
        operationKind: 'canonical-major-road-owner-query',
        priority: CHUNK_DATA_PRIORITY.GAMEPLAY_REQUIRED,
        required: true,
        createdAtMs: schedulerClock(),
        consumerId: 'canonical-major-road-owner-query',
        target: 'road',
        stream: 'distant',
      };
    }
    return {
      requestId: request.requestId,
      operationKind: 'diagnostics',
      priority: CHUNK_DATA_PRIORITY.ULTRA_WARM,
      required: false,
      createdAtMs: schedulerClock(),
      consumerId: 'diagnostics',
    };
  };

  const schedulerResponse = (
    execution,
    requestReceivedAtMs = null,
    schedulerReceivedAtMs = requestReceivedAtMs,
    sourceScheduler = null,
  ) => Object.freeze({
    schemaVersion: execution.envelope.schemaVersion,
    operationKind: execution.envelope.operationKind,
    priority: execution.envelope.priority,
    effectivePriority: execution.effectivePriority,
    required: execution.envelope.required,
    // Keep the public response in the source protocol domain. Only the
    // Worker's private scheduling envelope is translated.
    deadlineAtMs: sourceScheduler?.deadlineAtMs ?? execution.envelope.deadlineAtMs,
    startedAtMs: execution.startedAtMs,
    queueTimeMs: execution.queueTimeMs,
    workerReceivedAtMs: requestReceivedAtMs,
    workerQueueResidentMs: Number.isFinite(schedulerReceivedAtMs)
      ? Math.max(0, execution.startedAtMs - schedulerReceivedAtMs) : null,
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
    schedulerReceivedAtMs,
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
      chunkKey: generationRequestKey(request),
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
      scheduler: execution ? schedulerResponse(
        execution,
        requestReceivedAtMs,
        schedulerReceivedAtMs,
        request.scheduler,
      ) : null,
    });
  };

  const processMessage = async (
    request,
    execution = null,
    requestReceivedAtMs = null,
    schedulerReceivedAtMs = requestReceivedAtMs,
  ) => {
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
          ...(request.settlementLotMode
            ? { settlementLotMode: request.settlementLotMode }
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
          schedulerReceivedAtMs,
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
          scheduler: execution ? schedulerResponse(
            execution,
            requestReceivedAtMs,
            schedulerReceivedAtMs,
            request.scheduler,
          ) : null,
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
          schedulerReceivedAtMs,
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
          scheduler: execution ? schedulerResponse(
            execution,
            requestReceivedAtMs,
            schedulerReceivedAtMs,
            request.scheduler,
          ) : null,
          },
        });
        return;
      }
      if (request.type === CHUNK_GENERATOR_MESSAGE.GENERATE_PRESENTATION_OWNER) {
        if (typeof generator.generatePresentationOwner !== 'function') {
          throw new Error('Chunk generator does not expose PresentationOwner generation');
        }
        const startedAt = clock();
        const presentationOwner = await generator.generatePresentationOwner(
          request.chunkX,
          request.chunkZ,
        );
        execution?.checkpoint();
        const completedAt = clock();
        postGenerationResponse({
          request,
          execution,
          requestReceivedAtMs,
          schedulerReceivedAtMs,
          generationStartedAtMs: startedAt,
          generationCompletedAtMs: completedAt,
          stageRecorder: null,
          roadTimingContext: null,
          response: {
            type: CHUNK_GENERATOR_MESSAGE.GENERATED_PRESENTATION_OWNER,
            protocolVersion: CHUNK_GENERATOR_PROTOCOL_VERSION,
            requestId: request.requestId,
            serviceGeneration,
            chunkKey: createChunkDataRequestKey(request.chunkX, request.chunkZ),
            chunkId: presentationOwner.chunkId,
            contentHash: presentationOwner.contentHash,
            presentationOwner,
            generationMs: Math.max(0, completedAt - startedAt),
            scheduler: execution ? schedulerResponse(
              execution,
              requestReceivedAtMs,
              schedulerReceivedAtMs,
              request.scheduler,
            ) : null,
          },
        });
        return;
      }
      if (request.type === CHUNK_GENERATOR_MESSAGE.GENERATE_CANONICAL_TREE_CELL) {
        if (typeof generator.generateCanonicalTreeCell !== 'function') {
          throw new Error('Chunk generator does not expose canonical Tree-cell generation');
        }
        const startedAt = clock();
        const treeCell = await generator.generateCanonicalTreeCell(
          request.macroX,
          request.macroZ,
          {
            scheduler: execution?.envelope ?? null,
            checkpoint: execution?.checkpoint ?? null,
          },
        );
        execution?.checkpoint();
        const completedAt = clock();
        postGenerationResponse({
          request,
          execution,
          requestReceivedAtMs,
          schedulerReceivedAtMs,
          generationStartedAtMs: startedAt,
          generationCompletedAtMs: completedAt,
          stageRecorder: null,
          roadTimingContext: null,
          response: {
            type: CHUNK_GENERATOR_MESSAGE.GENERATED_CANONICAL_TREE_CELL,
            protocolVersion: CHUNK_GENERATOR_PROTOCOL_VERSION,
            requestId: request.requestId,
            serviceGeneration,
            macroKey: treeCell.key,
            contentHash: treeCell.contentHash,
            canonicalTreeCell: treeCell,
            generationMs: Math.max(0, completedAt - startedAt),
            scheduler: execution ? schedulerResponse(
              execution,
              requestReceivedAtMs,
              schedulerReceivedAtMs,
              request.scheduler,
            ) : null,
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
          scheduler: execution ? schedulerResponse(
            execution,
            requestReceivedAtMs,
            schedulerReceivedAtMs,
            request.scheduler,
          ) : null,
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
          scheduler: execution ? schedulerResponse(
            execution,
            requestReceivedAtMs,
            schedulerReceivedAtMs,
            request.scheduler,
          ) : null,
          ...pipelineTiming(request, startedAt, completedAt),
        });
        return;
      }
      if (request.type === CHUNK_GENERATOR_MESSAGE.RESOLVE_CANONICAL_MAJOR_ROAD_OWNERS) {
        if (typeof generator.resolveCanonicalMajorRoadOwnerCoverage !== 'function') {
          throw new Error('Chunk generator does not expose canonical MAJOR Road owner coverage');
        }
        const startedAt = clock();
        const coverage = await generator.resolveCanonicalMajorRoadOwnerCoverage({
          centerWorldX: request.centerWorldX,
          centerWorldZ: request.centerWorldZ,
          radiusMeters: request.radiusMeters,
        });
        execution?.checkpoint();
        const completedAt = clock();
        postMessage({
          type: CHUNK_GENERATOR_MESSAGE.CANONICAL_MAJOR_ROAD_OWNERS,
          protocolVersion: CHUNK_GENERATOR_PROTOCOL_VERSION,
          requestId: request.requestId,
          serviceGeneration,
          coverage,
          operationMs: Math.max(0, completedAt - startedAt),
          scheduler: execution ? schedulerResponse(
            execution,
            requestReceivedAtMs,
            schedulerReceivedAtMs,
            request.scheduler,
          ) : null,
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
          scheduler: execution ? schedulerResponse(
            execution,
            requestReceivedAtMs,
            schedulerReceivedAtMs,
            request.scheduler,
          ) : null,
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
      const schedulerReceivedAtMs = Number(schedulerClock());
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
        return processMessage(request, null, requestReceivedAtMs, schedulerReceivedAtMs);
      }
      if (!request || request.protocolVersion !== CHUNK_GENERATOR_PROTOCOL_VERSION) {
        return processMessage(request, null, requestReceivedAtMs, schedulerReceivedAtMs);
      }
      const sourceEnvelope = normalizeWorldGenerationRequestEnvelope(
        request.scheduler,
        schedulerDefaults(request),
      );
      const envelope = rebaseSchedulerEnvelope(
        sourceEnvelope,
        request.schedulerClock,
        schedulerReceivedAtMs,
      );
      const handle = scheduler.schedule({
        envelope,
        execute: execution => processMessage(
          request,
          execution,
          requestReceivedAtMs,
          schedulerReceivedAtMs,
        ),
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
