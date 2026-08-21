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
  WORLD_GENERATION_STATE,
} from './world-generation-scheduler.js';

const WORKER_SCHEDULER_CLOCK_SCHEMA = 'worker-scheduler-clock-1';
const SHARED_CANCELLATION_FLAG_INDEX = 0;
const SHARED_CANCELLATION_PREEMPTOR_INDEX = 1;
const SHARED_CANCELLATION_WORD_COUNT = 2;

function createWorkerMacrotaskYielder() {
  let channel = null;
  const pending = [];
  const yieldMacrotask = () => {
    if (typeof globalThis.scheduler?.yield === 'function') return globalThis.scheduler.yield();
    if (typeof globalThis.MessageChannel === 'function') {
      if (!channel) {
        channel = new globalThis.MessageChannel();
        channel.port1.onmessage = () => pending.shift()?.();
        channel.port1.start?.();
      }
      return new Promise(resolve => {
        pending.push(resolve);
        channel.port2.postMessage(null);
      });
    }
    return new Promise(resolve => globalThis.setTimeout(resolve, 0));
  };
  const close = () => {
    channel?.port1?.close?.();
    channel?.port2?.close?.();
    channel = null;
    for (const resolve of pending.splice(0)) resolve();
  };
  return Object.freeze({ yieldMacrotask, close });
}

function sharedCancellationView(request) {
  if (typeof globalThis.SharedArrayBuffer !== 'function'
    || typeof globalThis.Atomics?.load !== 'function'
    || !(request?.sharedCancellationBuffer instanceof globalThis.SharedArrayBuffer)
    || request.sharedCancellationBuffer.byteLength
      < Int32Array.BYTES_PER_ELEMENT * SHARED_CANCELLATION_WORD_COUNT) return null;
  return new Int32Array(
    request.sharedCancellationBuffer,
    0,
    SHARED_CANCELLATION_WORD_COUNT,
  );
}

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

