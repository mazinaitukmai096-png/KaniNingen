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
  let diagnosticRequestCount = 0;
  let lastGeneratorSnapshot = null;
  let shutdownPromise = null;
  const activeOperations = new Set();

  const metadata = () => Object.freeze({
    worldSeed: generator.worldSeed,
    worldSeedHash: generator.worldSeedHash,
    generatorVersion: generator.generatorVersion,
    experienceSpawn: generator.experienceSpawn,
    reviewSpawn: generator.reviewSpawn,
  });

  const runOperation = operation => {
    if (isShutdown) return Promise.reject(new Error('inline ChunkData transport is shut down'));
    const promise = Promise.resolve().then(operation);
    activeOperations.add(promise);
    void promise.finally(() => activeOperations.delete(promise)).catch(() => {});
    return promise;
  };

  return Object.freeze({
    async initialize() {
      if (isShutdown) throw new Error('inline ChunkData transport is shut down');
      initialized = true;
      return metadata();
    },
    async generateChunk({ requestId, chunkX, chunkZ, priority } = {}) {
      return runOperation(() => {
        generatedCount += 1;
        return generator.generateChunk(chunkX, chunkZ, { requestId, priority });
      });
    },
    findSettlementsNear(centerWorldX, centerWorldZ, radiusMeters) {
      return runOperation(() => generator.distributor.findSettlementsNear(
        centerWorldX,
        centerWorldZ,
        radiusMeters,
      ));
    },
    resolveSettlementPresentationTemplate({ candidate } = {}) {
      return runOperation(() => {
        if (typeof generator.resolveSettlementPresentationTemplate !== 'function') {
          throw new Error('Chunk generator does not expose Settlement presentation templates');
        }
        return generator.resolveSettlementPresentationTemplate({ candidate });
      });
    },
    requestDiagnostics() {
      return runOperation(async () => {
        diagnosticRequestCount += 1;
        lastGeneratorSnapshot = await generator.snapshot?.() ?? null;
        return lastGeneratorSnapshot;
      });
    },
    snapshot() {
      return Object.freeze({
        kind: 'inline', generatedCount, diagnosticRequestCount, initialized, isShutdown,
        generatorSnapshot: lastGeneratorSnapshot,
      });
    },
    async shutdown() {
      if (shutdownPromise) return shutdownPromise;
      isShutdown = true;
      shutdownPromise = (async () => {
        await Promise.allSettled([...activeOperations]);
        try {
          await generator.shutdown?.();
        } finally {
          generator = null;
          lastGeneratorSnapshot = null;
        }
      })();
      return shutdownPromise;
    },
  });
}
