import { createW8ParityChunkGenerator } from './w8-parity-chunk-generator.js';
import {
  CHUNK_GENERATOR_MESSAGE,
  CHUNK_GENERATOR_PROTOCOL_VERSION,
  createChunkDataRequestKey,
} from './chunk-data-service-protocol.js';

function clock() {
  return globalThis.performance?.now?.() ?? Date.now();
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
} = {}) {
  if (typeof postMessage !== 'function') throw new TypeError('postMessage is required');
  let generator = null;
  let serviceGeneration = 0;
  let operationChain = Promise.resolve();
  let isShutdown = false;

  const processMessage = async request => {
    if (isShutdown) return;
    try {
      if (request?.protocolVersion !== CHUNK_GENERATOR_PROTOCOL_VERSION) {
        throw new Error(`unsupported Chunk generator protocol: ${request?.protocolVersion}`);
      }
      if (request.type === CHUNK_GENERATOR_MESSAGE.INITIALIZE) {
        generator = await generatorFactory({ worldSeed: request.worldSeed });
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
      if (request.type === CHUNK_GENERATOR_MESSAGE.GENERATE) {
        const startedAt = clock();
        const chunkData = await generator.generateChunk(request.chunkX, request.chunkZ);
        postMessage({
          type: CHUNK_GENERATOR_MESSAGE.GENERATED,
          protocolVersion: CHUNK_GENERATOR_PROTOCOL_VERSION,
          requestId: request.requestId,
          serviceGeneration,
          chunkKey: createChunkDataRequestKey(request.chunkX, request.chunkZ),
          chunkId: chunkData.chunkId,
          contentHash: chunkData.contentHash,
          chunkData,
          generationMs: Math.max(0, clock() - startedAt),
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
        postMessage({
          type: CHUNK_GENERATOR_MESSAGE.SETTLEMENTS,
          protocolVersion: CHUNK_GENERATOR_PROTOCOL_VERSION,
          requestId: request.requestId,
          serviceGeneration,
          settlements,
          operationMs: Math.max(0, clock() - startedAt),
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
        postMessage({
          type: CHUNK_GENERATOR_MESSAGE.SETTLEMENT_TEMPLATE,
          protocolVersion: CHUNK_GENERATOR_PROTOCOL_VERSION,
          requestId: request.requestId,
          serviceGeneration,
          template,
          operationMs: Math.max(0, clock() - startedAt),
        });
        return;
      }
      if (request.type === CHUNK_GENERATOR_MESSAGE.REQUEST_DIAGNOSTICS) {
        const startedAt = clock();
        const generatorSnapshot = await generator.snapshot?.() ?? null;
        postMessage({
          type: CHUNK_GENERATOR_MESSAGE.DIAGNOSTICS,
          protocolVersion: CHUNK_GENERATOR_PROTOCOL_VERSION,
          requestId: request.requestId,
          serviceGeneration,
          generatorSnapshot,
          operationMs: Math.max(0, clock() - startedAt),
        });
        return;
      }
      throw new Error(`unknown Chunk generator message: ${request.type}`);
    } catch (error) {
      postMessage(errorResponse(error, request));
    }
  };

  return Object.freeze({
    receive(request) {
      operationChain = operationChain.then(() => processMessage(request));
      return operationChain;
    },
    async shutdown() {
      isShutdown = true;
      await operationChain.catch(() => {});
      await generator?.shutdown?.();
      generator = null;
    },
  });
}