function cancellationResponse(result, request) {
  const responseSentAtMs = clock();
  return {
    type: CHUNK_GENERATOR_MESSAGE.ERROR,
    protocolVersion: CHUNK_GENERATOR_PROTOCOL_VERSION,
    requestId: request?.requestId ?? result?.requestId ?? null,
    serviceGeneration: request?.serviceGeneration ?? null,
    name: 'WorldGenerationCancellationError',
    code: 'WORLD_GENERATION_CANCELLED',
    message: `World generation cancelled: ${result?.cancellationReason ?? 'cancelled'}`,
    recoverable: true,
    cancelled: true,
    cancellationReason: result?.cancellationReason ?? 'cancelled',
    workerTimeOriginMs: clockOrigin(),
    responseSentAtMs,
    scheduler: Object.freeze({
      operationKind: result?.operationKind ?? request?.scheduler?.operationKind ?? null,
      queuedAtMs: result?.queuedAtMs ?? null,
      startedAtMs: result?.startedAtMs ?? null,
      terminalAtMs: result?.terminalAtMs ?? null,
      queueTimeMs: result?.queueTimeMs ?? null,
      deadlineMiss: result?.deadlineMiss === true,
      backlogAtStart: result?.backlogAtStart ?? null,
      cancellationRequestedAtMs: result?.cancellationRequestedAtMs ?? null,
      cancellationAcknowledgedAtMs: result?.cancellationAcknowledgedAtMs ?? null,
      cancellationAcknowledgementMs: result?.cancellationAcknowledgementMs ?? null,
      cancellationAcknowledgedAtCheckpoint:
        result?.cancellationAcknowledgedAtCheckpoint === true,
      cancellationCheckpointSite: result?.cancellationCheckpointSite ?? null,
      preemptedByRequestId: result?.preemptedByRequestId ?? null,
    }),
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
  const macrotaskYielder = createWorkerMacrotaskYielder();
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
    const cancellationView = execution ? sharedCancellationView(request) : null;
    const synchronizeSharedCancellation = () => {
      if (!execution || !cancellationView || execution.signal.aborted
        || Atomics.load(cancellationView, SHARED_CANCELLATION_FLAG_INDEX) === 0) return;
      const encodedPreemptor = Atomics.load(
        cancellationView,
        SHARED_CANCELLATION_PREEMPTOR_INDEX,
      );
      const preemptedByRequestId = encodedPreemptor > 0 ? encodedPreemptor : null;
      scheduler.cancel({
        requestId: execution.envelope.requestId,
        reason: preemptedByRequestId === null
          ? 'shared-control-cancelled'
          : `preempted-by-higher-priority:${preemptedByRequestId}`,
        preemptedByRequestId,
      });
    };
    const synchronousCheckpoint = execution ? (details = null) => {
      synchronizeSharedCancellation();
      execution.checkpoint(details);
    } : null;
    const cooperativeCheckpoint = execution ? async () => {
      const checkpointDetails = () => execution.signal.aborted ? {
        site: new Error('Worker cancellation checkpoint').stack ?? null,
      } : null;
      synchronousCheckpoint(checkpointDetails());
      // A synchronous checkpoint cannot observe a cancel message while the
      // Worker is running one long JavaScript turn. Yield at explicit phase
      // boundaries, then check again after the Worker message queue advances.
      await macrotaskYielder.yieldMacrotask();
      synchronousCheckpoint(checkpointDetails());
    } : null;
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
      synchronizeSharedCancellation();
      execution?.checkpoint();
      if (request.type === CHUNK_GENERATOR_MESSAGE.GENERATE) {
        const stageRecorder = request.pipelineDiagnostics === true
          ? createChunkGenerationStageRecorder() : null;
        const roadTimingContext = createRoadTimingContext(request, execution);
        const startedAt = clock();
        const chunkData = await generator.generateChunk(request.chunkX, request.chunkZ, {
          scheduler: execution?.envelope ?? null,
          checkpoint: synchronousCheckpoint,
          cooperativeCheckpoint,
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
            checkpoint: synchronousCheckpoint,
            cooperativeCheckpoint,
            ...(stageRecorder ? { stageRecorder } : {}),
            ...(roadTimingContext ? { roadTimingContext } : {}),
          })
          : createW8ForestHorizonManifest(
            await generator.generateChunk(request.chunkX, request.chunkZ, {
              scheduler: execution?.envelope ?? null,
              checkpoint: synchronousCheckpoint,
              cooperativeCheckpoint,
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
          {
            scheduler: execution?.envelope ?? null,
            checkpoint: synchronousCheckpoint,
            cooperativeCheckpoint,
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
            checkpoint: synchronousCheckpoint,
            cooperativeCheckpoint,
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
        await cooperativeCheckpoint?.();
        const settlements = await generator.distributor.findSettlementsNear(
          request.centerWorldX,
          request.centerWorldZ,
          request.radiusMeters,
          {
            checkpoint: synchronousCheckpoint,
            cooperativeCheckpoint,
          },
        );
        await cooperativeCheckpoint?.();
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
          checkpoint: synchronousCheckpoint,
          cooperativeCheckpoint,
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
          checkpoint: synchronousCheckpoint,
          cooperativeCheckpoint,
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
      if (isWorldGenerationCancellation(error) && execution?.signal.aborted) {
        // Do not publish the CANCELLED terminal until every nested loader from
        // this single active request has settled and removed its pending-cache
        // entry. The successor can then never subscribe to cancelled work.
        try {
          await generator?.settleCancelledGeneration?.();
        } catch (settleError) {
          postMessage(errorResponse(settleError, request));
          throw settleError;
        }
        throw error;
      }
      postMessage(errorResponse(error, request));
      // Scheduled operations must reject back into the Worker scheduler so its
      // terminal state agrees with the ERROR already sent to the transport.
      // INITIALIZE and malformed unscheduled messages retain their response-only
      // behavior because no scheduler lifecycle owns those requests.
      if (execution) throw error;
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
      return handle.promise.then(result => {
        if (result.state === WORLD_GENERATION_STATE.CANCELLED) {
          postMessage(cancellationResponse(result, request));
        }
        return undefined;
      });
    },
    async shutdown() {
      isShutdown = true;
      try {
        const drained = await scheduler.shutdown({
          reason: 'worker-core-shutdown',
          cancelInFlight: true,
        });
        if (!drained) {
          throw new Error('Worker core generation drain timed out');
        }
        await generator?.shutdown?.();
      } finally {
        generator = null;
        forestHorizonCancelledBeforeEpoch.clear();
        macrotaskYielder.close();
      }
    },
  });
}
