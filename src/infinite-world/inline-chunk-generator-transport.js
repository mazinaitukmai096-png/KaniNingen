/**
 * Stage 2B-0 transport.  It deliberately has the same small surface that the
 * module Worker transport will implement in Stage 2B-1.
 */
export function createInlineChunkGeneratorTransport({ generator } = {}) {
  if (typeof generator?.generateChunk !== 'function') {
    throw new TypeError('generator.generateChunk is required');
  }
  let isShutdown = false;
  let generatedCount = 0;
  let initialized = false;

  const metadata = () => Object.freeze({
    worldSeed: generator.worldSeed,
    worldSeedHash: generator.worldSeedHash,
    generatorVersion: generator.generatorVersion,
    experienceSpawn: generator.experienceSpawn,
    reviewSpawn: generator.reviewSpawn,
    generatorSnapshot: generator.snapshot?.() ?? null,
  });

  return Object.freeze({
    async initialize() {
      if (isShutdown) throw new Error('inline ChunkData transport is shut down');
      initialized = true;
      return metadata();
    },
    async generateChunk({ requestId, chunkX, chunkZ, priority } = {}) {
      if (isShutdown) throw new Error('inline ChunkData transport is shut down');
      generatedCount += 1;
      return generator.generateChunk(chunkX, chunkZ, { requestId, priority });
    },
    findSettlementsNear(centerWorldX, centerWorldZ, radiusMeters) {
      if (isShutdown) throw new Error('inline ChunkData transport is shut down');
      return generator.distributor.findSettlementsNear(centerWorldX, centerWorldZ, radiusMeters);
    },
    resolveSettlementPresentationTemplate({ candidate } = {}) {
      if (isShutdown) throw new Error('inline ChunkData transport is shut down');
      if (typeof generator.resolveSettlementPresentationTemplate !== 'function') {
        throw new Error('Chunk generator does not expose Settlement presentation templates');
      }
      return generator.resolveSettlementPresentationTemplate({ candidate });
    },
    snapshot() {
      return Object.freeze({
        kind: 'inline', generatedCount, initialized, isShutdown,
        generatorSnapshot: generator.snapshot?.() ?? null,
      });
    },
    async shutdown() {
      isShutdown = true;
    },
  });
}
