import {
  createWorldGenerationRequestEnvelope,
  normalizeWorldGenerationRequestEnvelope,
} from './world-generation-scheduler.js';

export const CHUNK_DATA_PRIORITY = Object.freeze({
  PLAYER_DATA: 1,
  PLAYER_RENDER: 2,
  GAMEPLAY_REQUIRED: 3,
  DISTANT_OWNER: 4,
  ULTRA_WARM: 5,
});

export const CHUNK_GENERATOR_PROTOCOL_VERSION = 2;

export const CHUNK_GENERATOR_MESSAGE = Object.freeze({
  INITIALIZE: 'chunk-generator:initialize',
  INITIALIZED: 'chunk-generator:initialized',
  GENERATE: 'chunk-generator:generate',
  GENERATED: 'chunk-generator:generated',
  GENERATE_PRESENTATION_OWNER: 'chunk-generator:generate-presentation-owner',
  GENERATED_PRESENTATION_OWNER: 'chunk-generator:generated-presentation-owner',
  PIPELINE_TIMING: 'chunk-generator:pipeline-timing',
  GENERATE_FOREST_HORIZON: 'chunk-generator:generate-forest-horizon',
  GENERATED_FOREST_HORIZON: 'chunk-generator:generated-forest-horizon',
  CANCEL_FOREST_HORIZON: 'chunk-generator:cancel-forest-horizon',
  CANCEL_GENERATION: 'chunk-generator:cancel-generation',
  FIND_SETTLEMENTS: 'chunk-generator:find-settlements',
  SETTLEMENTS: 'chunk-generator:settlements',
  RESOLVE_SETTLEMENT_TEMPLATE: 'chunk-generator:resolve-settlement-template',
  SETTLEMENT_TEMPLATE: 'chunk-generator:settlement-template',
  REQUEST_DIAGNOSTICS: 'chunk-generator:request-diagnostics',
  DIAGNOSTICS: 'chunk-generator:diagnostics',
  ERROR: 'chunk-generator:error',
});

export const CHUNK_DATA_PRIORITY_NAMES = Object.freeze(
  new Map(Object.entries(CHUNK_DATA_PRIORITY).map(([name, value]) => [value, name])),
);

export function assertChunkDataPriority(priority) {
  if (!Number.isSafeInteger(priority) || !CHUNK_DATA_PRIORITY_NAMES.has(priority)) {
    throw new RangeError(`unknown ChunkData priority: ${priority}`);
  }
  return priority;
}

export function createChunkDataRequestKey(chunkX, chunkZ) {
  if (!Number.isSafeInteger(chunkX) || !Number.isSafeInteger(chunkZ)) {
    throw new TypeError('ChunkData request coordinates must be safe integers');
  }
  return `${chunkX},${chunkZ}`;
}

export function createChunkGeneratorInitializeRequest({
  serviceGeneration,
  worldSeed,
  settlementRoadGraphGeneratorId = null,
  settlementLotMode = null,
}) {
  if (!Number.isSafeInteger(serviceGeneration) || serviceGeneration < 1) {
    throw new RangeError('serviceGeneration must be a positive safe integer');
  }
  if (typeof worldSeed !== 'string' || !worldSeed) throw new TypeError('worldSeed is required');
  if (settlementRoadGraphGeneratorId !== null
    && (typeof settlementRoadGraphGeneratorId !== 'string' || !settlementRoadGraphGeneratorId)) {
    throw new TypeError('settlementRoadGraphGeneratorId must be a non-empty string when provided');
  }
  if (settlementLotMode !== null
    && (typeof settlementLotMode !== 'string' || !settlementLotMode)) {
    throw new TypeError('settlementLotMode must be a non-empty string when provided');
  }
  return Object.freeze({
    type: CHUNK_GENERATOR_MESSAGE.INITIALIZE,
    protocolVersion: CHUNK_GENERATOR_PROTOCOL_VERSION,
    serviceGeneration,
    worldSeed,
    ...(settlementRoadGraphGeneratorId ? { settlementRoadGraphGeneratorId } : {}),
    ...(settlementLotMode ? { settlementLotMode } : {}),
  });
}

export function createChunkGeneratorSchedulerEnvelope({
  requestId,
  operationKind,
  priority,
  required,
  createdAtMs,
  deadlineAtMs = null,
  consumerId = null,
  epoch = 0,
  correlationId = null,
  target = null,
  stream = null,
  scheduler = null,
} = {}) {
  return scheduler === null
    ? createWorldGenerationRequestEnvelope({
      requestId,
      operationKind,
      priority,
      required,
      createdAtMs,
      deadlineAtMs,
      consumerId,
      epoch,
      correlationId,
      target,
      stream,
    })
    : normalizeWorldGenerationRequestEnvelope(scheduler, {
      requestId,
      operationKind,
      priority,
      required,
      createdAtMs,
      deadlineAtMs,
      consumerId,
      epoch,
      correlationId,
      target,
      stream,
    });
}

