export const CHUNK_GENERATION_STAGE_TIMING_SCHEMA = 'chunk-generation-stage-timing-1';

export const CHUNK_GENERATION_STAGE = Object.freeze({
  TERRAIN: 'terrain',
  RIVER: 'river',
  ROAD: 'road',
  SETTLEMENT: 'settlement',
  NATURAL: 'natural',
  CANONICAL: 'canonical',
  SERIALIZE: 'serialize',
  HASH: 'hash',
});

export const CHUNK_GENERATION_STAGE_ORDER = Object.freeze([
  CHUNK_GENERATION_STAGE.TERRAIN,
  CHUNK_GENERATION_STAGE.RIVER,
  CHUNK_GENERATION_STAGE.ROAD,
  CHUNK_GENERATION_STAGE.SETTLEMENT,
  CHUNK_GENERATION_STAGE.NATURAL,
  CHUNK_GENERATION_STAGE.CANONICAL,
  CHUNK_GENERATION_STAGE.SERIALIZE,
  CHUNK_GENERATION_STAGE.HASH,
]);

const stageNames = new Set(CHUNK_GENERATION_STAGE_ORDER);

function defaultClock() {
  return globalThis.performance?.now?.() ?? Date.now();
}

function assertStage(stage) {
  if (!stageNames.has(stage)) throw new RangeError(`unknown Chunk generation stage: ${stage}`);
  return stage;
}

export function createChunkGenerationStageRecorder({
  clock = defaultClock,
  capacity = 128,
} = {}) {
  if (typeof clock !== 'function') throw new TypeError('clock must be a function');
  if (!Number.isSafeInteger(capacity) || capacity < CHUNK_GENERATION_STAGE_ORDER.length) {
    throw new RangeError('Chunk generation stage capacity is too small');
  }
  const events = [];
  const totalsMs = Object.fromEntries(CHUNK_GENERATION_STAGE_ORDER.map(stage => [stage, 0]));
  const callCounts = Object.fromEntries(CHUNK_GENERATION_STAGE_ORDER.map(stage => [stage, 0]));
  let sequence = 0;

  const record = (stageInput, startedAtMs, completedAtMs, status = 'completed') => {
    const stage = assertStage(stageInput);
    const durationMs = Math.max(0, completedAtMs - startedAtMs);
    totalsMs[stage] += durationMs;
    callCounts[stage] += 1;
    events.push(Object.freeze({
      sequence: ++sequence,
      stage,
      startedAtMs,
      completedAtMs,
      durationMs,
      status,
    }));
    if (events.length > capacity) events.splice(0, events.length - capacity);
    return durationMs;
  };

  return Object.freeze({
    schemaVersion: CHUNK_GENERATION_STAGE_TIMING_SCHEMA,
    start(stage) {
      return Object.freeze({ stage: assertStage(stage), startedAtMs: clock() });
    },
    end(token, status = 'completed') {
      if (!token || !Number.isFinite(token.startedAtMs)) {
        throw new TypeError('valid Chunk generation stage token is required');
      }
      return record(token.stage, token.startedAtMs, clock(), status);
    },
    measureSync(stage, operation) {
      if (typeof operation !== 'function') throw new TypeError('stage operation must be a function');
      const token = this.start(stage);
      try {
        const value = operation();
        this.end(token);
        return value;
      } catch (error) {
        this.end(token, 'failed');
        throw error;
      }
    },
    async measure(stage, operation) {
      if (typeof operation !== 'function') throw new TypeError('stage operation must be a function');
      const token = this.start(stage);
      try {
        const value = await operation();
        this.end(token);
        return value;
      } catch (error) {
        this.end(token, 'failed');
        throw error;
      }
    },
    snapshot() {
      return Object.freeze({
        schemaVersion: CHUNK_GENERATION_STAGE_TIMING_SCHEMA,
        totalsMs: Object.freeze({ ...totalsMs }),
        callCounts: Object.freeze({ ...callCounts }),
        events: Object.freeze([...events]),
      });
    },
  });
}

export function measureChunkGenerationStage(stageRecorder, stage, operation) {
  return stageRecorder
    ? stageRecorder.measure(stage, operation)
    : operation();
}

export function measureChunkGenerationStageSync(stageRecorder, stage, operation) {
  return stageRecorder
    ? stageRecorder.measureSync(stage, operation)
    : operation();
}
