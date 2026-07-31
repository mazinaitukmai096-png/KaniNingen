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
  GENERATE_FOREST_HORIZON: 'chunk-generator:generate-forest-horizon',
  GENERATED_FOREST_HORIZON: 'chunk-generator:generated-forest-horizon',
  CANCEL_FOREST_HORIZON: 'chunk-generator:cancel-forest-horizon',
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

export function createChunkGeneratorInitializeRequest({ serviceGeneration, worldSeed }) {
  if (!Number.isSafeInteger(serviceGeneration) || serviceGeneration < 1) {
    throw new RangeError('serviceGeneration must be a positive safe integer');
  }
  if (typeof worldSeed !== 'string' || !worldSeed) throw new TypeError('worldSeed is required');
  return Object.freeze({
    type: CHUNK_GENERATOR_MESSAGE.INITIALIZE,
    protocolVersion: CHUNK_GENERATOR_PROTOCOL_VERSION,
    serviceGeneration,
    worldSeed,
  });
}

export function createChunkGeneratorRequest({ requestId, serviceGeneration, chunkX, chunkZ }) {
  if (!Number.isSafeInteger(requestId) || requestId < 1) throw new RangeError('requestId must be positive');
  createChunkDataRequestKey(chunkX, chunkZ);
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
  });
}

export function createForestHorizonGeneratorRequest({
  requestId,
  serviceGeneration,
  chunkX,
  chunkZ,
  consumerId = 'distant-owner-query',
  epoch = 0,
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
  return Object.freeze({
    type: CHUNK_GENERATOR_MESSAGE.GENERATE_FOREST_HORIZON,
    protocolVersion: CHUNK_GENERATOR_PROTOCOL_VERSION,
    requestId,
    serviceGeneration,
    chunkX,
    chunkZ,
    consumerId,
    epoch,
  });
}