export function createChunkGeneratorRequest({
  requestId,
  serviceGeneration,
  chunkX,
  chunkZ,
  priority = CHUNK_DATA_PRIORITY.GAMEPLAY_REQUIRED,
  required = priority <= CHUNK_DATA_PRIORITY.GAMEPLAY_REQUIRED,
  createdAtMs = 0,
  deadlineAtMs = null,
  consumerId = 'chunk-data-service',
  epoch = 0,
  correlationId = null,
  target = null,
  stream = null,
  scheduler = null,
  pipelineDiagnostics = false,
}) {
  if (!Number.isSafeInteger(requestId) || requestId < 1) throw new RangeError('requestId must be positive');
  createChunkDataRequestKey(chunkX, chunkZ);
  assertChunkDataPriority(priority);
  if (!Number.isSafeInteger(serviceGeneration) || serviceGeneration < 1) {
    throw new RangeError('serviceGeneration must be positive');
  }
  return Object.freeze({
    type: CHUNK_GENERATOR_MESSAGE.GENERATE,
    protocolVersion: CHUNK_GENERATOR_PROTOCOL_VERSION,
    requestId,
    serviceGeneration,
    chunkX,
    chunkZ,
    ...(pipelineDiagnostics === true ? { pipelineDiagnostics: true } : {}),
    scheduler: createChunkGeneratorSchedulerEnvelope({
      requestId,
      operationKind: 'chunk',
      priority,
      required,
      createdAtMs,
      deadlineAtMs,
      consumerId,
      epoch,
      correlationId,
      target,
      stream,
      scheduler,
    }),
  });
}

export function createForestHorizonGeneratorRequest({
  requestId,
  serviceGeneration,
  chunkX,
  chunkZ,
  consumerId = 'distant-owner-query',
  epoch = 0,
  priority = CHUNK_DATA_PRIORITY.DISTANT_OWNER,
  required = false,
  createdAtMs = 0,
  deadlineAtMs = null,
  correlationId = null,
  target = 'tree',
  stream = 'distant',
  scheduler = null,
  pipelineDiagnostics = false,
}) {
  if (!Number.isSafeInteger(requestId) || requestId < 1) {
    throw new RangeError('requestId must be positive');
  }
  createChunkDataRequestKey(chunkX, chunkZ);
  if (!Number.isSafeInteger(serviceGeneration) || serviceGeneration < 1) {
    throw new RangeError('serviceGeneration must be positive');
  }
  if (typeof consumerId !== 'string' || !consumerId
    || !Number.isSafeInteger(epoch) || epoch < 0) {
    throw new TypeError('Forest horizon request requires a consumerId and non-negative epoch');
  }
  assertChunkDataPriority(priority);
  return Object.freeze({
    type: CHUNK_GENERATOR_MESSAGE.GENERATE_FOREST_HORIZON,
    protocolVersion: CHUNK_GENERATOR_PROTOCOL_VERSION,
    requestId,
    serviceGeneration,
    chunkX,
    chunkZ,
    consumerId,
    epoch,
    ...(pipelineDiagnostics === true ? { pipelineDiagnostics: true } : {}),
    scheduler: createChunkGeneratorSchedulerEnvelope({
      requestId,
      operationKind: 'forest-horizon',
      priority,
      required,
      createdAtMs,
      deadlineAtMs,
      consumerId,
      epoch,
      correlationId,
      target,
      stream,
      scheduler,
    }),
  });
}

export function createPresentationOwnerGeneratorRequest({
  requestId,
  serviceGeneration,
  chunkX,
  chunkZ,
  priority = CHUNK_DATA_PRIORITY.DISTANT_OWNER,
  required = true,
  createdAtMs = 0,
  deadlineAtMs = null,
  consumerId = 'presentation-owner-service',
  epoch = 0,
  correlationId = null,
  target = 'distant',
  stream = 'distant',
  scheduler = null,
  pipelineDiagnostics = false,
} = {}) {
  if (!Number.isSafeInteger(requestId) || requestId < 1) {
    throw new RangeError('requestId must be positive');
  }
  createChunkDataRequestKey(chunkX, chunkZ);
  assertChunkDataPriority(priority);
  if (!Number.isSafeInteger(serviceGeneration) || serviceGeneration < 1) {
    throw new RangeError('serviceGeneration must be positive');
  }
  return Object.freeze({
    type: CHUNK_GENERATOR_MESSAGE.GENERATE_PRESENTATION_OWNER,
    protocolVersion: CHUNK_GENERATOR_PROTOCOL_VERSION,
    requestId,
    serviceGeneration,
    chunkX,
    chunkZ,
    ...(pipelineDiagnostics === true ? { pipelineDiagnostics: true } : {}),
    scheduler: createChunkGeneratorSchedulerEnvelope({
      requestId,
      operationKind: 'presentation-owner',
      priority,
      required,
      createdAtMs,
      deadlineAtMs,
      consumerId,
      epoch,
      correlationId,
      target,
      stream,
      // Presentation and Full ChunkData are separate services but share one
      // Worker scheduler. Use the transport request identity at that shared
      // boundary so equal per-service sequence numbers cannot collide.
      scheduler: scheduler === null ? null : {
        ...scheduler,
        requestId,
        operationKind: 'presentation-owner',
      },
    }),
  });
}

export function createChunkGeneratorCancelRequest({
  requestId,
  serviceGeneration,
  reason = 'cancelled',
} = {}) {
  if (!Number.isSafeInteger(requestId) || requestId < 1) throw new RangeError('requestId must be positive');
  if (!Number.isSafeInteger(serviceGeneration) || serviceGeneration < 1) {
    throw new RangeError('serviceGeneration must be positive');
  }
  if (typeof reason !== 'string' || !reason) throw new TypeError('cancellation reason is required');
  return Object.freeze({
    type: CHUNK_GENERATOR_MESSAGE.CANCEL_GENERATION,
    protocolVersion: CHUNK_GENERATOR_PROTOCOL_VERSION,
    requestId,
    serviceGeneration,
    reason,
  });
}
