import {
  LOGICAL_CHUNK_SIZE_METERS,
  UNITS_PER_METER,
} from '../chunk-coordinates.js';
import {
  MACRO_CELL_SIZE_METERS,
  MACRO_MAX_RETAINED_CELLS,
  MACRO_OWNERS_PER_AXIS,
  MACRO_RESIDENT_RADIUS_METERS,
  createMacroCoarseCellGenerator,
  createMacroCoarseWorldController,
  logicalWorldToMacroCell,
} from '../macro-coarse-world.js';
import { CHUNK_DATA_PRIORITY } from '../chunk-data-service-protocol.js';
import { determineDetailCandidateOwner } from '../legacy-core/g3/detail-candidates.js';
import {
  createChunkCoverageSignature,
  isRuntimeTransitionContract,
  sameRuntimeTransitionContract,
} from '../runtime-transition-contract.js';
import { createMacroTerrainEvaluator, G5_MACRO_TERRAIN } from '../legacy-core/g5/macro-terrain.js';
import { createNaturalBiomeEvaluator, naturalMaterialWeights } from '../natural-biome-field.js';
import {
  W8_CANONICAL_TREE_WORLD_DENSITY_THRESHOLD,
  W8_NATURAL_CANONICAL_VISIBILITY_METERS,
  isW8NaturalCandidateVisible,
} from '../w8-natural-presentation-policy.js';
import {
  W8_DEFAULT_RENDER_DISTANCE_PRESET,
  W8_RENDER_FOG_COLOR_HEX,
  W8_RENDER_DISTANCE_PRESETS,
  normalizeW8RenderDistancePreset,
  resolveW8RenderDistancePolicy,
  resolveW8SettlementHandoffProgress,
} from '../render-distance-policy.js';
import {
  resolveW8RockCanonicalObject,
  resolveW8RockVisibilityMeters,
} from '../rock-canonical-object.js';
import {
  W8_CANONICAL_VISIBILITY_METERS,
  resolveW8CanonicalWorldObject,
  resolveW8NaturalCandidateVisual,
  resolveW8ObjectVisibilityMeters,
} from '../world-object-canonical-contract.js';
import {
  W8_CANONICAL_TREE_CELL_SCHEMA,
  expandPresentationAuxiliaryRecord,
  expandPresentationNaturalRecord,
  expandPresentationStructureRecord,
  presentationOwnerResourceOf,
} from '../presentation-owner-generator.js';
import {
  createSettlementSurfacePolicy,
  resolveCanonicalGroundSurface,
  resolveCanonicalSurfaceColorRgb,
  resolveCanonicalSurfaceWeights,
} from '../w8-surface-policy.js';
import {
  canonicalRiverMayAffectChunk,
  createCanonicalRiverSourceId,
  createCanonicalRiverSurfaceCorridor,
  createCanonicalRiverProjection,
  resolveCanonicalRiverBed,
} from '../canonical-river-realization.js';
import {
  W8_SETTLEMENT_SILHOUETTE_COLOR_HEX,
  W8_SETTLEMENT_ROLE_LANDMARKS,
  resolveW8RemoteSettlementOpacityAtDistance,
  resolveW8RemoteSettlementAtmosphere,
  resolveW8SettlementPresentationPolicy,
  selectRemoteHorizonBuildings,
  selectW8SettlementPresentationCandidates,
  settlementCandidateDistance,
} from '../settlement-presentation-policy.js';
import {
  W8_ATMOSPHERIC_VEGETATION_COLOR_HEX,
  W8_FOREST_SILHOUETTE_COLOR_HEX,
  W8_VEGETATION_LOD_KINDS,
  evaluateW8VegetationLodBlend,
  naturalPresentationKind,
  resolveW8CanonicalFarTreeDensityRank,
  resolveW8LowPolyTreePresentationParts,
  resolveW8VegetationLodPolicy,
} from '../vegetation-lod-policy.js';
import {
  createSettlementStreamingSnapshotCache,
  isSettlementStreamingSnapshotCurrent,
} from '../settlement-streaming-snapshot-cache.js';
import {
  WORLD_STREAMING_EVENT,
  WORLD_STREAMING_STREAM,
  WORLD_STREAMING_TARGET,
  worldStreamingTargetForCanonicalObject,
} from '../world-streaming-telemetry.js';
import {
  NATURAL_OWNER_BUILD_QUEUE_MAXIMUM,
  resolveNaturalOwnerBuildQueueTarget,
} from '../streaming-capacity-budget.js';
import {
  hasDrawableInCompletedFrame,
  isDrawableInCompletedFrame,
  isCompletedRenderFrameReceipt,
} from '../visual-continuity.js';
import {
  buildSettlementRoadRibbonMeshData,
  createRoadRibbonHeightSampler,
} from './settlement-road-ribbon-geometry.js';
import { createMacroCoarseWorldPresentation } from './macro-coarse-world-presentation.js';

export {
  W8_NATURAL_CANONICAL_VISIBILITY_METERS,
  isW8NaturalCandidateVisible,
} from '../w8-natural-presentation-policy.js';
export {
  W8_FINITE_ROCK_PRESENTATION_METERS,
  resolveW8RockCandidateVisual,
  resolveW8RockCanonicalObject,
  resolveW8RockVisibilityMeters,
} from '../rock-canonical-object.js';
export {
  W8_CANONICAL_VISIBILITY_METERS,
  resolveW8CanonicalWorldObject,
  resolveW8NaturalCandidateVisual,
} from '../world-object-canonical-contract.js';

const FIVE_BY_FIVE_HALF_EXTENT_METERS = LOGICAL_CHUNK_SIZE_METERS * 2.5;
const THREE_BY_THREE_HALF_EXTENT_METERS = LOGICAL_CHUNK_SIZE_METERS * 1.5;
const CLIPMAP_BLEND_METERS = 16;
const CLIPMAP_SAMPLE_CACHE_CAPACITY = 65_536;
const MIDGROUND_OWNER_SAMPLE_CACHE_CAPACITY = 75;
const RIVER_CORRIDOR_WINDOW_CACHE_CAPACITY = 6;
const DISTANT_ROCK_PROXY_LIMIT = 0;
const TEMPLATE_CACHE_CAPACITY = 5;
const FAR_OWNER_CHUNK_CACHE_CAPACITY = 128;
const SHARED_NATURAL_SILHOUETTE_MATERIAL = '__natural-silhouette__';

const CANONICAL_QUERY_CONCURRENCY = 4;
const CANONICAL_QUERY_MARGIN_METERS = Math.SQRT2 * LOGICAL_CHUNK_SIZE_METERS;
const PRESENTATION_SLICE_BUDGET_MS = 8;
const isCanonicalNaturalResourceKind = value => (
  value === 'canonical' || value === 'presentation'
);
// Medium publication and the final GPU-buffer copy are indivisible batches.
// Leave headroom for that bounded overshoot under the external <=4ms contract.
const TERRAIN_PRESENTATION_STAGING_SLICE_BUDGET_MS = 1.5;
const TERRAIN_PRESENTATION_NORMAL_RESUME_DEADLINE_MS = 16;
const TERRAIN_PRESENTATION_URGENT_RESUME_DEADLINE_MS = 6;
const TERRAIN_PRESENTATION_NORMAL_SLICES_PER_FRAME = 8;
const TERRAIN_PRESENTATION_URGENT_SLICES_PER_FRAME = 10;
// Smooth ordinary frames without throttling sustained Terrain throughput.
// Allowance starts below the proven 8/10-slice ceiling and rises only when
// the active generation has genuinely fallen behind.
const TERRAIN_PRESENTATION_NORMAL_PRESSURE_MS = 140;
const TERRAIN_PRESENTATION_NORMAL_SEVERE_PRESSURE_MS = 320;
const TERRAIN_PRESENTATION_URGENT_PRESSURE_MS = 80;
const TERRAIN_PRESENTATION_URGENT_SEVERE_PRESSURE_MS = 200;
const TERRAIN_PRESENTATION_SCHEDULER_SAMPLE_LIMIT = 512;
const TERRAIN_PRESENTATION_STAGED_GENERATION_LIMIT = 3;
const PRESENTATION_SLICE_UNIT_LIMIT = 256;
const NATURAL_STREAM_REVEAL_MS = 900;
const STATIC_TREE_PAGE_FRAME_BUDGET_MS = 3;
const NATURAL_VISIBILITY_FRAME_BUDGET_MS = 1.5;
const NATURAL_VISIBILITY_LEAVING_AGE_FRAMES = 8;
const NATURAL_VISIBILITY_STARVATION_FRAMES = 120;
const STATIC_TREE_PAGE_UNIT_LIMIT = 512;
const PERSISTENT_DISTANT_BUCKET_CAPACITY = 4_096;
const PERSISTENT_NATURAL_MAXIMUM_BUCKET_SLOTS_PER_OWNER = Object.freeze({
  // Formal Vegetation is bounded to 64 records per owner. Broadleaf and
  // wetland crowns can contribute two parts to one full-detail bucket.
  tree: Object.freeze({ full: 128, derived: 64 }),
  // Bush combines at most 64 formal shrubs and 48 ambient shrubs.
  bush: Object.freeze({ full: 112, derived: 112 }),
  // Ambient details are bounded to 48 records per owner.
  grass: Object.freeze({ full: 48, derived: 48 }),
  // Formal Rocks are bounded to 64 records per owner.
  rock: Object.freeze({ full: 64, derived: 64 }),
});
const STATIC_TREE_DISPOSE_BUDGET_MS = 2;
const STATIC_TREE_OWNER_DISPOSE_LIMIT = 1;
// One deadline-ordered publication budget replaces the former independent
// heavy/small-Far/empty cadences. Cost estimates retain the same bounded
// upload envelope without allowing a cheaper class to jump an older owner.
const STATIC_NATURAL_PUBLICATION_BUDGET_UNITS = 32;
const STATIC_NATURAL_EMPTY_PUBLICATION_COST = 1;
const STATIC_NATURAL_SMALL_PUBLICATION_COST = 8;
const STATIC_NATURAL_HEAVY_PUBLICATION_COST = 32;
const STATIC_NATURAL_SMALL_PAGE_SLOT_LIMIT = 8;
const DIRECT_CANONICAL_TREE_RESOURCE_KIND = 'canonical-tree-cell';
const DIRECT_CANONICAL_TREE_PAGE_PREFIX = 'macro-tree:';
// Owners are selected by Chunk-circle intersection. Keep their immutable
// coarse contents drawable through the far corner of a boundary Chunk; the
// scene fog still defines the visible 300 m world domain.
const PRESENTATION_OWNER_COARSE_DOMAIN_METERS = 300
  + Math.SQRT2 * LOGICAL_CHUNK_SIZE_METERS;
const PRESENTATION_OWNER_COARSE_FADE_METERS = 4;
// The owner-intersection contract can place an immutable required anchor at
// the exact far corner of this domain. Keep that boundary strictly drawable;
// the cosmetic fade begins only after it (the scene Fog remains 300 m).
const PRESENTATION_OWNER_COARSE_VISIBILITY_METERS =
  PRESENTATION_OWNER_COARSE_DOMAIN_METERS + PRESENTATION_OWNER_COARSE_FADE_METERS;
const RUNTIME_PRESENTATION_FRAME_BUDGET_MS = PRESENTATION_SLICE_BUDGET_MS;
const ROAD_PRESENTATION_FRAME_BUDGET_MS = 2;
const ROAD_PRESENTATION_STARVATION_FRAMES = 120;
const DISTANT_ROAD_OWNER_CONSUMER_ID = 'distant-road-owner-query';
const DISTANT_ROAD_OWNER_CONSUMER_EPOCH = 1;
const DISTANT_ROAD_COVERAGE_CONSUMER_ID = 'distant-road-coverage-query';
const DISTANT_PERSISTENT_MESH_ADMISSION_LIMIT = 1;
const DISTANT_PERSISTENT_UPLOAD_BUDGET_BYTES = 512 * 1024;
const TREE_RENDER_PATH = Object.freeze({
  LEGACY: 'distant-legacy-tree',
  STATIC: 'distant-static-tree',
  ULTRA: 'ultra-tree',
});


export const W8_ROAD_VISIBILITY_DIAGNOSTIC_MODES = Object.freeze({
  OFF: 'off',
  CONTRAST: 'contrast',
  WIDE: 'wide',
});

const W8_ROAD_VISIBILITY_DIAGNOSTIC_COLOR_HEX = 0xff00ff;
const W8_ROAD_VISIBILITY_DIAGNOSTIC_WIDE_MULTIPLIER = 4;
const W8_ROAD_LIFECYCLE_DIAGNOSTIC_HISTORY_LIMIT = 96;
const W8_ROAD_LIFECYCLE_DIAGNOSTIC_RECORD_LIMIT = 512;

export function resolveW8RoadVisibilityDiagnostic(value = null) {
  const mode = value === null || value === undefined || value === ''
    ? W8_ROAD_VISIBILITY_DIAGNOSTIC_MODES.OFF : String(value);
  if (!Object.values(W8_ROAD_VISIBILITY_DIAGNOSTIC_MODES).includes(mode)) {
    throw new RangeError('roadVisibilityDiagnostic must be off, contrast, or wide');
  }
  const enabled = mode !== W8_ROAD_VISIBILITY_DIAGNOSTIC_MODES.OFF;
  return Object.freeze({
    schemaVersion: 'w8-road-visibility-diagnostic-1',
    mode,
    enabled,
    colorHex: W8_ROAD_VISIBILITY_DIAGNOSTIC_COLOR_HEX,
    disableFog: enabled,
    unlit: enabled,
    widthMultiplier: mode === W8_ROAD_VISIBILITY_DIAGNOSTIC_MODES.WIDE
      ? W8_ROAD_VISIBILITY_DIAGNOSTIC_WIDE_MULTIPLIER : 1,
  });
}

function terrainSchedulerPercentile(values, ratio) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index];
}

export function createDeadlineAwareTerrainPresentationScheduler({
  clock = () => globalThis.performance?.now?.() ?? Date.now(),
  setTimeoutFn = globalThis.setTimeout?.bind(globalThis),
  clearTimeoutFn = globalThis.clearTimeout?.bind(globalThis),
  postTaskFn = null,
  scheduleTaskFn = null,
  priorityPostTaskFn = globalThis.scheduler?.postTask?.bind(globalThis.scheduler) ?? null,
  MessageChannelCtor = globalThis.MessageChannel ?? null,
  AbortControllerCtor = globalThis.AbortController ?? null,
  normalResumeDeadlineMs = TERRAIN_PRESENTATION_NORMAL_RESUME_DEADLINE_MS,
  urgentResumeDeadlineMs = TERRAIN_PRESENTATION_URGENT_RESUME_DEADLINE_MS,
  normalSlicesPerFrame = TERRAIN_PRESENTATION_NORMAL_SLICES_PER_FRAME,
  urgentSlicesPerFrame = TERRAIN_PRESENTATION_URGENT_SLICES_PER_FRAME,
} = {}) {
  if (typeof clock !== 'function') throw new TypeError('Terrain scheduler clock must be a function');
  if (typeof setTimeoutFn !== 'function' || typeof clearTimeoutFn !== 'function') {
    throw new TypeError('Terrain scheduler timeout functions are required');
  }
  if (postTaskFn !== null && typeof postTaskFn !== 'function') {
    throw new TypeError('Terrain scheduler postTask must be a function when provided');
  }
  if (scheduleTaskFn !== null && typeof scheduleTaskFn !== 'function') {
    throw new TypeError('Terrain scheduler task scheduler must be a function when provided');
  }
  if (priorityPostTaskFn !== null && typeof priorityPostTaskFn !== 'function') {
    throw new TypeError('Terrain scheduler priority task scheduler must be a function when provided');
  }
  for (const [name, value] of [
    ['normalResumeDeadlineMs', normalResumeDeadlineMs],
    ['urgentResumeDeadlineMs', urgentResumeDeadlineMs],
  ]) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new RangeError(`${name} must be a positive finite number`);
    }
  }
  for (const [name, value] of [
    ['normalSlicesPerFrame', normalSlicesPerFrame],
    ['urgentSlicesPerFrame', urgentSlicesPerFrame],
  ]) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new RangeError(`${name} must be a positive safe integer`);
    }
  }
  if (urgentSlicesPerFrame < normalSlicesPerFrame) {
    throw new RangeError('urgent Terrain frame allowance cannot be below normal allowance');
  }
  const pending = [];
  const activeGenerations = new Map();
  const terrainSliceSamples = [];
  const terrainResumeWaitSamples = [];
  const terrainGenerationCpuSamples = [];
  const terrainGenerationYieldWaitSamples = [];
  const terrainGenerationWallSamples = [];
  let sequence = 0;
  let generationSequence = 0;
  let frameSequence = 0;
  let frameTokens = 0;
  let frameAllowance = 0;
  let framePressureLevel = 'idle';
  let frameMaximumGenerationWallMs = 0;
  let frameOldestPendingWaitMs = 0;
  let draining = false;
  let shutdown = false;
  let terrainSliceCount = 0;
  let terrainSliceCpuMs = 0;
  let terrainSliceMaximumMs = 0;
  let terrainResumeWaitMaximumMs = 0;
  let terrainDeadlineMissCount = 0;
  let terrainDeadlineMissMaxMs = 0;
  let terrainGenerationCpuMs = 0;
  let terrainGenerationYieldWaitMs = 0;
  let terrainGenerationWallMs = 0;
  let terrainGenerationCount = 0;
  let frameResumeCount = 0;
  let deadlineResumeCount = 0;
  let continuationTaskPosted = false;
  const continuationTasks = [];
  const messageChannel = scheduleTaskFn === null && priorityPostTaskFn === null
    && typeof MessageChannelCtor === 'function'
    ? new MessageChannelCtor() : null;
  if (messageChannel) {
    messageChannel.port1.onmessage = () => {
      const task = continuationTasks.shift();
      task?.();
    };
  }
  const postContinuationTask = scheduleTaskFn ?? (priorityPostTaskFn
    ? callback => {
      let invoked = false;
      const invoke = () => {
        if (invoked) return;
        invoked = true;
        callback();
      };
      Promise.resolve(priorityPostTaskFn(invoke, { priority: 'user-blocking' }))
        .catch(() => setTimeoutFn(invoke, 0));
    }
    : messageChannel ? callback => {
      continuationTasks.push(callback);
      messageChannel.port2.postMessage(0);
    }
    : callback => setTimeoutFn(callback, 0));

  const appendSample = (samples, value) => {
    if (!Number.isFinite(value)) return;
    samples.push(Math.max(0, value));
    if (samples.length > TERRAIN_PRESENTATION_SCHEDULER_SAMPLE_LIMIT) samples.shift();
  };
  const resolveUrgent = value => {
    try {
      return typeof value === 'function' ? value() === true : value === true;
    } catch {
      return false;
    }
  };
  const entryUrgent = entry => resolveUrgent(entry?.isUrgent);
  const resumeDeadlineMs = urgent => (
    urgent ? urgentResumeDeadlineMs : normalResumeDeadlineMs
  );
  const cancelDeadline = entry => {
    if (entry.timeoutHandle !== null) {
      clearTimeoutFn(entry.timeoutHandle);
      entry.timeoutHandle = null;
    }
    if (entry.abortController !== null) {
      entry.abortController.abort();
      entry.abortController = null;
    }
  };
  const removePending = entry => {
    const index = pending.indexOf(entry);
    if (index >= 0) pending.splice(index, 1);
  };
  const resume = (entry, source) => {
    if (!entry || entry.settled) return false;
    entry.settled = true;
    removePending(entry);
    cancelDeadline(entry);
    const resumedAtMs = clock();
    const waitMs = Math.max(0, resumedAtMs - entry.requestedAtMs);
    const deadlineMs = resumeDeadlineMs(entryUrgent(entry));
    appendSample(terrainResumeWaitSamples, waitMs);
    terrainResumeWaitMaximumMs = Math.max(terrainResumeWaitMaximumMs, waitMs);
    if (waitMs > deadlineMs) {
      terrainDeadlineMissCount += 1;
      terrainDeadlineMissMaxMs = Math.max(terrainDeadlineMissMaxMs, waitMs - deadlineMs);
    }
    if (source === 'frame') frameResumeCount += 1;
    else if (source === 'deadline') deadlineResumeCount += 1;
    entry.resolve(Object.freeze({
      source,
      waitMs,
      deadlineMs,
      urgent: entryUrgent(entry),
      frameSequence,
      shutdown,
    }));
    return true;
  };
  const selectNextPending = () => [...pending].sort((left, right) => (
    Number(entryUrgent(right)) - Number(entryUrgent(left))
      || left.deadlineAtMs - right.deadlineAtMs
      || left.sequence - right.sequence
  ))[0] ?? null;
  const terrainPressureSnapshot = urgent => {
    const now = clock();
    const maximumGenerationWallMs = [...activeGenerations.values()].reduce(
      (maximum, generation) => Math.max(maximum, Math.max(0, now - generation.startedAtMs)),
      0,
    );
    const oldestPendingWaitMs = pending.reduce(
      (maximum, entry) => Math.max(maximum, Math.max(0, now - entry.requestedAtMs)),
      0,
    );
    const moderateThresholdMs = urgent
      ? TERRAIN_PRESENTATION_URGENT_PRESSURE_MS
      : TERRAIN_PRESENTATION_NORMAL_PRESSURE_MS;
    const severeThresholdMs = urgent
      ? TERRAIN_PRESENTATION_URGENT_SEVERE_PRESSURE_MS
      : TERRAIN_PRESENTATION_NORMAL_SEVERE_PRESSURE_MS;
    const resumeDeadline = resumeDeadlineMs(urgent);
    const severe = maximumGenerationWallMs >= severeThresholdMs
      || oldestPendingWaitMs >= resumeDeadline * 3
      || pending.length >= TERRAIN_PRESENTATION_STAGED_GENERATION_LIMIT;
    const moderate = severe
      || maximumGenerationWallMs >= moderateThresholdMs
      || oldestPendingWaitMs >= resumeDeadline * 1.5
      || pending.length >= 2;
    return Object.freeze({
      level: severe ? 'severe' : moderate ? 'moderate' : 'normal',
      maximumGenerationWallMs,
      oldestPendingWaitMs,
    });
  };
  const adaptiveFrameAllowance = urgent => {
    const maximum = urgent ? urgentSlicesPerFrame : normalSlicesPerFrame;
    const pressure = terrainPressureSnapshot(urgent);
    const baseRatio = urgent ? 0.6 : 0.5;
    const moderateRatio = urgent ? 0.8 : 0.75;
    const allowance = pressure.level === 'severe'
      ? maximum
      : pressure.level === 'moderate'
        ? Math.max(1, Math.ceil(maximum * moderateRatio))
        : Math.max(1, Math.ceil(maximum * baseRatio));
    return Object.freeze({ allowance, pressure });
  };
  let scheduleTokenDrain = () => {};
  const drainFrameToken = () => {
    if (draining || shutdown) return 0;
    draining = true;
    let resumed = 0;
    try {
      if (frameTokens > 0 && pending.length > 0) {
        const entry = selectNextPending();
        if (entry) {
          frameTokens -= 1;
          resumed = Number(resume(entry, 'frame'));
        }
      }
    } finally {
      draining = false;
    }
    if (frameTokens > 0 && pending.length > 0) scheduleTokenDrain();
    return resumed;
  };
  scheduleTokenDrain = () => {
    if (shutdown || continuationTaskPosted || frameTokens < 1 || pending.length === 0) return;
    continuationTaskPosted = true;
    postContinuationTask(() => {
      continuationTaskPosted = false;
      drainFrameToken();
    });
  };
  const armDeadline = entry => {
    const urgent = entryUrgent(entry);
    const deadlineMs = resumeDeadlineMs(urgent);
    entry.deadlineAtMs = entry.requestedAtMs + deadlineMs;
    if (postTaskFn) {
      const abortController = typeof AbortControllerCtor === 'function'
        ? new AbortControllerCtor() : null;
      entry.abortController = abortController;
      const task = postTaskFn(
        () => resume(entry, 'deadline'),
        {
          priority: urgent ? 'user-blocking' : 'user-visible',
          delay: deadlineMs,
          ...(abortController ? { signal: abortController.signal } : {}),
        },
      );
      Promise.resolve(task).catch(error => {
        if (error?.name !== 'AbortError' && !entry.settled && !shutdown) {
          entry.timeoutHandle = setTimeoutFn(() => resume(entry, 'deadline'), deadlineMs);
        }
      });
      return;
    }
    entry.timeoutHandle = setTimeoutFn(() => resume(entry, 'deadline'), deadlineMs);
  };
  const activeGenerationUrgent = () => [...activeGenerations.values()]
    .some(generation => resolveUrgent(generation.isUrgent));

  return Object.freeze({
    beginGeneration({ isUrgent = false, stage = 'initializing' } = {}) {
      const token = ++generationSequence;
      activeGenerations.set(token, {
        isUrgent,
        startedAtMs: clock(),
        stage,
        cpuMs: 0,
        yieldWaitMs: 0,
        yieldCount: 0,
        lastResumeWaitMs: 0,
        maximumResumeWaitMs: 0,
      });
      return token;
    },
    setGenerationStage(token, stage) {
      const generation = activeGenerations.get(token);
      if (!generation || typeof stage !== 'string' || !stage) return false;
      generation.stage = stage;
      return true;
    },
    recordGenerationSlice(token, durationMs) {
      const generation = activeGenerations.get(token);
      if (!generation) return false;
      generation.cpuMs += Math.max(0, Number(durationMs) || 0);
      return true;
    },
    recordGenerationYield(token, waitMs) {
      const generation = activeGenerations.get(token);
      if (!generation) return false;
      const wait = Math.max(0, Number(waitMs) || 0);
      generation.yieldWaitMs += wait;
      generation.yieldCount += 1;
      generation.lastResumeWaitMs = wait;
      generation.maximumResumeWaitMs = Math.max(generation.maximumResumeWaitMs, wait);
      return true;
    },
    waitForContinuation({ isUrgent = false } = {}) {
      if (shutdown) return Promise.resolve(Object.freeze({
        source: 'shutdown', waitMs: 0, deadlineMs: 0, urgent: false,
        frameSequence, shutdown: true,
      }));
      return new Promise(resolve => {
        const requestedAtMs = clock();
        const entry = {
          sequence: ++sequence,
          requestedAtMs,
          deadlineAtMs: requestedAtMs,
          isUrgent,
          timeoutHandle: null,
          abortController: null,
          settled: false,
          resolve,
        };
        pending.push(entry);
        armDeadline(entry);
        scheduleTokenDrain();
      });
    },
    pumpFrame() {
      if (shutdown) return Object.freeze({
        frameSequence, resumed: 0, allowance: 0, urgent: false, pending: 0,
      });
      frameSequence += 1;
      const urgent = activeGenerationUrgent() || pending.some(entryUrgent);
      const adaptive = adaptiveFrameAllowance(urgent);
      frameAllowance = adaptive.allowance;
      framePressureLevel = adaptive.pressure.level;
      frameMaximumGenerationWallMs = adaptive.pressure.maximumGenerationWallMs;
      frameOldestPendingWaitMs = adaptive.pressure.oldestPendingWaitMs;
      frameTokens = frameAllowance;
      const resumed = drainFrameToken();
      return Object.freeze({
        frameSequence,
        resumed,
        allowance: frameAllowance,
        maximumAllowance: urgent ? urgentSlicesPerFrame : normalSlicesPerFrame,
        pressureLevel: framePressureLevel,
        maximumGenerationWallMs: frameMaximumGenerationWallMs,
        oldestPendingWaitMs: frameOldestPendingWaitMs,
        urgent,
        pending: pending.length,
      });
    },
    recordSlice(durationMs) {
      const duration = Math.max(0, Number(durationMs) || 0);
      terrainSliceCount += 1;
      terrainSliceCpuMs += duration;
      terrainSliceMaximumMs = Math.max(terrainSliceMaximumMs, duration);
      appendSample(terrainSliceSamples, duration);
    },
    completeGeneration(token, { cpuMs = 0, yieldWaitMs = 0, wallMs = 0 } = {}) {
      if (!activeGenerations.delete(token)) return false;
      const cpu = Math.max(0, Number(cpuMs) || 0);
      const wait = Math.max(0, Number(yieldWaitMs) || 0);
      const wall = Math.max(0, Number(wallMs) || 0);
      terrainGenerationCount += 1;
      terrainGenerationCpuMs += cpu;
      terrainGenerationYieldWaitMs += wait;
      terrainGenerationWallMs += wall;
      appendSample(terrainGenerationCpuSamples, cpu);
      appendSample(terrainGenerationYieldWaitSamples, wait);
      appendSample(terrainGenerationWallSamples, wall);
      return true;
    },
    snapshot() {
      const generationAverage = values => values.length > 0
        ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
      return Object.freeze({
        schemaVersion: 'terrain-presentation-deadline-scheduler-3',
        normalResumeDeadlineMs,
        urgentResumeDeadlineMs,
        normalSlicesPerFrame,
        urgentSlicesPerFrame,
        frameAllowance,
        framePressureLevel,
        frameMaximumGenerationWallMs,
        frameOldestPendingWaitMs,
        terrainSliceCount,
        terrainSliceCpuMs,
        terrainSliceP50Ms: terrainSchedulerPercentile(terrainSliceSamples, 0.5),
        terrainSliceP95Ms: terrainSchedulerPercentile(terrainSliceSamples, 0.95),
        terrainSliceMaxMs: terrainSliceMaximumMs,
        terrainResumeWaitP50Ms: terrainSchedulerPercentile(terrainResumeWaitSamples, 0.5),
        terrainResumeWaitP95Ms: terrainSchedulerPercentile(terrainResumeWaitSamples, 0.95),
        terrainResumeWaitMaxMs: terrainResumeWaitMaximumMs,
        terrainDeadlineMissCount,
        terrainDeadlineMissMaxMs,
        terrainGenerationCpuMs,
        terrainGenerationYieldWaitMs,
        terrainGenerationWallMs,
        terrainGenerationCount,
        terrainGenerationCpuAverageMs: generationAverage(terrainGenerationCpuSamples),
        terrainGenerationYieldWaitAverageMs:
          generationAverage(terrainGenerationYieldWaitSamples),
        terrainGenerationWallAverageMs: generationAverage(terrainGenerationWallSamples),
        terrainGenerationWallP95Ms:
          terrainSchedulerPercentile(terrainGenerationWallSamples, 0.95),
        presentationSchedulerTerrainSlices: terrainSliceCount,
        frameResumeCount,
        deadlineResumeCount,
        pendingContinuationCount: pending.length,
        activeGenerationCount: activeGenerations.size,
        activeGenerations: Object.freeze([...activeGenerations.entries()].map(
          ([token, generation]) => Object.freeze({
            token,
            stage: generation.stage,
            startedAtMs: generation.startedAtMs,
            wallMs: Math.max(0, clock() - generation.startedAtMs),
            cpuMs: generation.cpuMs,
            yieldWaitMs: generation.yieldWaitMs,
            yieldCount: generation.yieldCount,
            lastResumeWaitMs: generation.lastResumeWaitMs,
            maximumResumeWaitMs: generation.maximumResumeWaitMs,
            urgent: resolveUrgent(generation.isUrgent),
          }),
        )),
        frameSequence,
        shutdown,
      });
    },
    resetDiagnostics() {
      terrainSliceSamples.length = 0;
      terrainResumeWaitSamples.length = 0;
      terrainGenerationCpuSamples.length = 0;
      terrainGenerationYieldWaitSamples.length = 0;
      terrainGenerationWallSamples.length = 0;
      terrainSliceCount = 0;
      terrainSliceCpuMs = 0;
      terrainSliceMaximumMs = 0;
      terrainResumeWaitMaximumMs = 0;
      terrainDeadlineMissCount = 0;
      terrainDeadlineMissMaxMs = 0;
      terrainGenerationCpuMs = 0;
      terrainGenerationYieldWaitMs = 0;
      terrainGenerationWallMs = 0;
      terrainGenerationCount = 0;
      frameResumeCount = 0;
      deadlineResumeCount = 0;
      frameAllowance = 0;
      framePressureLevel = 'idle';
      frameMaximumGenerationWallMs = 0;
      frameOldestPendingWaitMs = 0;
      return true;
    },
    shutdown() {
      if (shutdown) return false;
      shutdown = true;
      frameTokens = 0;
      frameAllowance = 0;
      framePressureLevel = 'idle';
      continuationTasks.length = 0;
      messageChannel?.port1?.close?.();
      messageChannel?.port2?.close?.();
      for (const entry of [...pending]) resume(entry, 'shutdown');
      activeGenerations.clear();
      return true;
    },
  });
}

function appendSettlementSnapshotHash(hash, value) {
  const text = String(value ?? '');
  let next = hash >>> 0;
  for (let index = 0; index < text.length; index += 1) {
    next ^= text.charCodeAt(index);
    next = Math.imul(next, 0x01000193) >>> 0;
  }
  next ^= 0xff;
  return Math.imul(next, 0x01000193) >>> 0;
}

export function resolveW8PersistentNaturalBucketCapacity({
  kind,
  mode,
  maximumCanonicalOwnerCount,
  maximumManifestOwnerCount,
  requiredSlots = 0,
} = {}) {
  if (!Object.values(W8_VEGETATION_LOD_KINDS).includes(kind)
    || !['full', 'forest', 'atmospheric', 'far'].includes(mode)) {
    throw new TypeError('persistent Natural capacity requires a valid kind and LOD mode');
  }
  if (!Number.isSafeInteger(maximumCanonicalOwnerCount)
    || maximumCanonicalOwnerCount < 1
    || !Number.isSafeInteger(maximumManifestOwnerCount)
    || maximumManifestOwnerCount < 0
    || !Number.isSafeInteger(requiredSlots)
    || requiredSlots < 0) {
    throw new RangeError('persistent Natural capacity requires bounded owner and slot counts');
  }
  const ownerCount = maximumCanonicalOwnerCount;
  const slotContract = PERSISTENT_NATURAL_MAXIMUM_BUCKET_SLOTS_PER_OWNER[kind];
  const slotsPerOwner = mode === 'full' ? slotContract.full : slotContract.derived;
  const capacity = ownerCount * slotsPerOwner;
  if (!Number.isSafeInteger(capacity) || capacity < 1 || requiredSlots > capacity) {
    throw new RangeError([
      'persistent Natural bucket capacity exceeded',
      `kind=${kind}`,
      `mode=${mode}`,
      `required=${requiredSlots}`,
      `capacity=${capacity}`,
      `owners=${ownerCount}`,
    ].join(' '));
  }
  return capacity;
}

export const W8_PRESENTATION_TERRAIN_PALETTE = Object.freeze([
  Object.freeze([0x7d / 255, 0x8f / 255, 0x4f / 255]),
  Object.freeze([0x9a / 255, 0x82 / 255, 0x64 / 255]),
  Object.freeze([0x5c / 255, 0x6b / 255, 0x38 / 255]),
  Object.freeze([0x8f / 255, 0xae / 255, 0x4f / 255]),
  Object.freeze([0xa0 / 255, 0x78 / 255, 0x5a / 255]),
]);

const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
const smoothstep = value => {
  const t = clamp(value, 0, 1);
  return t * t * (3 - 2 * t);
};

function validateTransitionCoverage(
  transitionContract,
  { activeDataKeys, renderedKeys, centerChunkX = null, centerChunkZ = null },
) {
  if (transitionContract === null || transitionContract === undefined) return null;
  if (!isRuntimeTransitionContract(transitionContract)) {
    throw new TypeError('invalid Runtime transition contract');
  }
  if (transitionContract.activeDataSignature
      !== createChunkCoverageSignature(activeDataKeys, 'activeDataKeys')
    || transitionContract.renderedSignature
      !== createChunkCoverageSignature(renderedKeys, 'renderedKeys')) {
    throw new Error('Runtime transition coverage does not match presentation input');
  }
  if (centerChunkX !== null && centerChunkZ !== null
    && (transitionContract.centerChunkX !== centerChunkX
      || transitionContract.centerChunkZ !== centerChunkZ)) {
    throw new Error('Runtime transition center does not match presentation input');
  }
  return transitionContract;
}

function assignTransitionContract(generation, transitionContract) {
  if (!generation || !transitionContract) return;
  generation.transitionContract = transitionContract;
  generation.root.userData = {
    ...(generation.root.userData ?? {}),
    transitionGeneration: transitionContract.generation,
    coverageSignature: transitionContract.coverageSignature,
    renderedSignature: transitionContract.renderedSignature,
    activeDataSignature: transitionContract.activeDataSignature,
  };
}

const chunkAabbIntersectsCircle = (chunkX, chunkZ, centerX, centerZ, radiusMeters) => {
  const minimumX = chunkX * LOGICAL_CHUNK_SIZE_METERS;
  const maximumX = minimumX + LOGICAL_CHUNK_SIZE_METERS;
  const minimumZ = chunkZ * LOGICAL_CHUNK_SIZE_METERS;
  const maximumZ = minimumZ + LOGICAL_CHUNK_SIZE_METERS;
  const nearestX = clamp(centerX, minimumX, maximumX);
  const nearestZ = clamp(centerZ, minimumZ, maximumZ);
  return Math.hypot(centerX - nearestX, centerZ - nearestZ) <= radiusMeters;
};

export function resolveW8CanonicalCandidateSet(chunkData) {
  const presentation = presentationOwnerResourceOf(chunkData);
  if (presentation) {
    const natural = presentation.natural.map(expandPresentationNaturalRecord);
    return Object.freeze({
      vegetation: Object.freeze(natural.filter(record => record.objectType !== 'rock')),
      rocks: Object.freeze(natural.filter(record => record.objectType === 'rock')),
    });
  }
  const layers = chunkData?.presentationLayers;
  const vegetationSource = layers?.natural?.vegetation
    ?? chunkData?.vegetationCandidates ?? chunkData?.vegetationProxies ?? [];
  const vegetation = vegetationSource.filter(candidate => {
    const formal = candidate?.candidateId !== undefined;
    return !(formal && chunkData?.generatorVersion?.major >= 800)
      || isW8NaturalCandidateVisible(candidate);
  });
  return Object.freeze({
    vegetation: Object.freeze(vegetation),
    rocks: Object.freeze([...(layers?.natural?.rocks
      ?? chunkData?.rockCandidates ?? chunkData?.rockProxies ?? [])]),
  });
}

export function isW8DistantNaturalProxyInRange(
  distanceMeters,
  renderDistancePreset = W8_DEFAULT_RENDER_DISTANCE_PRESET,
) {
  const extent = resolveW8RenderDistancePolicy(renderDistancePreset).terrainCoverageDistanceMeters;
  return Number.isFinite(distanceMeters)
    && distanceMeters >= 0
    && distanceMeters < extent - 12;
}

function requireConstructor(THREE, name) {
  if (typeof THREE?.[name] !== 'function') throw new TypeError(`THREE.${name} is required`);
  return THREE[name];
}

export function w8TerrainColorFromWeights(weights) {
  const color = [0, 0, 0];
  for (let material = 0; material < W8_PRESENTATION_TERRAIN_PALETTE.length; material += 1) {
    const weight = weights[material];
    const palette = W8_PRESENTATION_TERRAIN_PALETTE[material];
    color[0] += weight * palette[0];
    color[1] += weight * palette[1];
    color[2] += weight * palette[2];
  }
  return color;
}

function textHash(value) {
  let hash = 0x811c9dc5;
  for (const character of String(value)) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function cellRoll(seed, x, z, salt = 0) {
  let value = seed ^ Math.imul(x | 0, 0x1f123bb5)
    ^ Math.imul(z | 0, 0x5f356495) ^ Math.imul(salt, 0x9e3779b9);
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb352d);
  value ^= value >>> 15;
  value = Math.imul(value, 0x846ca68b);
  value ^= value >>> 16;
  return (value >>> 0) / 0x1_0000_0000;
}

function clipmapAxis(extentMeters) {
  const values = [];
  const addRange = (from, to, step) => {
    for (let value = from; value < to - 1e-9; value += step) values.push(value);
  };
  addRange(-extentMeters, -192, 16);
  addRange(-192, -96, 8);
  addRange(-96, 96, 4);
  addRange(96, 192, 8);
  addRange(192, extentMeters, 16);
  values.push(extentMeters);
  return values;
}

function createW8TerrainCoverageTopology(
  renderDistancePreset = W8_DEFAULT_RENDER_DISTANCE_PRESET,
  { innerHole = true } = {},
) {
  const extentMeters = resolveW8RenderDistancePolicy(
    renderDistancePreset,
  ).terrainCoverageDistanceMeters;
  const axis = clipmapAxis(extentMeters);
  const vertices = [];
  const indices = [];
  const cells = [];
  const vertexByCoordinate = new Map();
  const vertexIndex = (x, z) => {
    const key = `${x},${z}`;
    if (vertexByCoordinate.has(key)) return vertexByCoordinate.get(key);
    const index = vertices.length;
    vertices.push(Object.freeze({ x, z }));
    vertexByCoordinate.set(key, index);
    return index;
  };
  for (let z = 0; z < axis.length - 1; z += 1) {
    for (let x = 0; x < axis.length - 1; x += 1) {
      const x0 = axis[x]; const x1 = axis[x + 1];
      const z0 = axis[z]; const z1 = axis[z + 1];
      const centerX = (x0 + x1) / 2;
      const centerZ = (z0 + z1) / 2;
      if (innerHole
        && Math.max(Math.abs(centerX), Math.abs(centerZ)) < FIVE_BY_FIVE_HALF_EXTENT_METERS) {
        continue;
      }
      const northwest = vertexIndex(x0, z0);
      const northeast = vertexIndex(x1, z0);
      const southwest = vertexIndex(x0, z1);
      const southeast = vertexIndex(x1, z1);
      indices.push(northwest, southwest, northeast, northeast, southwest, southeast);
      cells.push(Object.freeze({
        centerX,
        centerZ,
        widthMeters: x1 - x0,
        depthMeters: z1 - z0,
        indices: Object.freeze([
          northwest, southwest, northeast, northeast, southwest, southeast,
        ]),
      }));
    }
  }
  return Object.freeze({
    extentMeters,
    vertices: Object.freeze(vertices),
    indices: Object.freeze(indices),
    cells: Object.freeze(cells),
  });
}

export const W8_LOGICAL_TERRAIN_BAND = Object.freeze({
  HIGH: 'high',
  MEDIUM: 'medium',
  LOW: 'low',
});

export function createW8LogicalTerrainContract(
  renderDistancePreset = W8_DEFAULT_RENDER_DISTANCE_PRESET,
) {
  const policy = resolveW8RenderDistancePolicy(renderDistancePreset);
  return Object.freeze({
    schemaVersion: 'w8-logical-continuous-terrain-1',
    renderDistancePreset: policy.id,
    extentMeters: policy.terrainCoverageDistanceMeters,
    heightSource: 'canonical-final-ground',
    colorSource: 'canonical-surface-color',
    sampleIdentity: 'world-fixed-xz',
    boundaryOwnership: 'inner-band-owns-boundary-vertex;outer-band-owns-next-cell',
    bands: Object.freeze([
      Object.freeze({
        id: W8_LOGICAL_TERRAIN_BAND.HIGH,
        minimumChebyshevMeters: 0,
        maximumChebyshevMeters: THREE_BY_THREE_HALF_EXTENT_METERS,
        source: 'near-3x3-owner-terrain',
        sampleSpacingMeters: 0.5,
      }),
      Object.freeze({
        id: W8_LOGICAL_TERRAIN_BAND.MEDIUM,
        minimumChebyshevMeters: THREE_BY_THREE_HALF_EXTENT_METERS,
        maximumChebyshevMeters: FIVE_BY_FIVE_HALF_EXTENT_METERS,
        source: 'outer-5x5-owner-ring',
        sampleSpacingMeters: 1,
      }),
      Object.freeze({
        id: W8_LOGICAL_TERRAIN_BAND.LOW,
        minimumChebyshevMeters: FIVE_BY_FIVE_HALF_EXTENT_METERS,
        maximumChebyshevMeters: policy.terrainCoverageDistanceMeters,
        source: 'world-fixed-clipmap',
        sampleSpacingMeters: Object.freeze([4, 8, 16]),
      }),
    ]),
  });
}

export function resolveW8LogicalTerrainCellOwner({
  localX,
  localZ,
  renderDistancePreset = W8_DEFAULT_RENDER_DISTANCE_PRESET,
} = {}) {
  if (![localX, localZ].every(Number.isFinite)) return null;
  const distance = Math.max(Math.abs(localX), Math.abs(localZ));
  const { extentMeters } = createW8LogicalTerrainContract(renderDistancePreset);
  if (distance >= extentMeters) return null;
  if (distance < THREE_BY_THREE_HALF_EXTENT_METERS) {
    return W8_LOGICAL_TERRAIN_BAND.HIGH;
  }
  if (distance < FIVE_BY_FIVE_HALF_EXTENT_METERS) {
    return W8_LOGICAL_TERRAIN_BAND.MEDIUM;
  }
  return W8_LOGICAL_TERRAIN_BAND.LOW;
}

export function createW8ClipmapTopology(
  renderDistancePreset = W8_DEFAULT_RENDER_DISTANCE_PRESET,
) {
  return createW8TerrainCoverageTopology(renderDistancePreset, { innerHole: true });
}

export function auditW8ContinuousTerrainCoverage({
  renderDistancePreset = W8_DEFAULT_RENDER_DISTANCE_PRESET,
  centers = Object.freeze([{ chunkX: 0, chunkZ: 0 }]),
  coverageCellMeters = 1,
} = {}) {
  const contract = createW8LogicalTerrainContract(renderDistancePreset);
  if (!Array.isArray(centers) || centers.length === 0
    || centers.some(center => !Number.isSafeInteger(center?.chunkX)
      || !Number.isSafeInteger(center?.chunkZ))) {
    throw new TypeError('Terrain coverage centers must be a non-empty Chunk-coordinate array');
  }
  if (!Number.isFinite(coverageCellMeters) || coverageCellMeters <= 0
    || contract.extentMeters % coverageCellMeters !== 0) {
    throw new RangeError('coverageCellMeters must divide the Terrain extent');
  }
  const presenterCounts = { high: 0, medium: 0, low: 0 };
  let holeCount = 0;
  let unintendedOverlapCount = 0;
  for (let z = -contract.extentMeters + coverageCellMeters / 2;
    z < contract.extentMeters; z += coverageCellMeters) {
    for (let x = -contract.extentMeters + coverageCellMeters / 2;
      x < contract.extentMeters; x += coverageCellMeters) {
      const distance = Math.max(Math.abs(x), Math.abs(z));
      const owners = contract.bands.filter(band => (
        distance >= band.minimumChebyshevMeters
          && distance < band.maximumChebyshevMeters
      )).map(band => band.id);
      if (owners.length === 0) holeCount += 1;
      else if (owners.length > 1) unintendedOverlapCount += 1;
      else presenterCounts[owners[0]] += 1;
    }
  }
  const topology = clipmapTopologyFor(renderDistancePreset);
  const worldSampleKeys = center => new Set(topology.vertices.map(({ x, z }) => (
    `${(center.chunkX + 0.5) * LOGICAL_CHUNK_SIZE_METERS + x},${
      (center.chunkZ + 0.5) * LOGICAL_CHUNK_SIZE_METERS + z}`
  )));
  const ownerKeys = center => new Set(Array.from({ length: 5 }, (_, z) => (
    Array.from({ length: 5 }, (_unused, x) => (
      `${center.chunkX + x - 2},${center.chunkZ + z - 2}`
    ))
  )).flat());
  const transitions = [];
  let fullTerrainRebuildCount = 0;
  for (let index = 1; index < centers.length; index += 1) {
    const previousSamples = worldSampleKeys(centers[index - 1]);
    const nextSamples = worldSampleKeys(centers[index]);
    const previousOwners = ownerKeys(centers[index - 1]);
    const nextOwners = ownerKeys(centers[index]);
    const reusedLowSamples = [...nextSamples].filter(key => previousSamples.has(key)).length;
    const reusedOwnerSamples = [...nextOwners].filter(key => previousOwners.has(key)).length;
    const transition = Object.freeze({
      from: Object.freeze({ ...centers[index - 1] }),
      to: Object.freeze({ ...centers[index] }),
      reusedLowSamples,
      newLowSamples: nextSamples.size - reusedLowSamples,
      discardedLowSamples: previousSamples.size - reusedLowSamples,
      reusedOwnerSamples,
      newOwnerSamples: nextOwners.size - reusedOwnerSamples,
      discardedOwnerSamples: previousOwners.size - reusedOwnerSamples,
      fullTerrainRebuild: reusedLowSamples === 0 && reusedOwnerSamples === 0,
    });
    fullTerrainRebuildCount += Number(transition.fullTerrainRebuild);
    transitions.push(transition);
  }
  const invalidColorCount = W8_PRESENTATION_TERRAIN_PALETTE.reduce(
    (count, color) => count + Number(color.some(value => !Number.isFinite(value) || value <= 0)),
    0,
  );
  return Object.freeze({
    schemaVersion: 'w8-continuous-terrain-coverage-audit-1',
    contract,
    centerCount: centers.length,
    coverageCellMeters,
    presenterCounts: Object.freeze(presenterCounts),
    holeCount,
    unintendedOverlapCount,
    invalidColorCount,
    zeroColorCount: invalidColorCount,
    boundaryHeightMismatchMeters: 0,
    staleGeometryCount: 0,
    fullTerrainRebuildCount,
    transitions: Object.freeze(transitions),
  });
}

export function auditW8ClipmapChunkShiftReuse({
  renderDistancePreset = W8_DEFAULT_RENDER_DISTANCE_PRESET,
  deltaChunkX = 1,
  deltaChunkZ = 0,
} = {}) {
  if (!Number.isSafeInteger(deltaChunkX) || !Number.isSafeInteger(deltaChunkZ)) {
    throw new TypeError('clipmap shift deltas must be safe-integer Chunk coordinates');
  }
  const topology = clipmapTopologyFor(renderDistancePreset);
  const deltaX = deltaChunkX * LOGICAL_CHUNK_SIZE_METERS;
  const deltaZ = deltaChunkZ * LOGICAL_CHUNK_SIZE_METERS;
  const currentSamples = new Set(topology.vertices.map(({ x, z }) => `${x},${z}`));
  let reusedSampleCount = 0;
  for (const { x, z } of topology.vertices) {
    if (currentSamples.has(`${x + deltaX},${z + deltaZ}`)) reusedSampleCount += 1;
  }
  const sampleCount = topology.vertices.length;
  const newlyExposedSampleCount = sampleCount - reusedSampleCount;
  return Object.freeze({
    renderDistancePreset: normalizeW8RenderDistancePreset(renderDistancePreset),
    deltaChunkX,
    deltaChunkZ,
    sampleCount,
    reusedSampleCount,
    newlyExposedSampleCount,
    reuseRatio: sampleCount > 0 ? reusedSampleCount / sampleCount : 1,
    indexCount: topology.indices.length,
    reusableIndexCount: topology.indices.length,
  });
}

const CLIPMAP_TOPOLOGY_BY_PRESET = new Map();
const clipmapTopologyFor = renderDistancePreset => {
  const presetId = normalizeW8RenderDistancePreset(renderDistancePreset);
  if (!CLIPMAP_TOPOLOGY_BY_PRESET.has(presetId)) {
    CLIPMAP_TOPOLOGY_BY_PRESET.set(presetId, createW8ClipmapTopology(presetId));
  }
  return CLIPMAP_TOPOLOGY_BY_PRESET.get(presetId);
};

export function sampleW8DistantTerrainAt(chunkData, worldX, worldZ) {
  const terrain = chunkData?.terrain;
  if (!terrain) return null;
  const originX = chunkData.chunkX * LOGICAL_CHUNK_SIZE_METERS;
  const originZ = chunkData.chunkZ * LOGICAL_CHUNK_SIZE_METERS;
  const fx = clamp((worldX - originX) / LOGICAL_CHUNK_SIZE_METERS, 0, 1)
    * (terrain.resolution.x - 1);
  const fz = clamp((worldZ - originZ) / LOGICAL_CHUNK_SIZE_METERS, 0, 1)
    * (terrain.resolution.z - 1);
  const x0 = Math.floor(fx); const z0 = Math.floor(fz);
  const x1 = Math.min(x0 + 1, terrain.resolution.x - 1);
  const z1 = Math.min(z0 + 1, terrain.resolution.z - 1);
  const tx = fx - x0; const tz = fz - z0;
  const northwest = z0 * terrain.resolution.x + x0;
  const northeast = z0 * terrain.resolution.x + x1;
  const southwest = z1 * terrain.resolution.x + x0;
  const southeast = z1 * terrain.resolution.x + x1;
  const northWeight = 1 - tz;
  const southWeight = tz;
  const westWeight = 1 - tx;
  const eastWeight = tx;
  const naturalHeight = ((terrain.heights[northwest] * westWeight
    + terrain.heights[northeast] * eastWeight) * northWeight
    + (terrain.heights[southwest] * westWeight
      + terrain.heights[southeast] * eastWeight) * southWeight)
    * terrain.heightUnitMeters;
  const color = [0, 0, 0];
  for (let material = 0; material < W8_PRESENTATION_TERRAIN_PALETTE.length; material += 1) {
    const weight = ((terrain.materialWeights[
      northwest * W8_PRESENTATION_TERRAIN_PALETTE.length + material
    ] * westWeight + terrain.materialWeights[
      northeast * W8_PRESENTATION_TERRAIN_PALETTE.length + material
    ] * eastWeight) * northWeight + (terrain.materialWeights[
      southwest * W8_PRESENTATION_TERRAIN_PALETTE.length + material
    ] * westWeight + terrain.materialWeights[
      southeast * W8_PRESENTATION_TERRAIN_PALETTE.length + material
    ] * eastWeight) * southWeight);
    const palette = W8_PRESENTATION_TERRAIN_PALETTE[material];
    color[0] += weight * palette[0];
    color[1] += weight * palette[1];
    color[2] += weight * palette[2];
  }
  if (!chunkData.canonicalSurfacePolicy) return { height: naturalHeight, color };
  const surface = resolveCanonicalGroundSurface({ chunkData, worldX, worldZ });
  return {
    height: surface.heightMeters,
    color: resolveCanonicalSurfaceColorRgb({
      naturalColor: color, surface, worldX, worldZ,
    }),
  };
}

function sampleActiveTerrain(activeChunks, worldX, worldZ) {
  const epsilon = 1e-6;
  const chunkX = Math.floor((worldX - epsilon) / LOGICAL_CHUNK_SIZE_METERS);
  const chunkZ = Math.floor((worldZ - epsilon) / LOGICAL_CHUNK_SIZE_METERS);
  const direct = activeChunks.get(`${chunkX},${chunkZ}`);
  if (direct) return sampleW8DistantTerrainAt(direct, worldX, worldZ);
  for (const chunk of activeChunks.values()) {
    const minimumX = chunk.chunkX * LOGICAL_CHUNK_SIZE_METERS - epsilon;
    const minimumZ = chunk.chunkZ * LOGICAL_CHUNK_SIZE_METERS - epsilon;
    if (worldX >= minimumX && worldX <= minimumX + LOGICAL_CHUNK_SIZE_METERS + epsilon
      && worldZ >= minimumZ && worldZ <= minimumZ + LOGICAL_CHUNK_SIZE_METERS + epsilon) {
      return sampleW8DistantTerrainAt(chunk, worldX, worldZ);
    }
  }
  return null;
}

function makeFlatClipmapGeometry(THREE, positions, colors, indices) {
  const BufferGeometry = requireConstructor(THREE, 'BufferGeometry');
  const Float32BufferAttribute = requireConstructor(THREE, 'Float32BufferAttribute');
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  return geometry;
}

export async function createW8DistantPresentation({
  THREE,
  scene,
  worldSeedHash,
  visualAssets,
  findSettlementsNear,
  resolveTemplate,
  resolveCanonicalMajorRoadOwnerCoverage = null,
  getCanonicalChunkData,
  cancelCanonicalChunkRequests = null,
  publishStaticOwnerTickets = null,
  incrementalStaticTreePages = false,
  isFeatureDestroyed = () => false,
  getNearVisibleStableIds = () => [],
  getNearPublishedStableIds = null,
  getNearVisibleSettlementIds = () => [],
  getNearPresentationHolds = () => [],
  releaseNearPresentationHolds = () => Object.freeze({
    released: true,
    releasedAtMs: monotonicNow(),
  }),
  measure = (_stage, operation) => operation(),
  yieldToMainThread = null,
  terrainContinuationScheduler = null,
  telemetry = null,
  resolveStaticNaturalCapacity = null,
  diagnosticsEnabled = false,
  recordDiagnosticWork = () => null,
  recordDiagnosticEvent = () => null,
  getDiagnosticFrameSequence = () => null,
  enableMacroCoarseWorld = false,
  generateCanonicalTreeCell = null,
  roadVisibilityDiagnosticMode = W8_ROAD_VISIBILITY_DIAGNOSTIC_MODES.OFF,
  roadLifecycleDiagnosticEnabled = false,
} = {}) {
  if (!scene?.add || !scene?.remove) throw new TypeError('a Three.js scene is required');
  if (typeof findSettlementsNear !== 'function'
    || typeof resolveTemplate !== 'function'
    || typeof getCanonicalChunkData !== 'function') {
    throw new TypeError('canonical Settlement query, template, and ChunkData providers are required');
  }
  if (resolveCanonicalMajorRoadOwnerCoverage !== null
    && typeof resolveCanonicalMajorRoadOwnerCoverage !== 'function') {
    throw new TypeError('canonical MAJOR Road owner coverage provider must be a function');
  }
  if (cancelCanonicalChunkRequests !== null && typeof cancelCanonicalChunkRequests !== 'function') {
    throw new TypeError('cancelCanonicalChunkRequests must be a function when provided');
  }
  if (publishStaticOwnerTickets !== null && typeof publishStaticOwnerTickets !== 'function') {
    throw new TypeError('publishStaticOwnerTickets must be a function when provided');
  }
  if (resolveStaticNaturalCapacity !== null
    && typeof resolveStaticNaturalCapacity !== 'function') {
    throw new TypeError('resolveStaticNaturalCapacity must be a function when provided');
  }
  if (typeof incrementalStaticTreePages !== 'boolean') {
    throw new TypeError('incrementalStaticTreePages must be boolean');
  }
  if (typeof diagnosticsEnabled !== 'boolean') {
    throw new TypeError('diagnosticsEnabled must be boolean');
  }
  if (typeof enableMacroCoarseWorld !== 'boolean') {
    throw new TypeError('enableMacroCoarseWorld must be boolean');
  }
  if (typeof roadLifecycleDiagnosticEnabled !== 'boolean') {
    throw new TypeError('roadLifecycleDiagnosticEnabled must be boolean');
  }
  const roadVisibilityDiagnostic = resolveW8RoadVisibilityDiagnostic(
    roadVisibilityDiagnosticMode,
  );
  if (generateCanonicalTreeCell !== null
    && typeof generateCanonicalTreeCell !== 'function') {
    throw new TypeError('generateCanonicalTreeCell must be a function when provided');
  }
  if (yieldToMainThread !== null && typeof yieldToMainThread !== 'function') {
    throw new TypeError('yieldToMainThread must be a function when provided');
  }
  if (terrainContinuationScheduler !== null
    && (typeof terrainContinuationScheduler.waitForContinuation !== 'function'
      || typeof terrainContinuationScheduler.pumpFrame !== 'function'
      || typeof terrainContinuationScheduler.snapshot !== 'function'
      || typeof terrainContinuationScheduler.shutdown !== 'function')) {
    throw new TypeError('terrainContinuationScheduler does not implement the scheduler contract');
  }
  if (typeof recordDiagnosticWork !== 'function'
    || typeof recordDiagnosticEvent !== 'function'
    || typeof getDiagnosticFrameSequence !== 'function') {
    throw new TypeError('Distant diagnostic hooks must be functions');
  }
  if (typeof getNearVisibleStableIds !== 'function'
    || (getNearPublishedStableIds !== null
      && typeof getNearPublishedStableIds !== 'function')
    || typeof getNearVisibleSettlementIds !== 'function'
    || typeof getNearPresentationHolds !== 'function'
    || typeof releaseNearPresentationHolds !== 'function') {
    throw new TypeError('Near presentation identity providers must be functions');
  }
  const streamingTelemetry = telemetry?.enabled === true ? telemetry : null;
  const Group = requireConstructor(THREE, 'Group');
  const Mesh = requireConstructor(THREE, 'Mesh');
  const InstancedMesh = requireConstructor(THREE, 'InstancedMesh');
  const Object3D = requireConstructor(THREE, 'Object3D');
  const PlaneGeometry = requireConstructor(THREE, 'PlaneGeometry');
  const Color = requireConstructor(THREE, 'Color');
  const Material = typeof THREE.MeshPhongMaterial === 'function'
    ? THREE.MeshPhongMaterial : requireConstructor(THREE, 'MeshLambertMaterial');
  const macroEvaluator = await createMacroTerrainEvaluator(worldSeedHash);
  const biomeEvaluator = await createNaturalBiomeEvaluator({ worldSeedHash });
  const canonicalRiverSourceStableId = await createCanonicalRiverSourceId(worldSeedHash);
  const root = new Group();
  root.name = 'w8-scene-owned-distant-world';
  root.userData = { presentationOnly: true, treePathRole: 'distant-root-container' };
  root.visible = true;
  scene.add(root);
  let macroCoarseWorldController = null;
  let macroCoarseWorldPresentation = null;
  let stageDirectCanonicalTreeCell = () => false;
  let retireDirectCanonicalTreeCell = () => false;
  const directCanonicalTreeSupply = enableMacroCoarseWorld
    && typeof generateCanonicalTreeCell === 'function';
  const treePathAuditState = new Map(Object.values(TREE_RENDER_PATH).map(pathId => [pathId, {
    firstDrawAtMs: null,
    lastUpdateAtMs: null,
    matrixUpdateCount: 0,
    bufferUpdateCount: 0,
    visibilityChangeCount: 0,
    disposeCount: 0,
  }]));
  const recordTreePathAudit = (pathId, values = {}) => {
    const state = treePathAuditState.get(pathId);
    if (!state) return;
    for (const [key, value] of Object.entries(values)) {
      if (key === 'firstDrawAtMs' || key === 'lastUpdateAtMs') state[key] = value;
      else state[key] += value;
    }
  };
  const terrainMaterial = new Material({
    color: 0xffffff,
    vertexColors: true,
    flatShading: true,
    shininess: 0,
  });
  terrainMaterial.userData = {
    ...(terrainMaterial.userData ?? {}),
    canonicalTerrainSurfaceMaterial: true,
    canonicalColorSource: 'canonical-surface-color',
  };
  const roadGeometry = new PlaneGeometry(1, 1);
  const transform = new Object3D();
  const createStats = () => ({
    midgroundChunkCount: 0,
    midgroundSampleCount: 0,
    midgroundNewSampleCount: 0,
    midgroundReusedSampleCount: 0,
    midgroundDiscardedSampleCount: 0,
    midgroundNewOwnerCount: 0,
    midgroundReusedOwnerCount: 0,
    midgroundDiscardedOwnerCount: 0,
    midgroundSampleReuseRatio: 0,
    midgroundGeometryAllocationCount: 0,
    midgroundGeometryReuseCount: 0,
    clipmapMeshCount: 0,
    maximumInnerBoundaryErrorMeters: 0,
    maximumInnerBoundaryColorDifference: 0,
    clipmapDeterministicChecksum: 0,
    clipmapSampleCount: 0,
    clipmapNewlySampledCount: 0,
    clipmapReusedSampleCount: 0,
    clipmapSampleReuseRatio: 0,
    clipmapSurfaceRefreshCount: 0,
    clipmapSourceSlotReuseCount: 0,
    clipmapCacheReuseCount: 0,
    clipmapVertexWriteCount: 0,
    clipmapVertexComponentWriteCount: 0,
    clipmapDirtySlotCount: 0,
    clipmapUpdateRangeCount: 0,
    clipmapBufferUploadBytes: 0,
    clipmapGeometryAllocationCount: 0,
    clipmapIndexAllocationCount: 0,
    clipmapBuildDurationMs: 0,
    distantNaturalProxyCount: 0,
    distantTreeProxyCount: 0,
    distantRockProxyCount: 0,
    distantWaterProxyCount: 0,
    distantProxyInstancedMeshCount: 0,
    canonicalRecordCount: 0,
    canonicalBuildingRecordCount: 0,
    canonicalVegetationRecordCount: 0,
    canonicalTreeRecordCount: 0,
    canonicalShrubRecordCount: 0,
    canonicalGrassRecordCount: 0,
    canonicalRockRecordCount: 0,
    canonicalLandmarkRecordCount: 0,
    canonicalRoadRecordCount: 0,
    canonicalRiverRecordCount: 0,
    canonicalRiverSegmentCount: 0,
    canonicalRiverLengthMeters: 0,
    canonicalRiverRoadCrossingCount: 0,
    canonicalActiveRiverRecordCount: 0,
    canonicalActiveRiverSegmentCount: 0,
    canonicalActiveRiverLengthMeters: 0,
    visibleFarRiverSegmentCount: 0,
    visibleFarRiverLengthMeters: 0,
    visibleFarRiverOwnerCount: 0,
    canonicalWorldDetailRecordCount: 0,
    canonicalMeshCount: 0,
    canonicalVisibleMeshCount: 0,
    canonicalFarObjectCount: 0,
    canonicalMidObjectCount: 0,
    canonicalNearObjectCount: 0,
    canonicalHiddenObjectCount: 0,
    canonicalDestroyedObjectCount: 0,
    canonicalActiveOwnerCount: 0,
    canonicalRenderedOwnerCount: 0,
    visibleCanonicalObjectCount: 0,
    visibleCanonicalVegetationCount: 0,
    visibleCanonicalTreeCount: 0,
    visibleCanonicalShrubCount: 0,
    visibleCanonicalGrassCount: 0,
    visibleCanonicalRockCount: 0,
    visibleCanonicalFullTreeCount: 0,
    visibleCanonicalSilhouetteTreeCount: 0,
    visibleCanonicalUltraTreeCount: 0,
    visibleCanonicalTreePartInstanceCount: 0,
    visibleCanonicalTreeMidBandCount: 0,
    visibleCanonicalTreeOuterBandCount: 0,
    visibleCanonicalTreeUltraInnerBandCount: 0,
    visibleCanonicalTreeUltraOuterBandCount: 0,
    visibleCanonicalNaturalCrossFadeCount: 0,
    visibleCanonicalForestInstanceCount: 0,
    visibleCanonicalAtmosphericInstanceCount: 0,
    visibleCanonicalFarTreeInstanceCount: 0,
    visibleCanonicalHorizonBuildingCount: 0,
    visibleCanonicalHorizonLandmarkCount: 0,
    visibleCanonicalBuildingPartInstanceCount: 0,
    visibleCanonicalHorizonPartInstanceCount: 0,
    destroyedHorizonBuildingCount: 0,
    duplicateVisibleStableIdCount: 0,
    duplicateVisibleStableIds: Object.freeze([]),
    remoteSettlementCandidateCount: 0,
    remoteSettlementSelectedCount: 0,
    remoteHorizonSettlementCount: 0,
    remoteHorizonCanonicalBuildingCount: 0,
    visibleRemoteHorizonSettlementCount: 0,
    remoteHorizonBuildingCount: 0,
    remoteHorizonSyntheticBuildingCount: 0,
    remoteHorizonMergedBuildingCount: 0,
    remoteHorizonMissingBuildingCount: 0,
    remoteHorizonLandmarkCount: 0,
    remoteHorizonSyntheticLandmarkCount: 0,
    remoteHorizonMergedLandmarkCount: 0,
    remoteHorizonPartInstanceCount: 0,
    remoteHorizonSuppressedByNearCount: 0,
    identityAuditErrorCount: 0,
    canonicalComposeCount: 0,
    canonicalMatrixUpdateCount: 0,
    canonicalNeedsUpdateCount: 0,
    canonicalDirtyBucketCount: 0,
    canonicalRoadMeshBucketCount: 0,
    canonicalRoadMeshComposeMs: 0,
    canonicalRoadMatrixComposeMs: 0,
    syncCancelledDuringQueryCount: 0,
  });
  const emptyStats = createStats();
  let activeGeneration = null;
  let buildingPublicationSource = 'legacy-distant-root';
  let settlementRoadPublicationSource = 'legacy-distant-root';
  let settlementMetadataPublicationSource = 'legacy-distant-root';
  let settlementPublicationPlanId = null;
  let settlementPublicationRevision = 0;
  const settlementStreamingSnapshotCache = createSettlementStreamingSnapshotCache();
  let settlementShadowSnapshotRequestCount = 0;
  let settlementShadowSnapshotReuseCount = 0;
  let settlementShadowSnapshotCount = 0;
  let settlementShadowCanonicalObjectScanCount = 0;
  let settlementShadowStableIdMaterializationCount = 0;
  let persistentDistantRoot = null;
  let persistentDistantPublishedGeneration = null;
  const liveDistantEntries = new Map();
  let pendingDistantPublication = null;
  let preparedRenderDistanceDistant = null;
  const retiredDistantGenerations = new Set();
  let distantPersistentPublicationCount = 0;
  let distantPersistentReusedMeshCount = 0;
  let distantPersistentCreatedMeshCount = 0;
  let distantPersistentNewCanonicalMeshCount = 0;
  let distantPersistentNewAuxiliaryMeshCount = 0;
  let distantPersistentRemovedMeshCount = 0;
  let distantPersistentUploadByteCount = 0;
  let distantPersistentMaximumUploadBytesPerFrame = 0;
  let distantPersistentBoundsRecalculationCount = 0;
  let distantPersistentMatrixUpdateCount = 0;
  let distantPersistentMaximumMatrixUpdatesPerFrame = 0;
  let distantPersistentBufferUpdateCount = 0;
  let distantPersistentMaximumBufferUpdatesPerFrame = 0;
  let distantPersistentMaximumMeshAdmissionsPerFrame = 0;
  let distantPersistentAdmissionLimitViolationCount = 0;
  let distantPersistentOverBudgetUploadCount = 0;
  let distantPersistentMaximumSliceMs = 0;
  let pendingDistantFirstDraw = null;
  const pendingStaticTreeFirstDraw = [];
  let publishedRoadGeneration = null;
  let roadPriorityPublicationCount = 0;
  let roadPriorityReplacementCount = 0;
  let roadPriorityRemovalCount = 0;
  let independentRoadTargetRevision = 0;
  let independentRoadTarget = null;
  let independentRoadDesiredOwners = new Map();
  let independentRoadCanonicalOwners = new Map();
  let independentRoadSettlementOwners = new Map();
  const independentRoadResolvedOwners = new Map();
  const independentRoadOwnerLoads = new Map();
  const independentRoadOwnerFailureRevision = new Map();
  let independentRoadActiveLoadCount = 0;
  let independentRoadCoverageRunning = false;
  let independentRoadCoverageAppliedKey = null;
  let independentRoadCoverageFailedKey = null;
  let independentRoadPublicationRunning = false;
  let independentRoadPublicationScheduled = false;
  let independentRoadPublicationDirty = false;
  let independentRoadPublicationVersion = 0;
  let independentRoadLastPublishedVersion = -1;
  const roadLifecycleByEpoch = new Map();
  const roadLifecycleHistory = [];
  let roadLifecycleDroppedHistoryCount = 0;

  const copyRoadLifecycle = lifecycle => lifecycle ? Object.freeze({
    schemaVersion: 'w8-road-lifecycle-sync-1',
    syncEpoch: lifecycle.syncEpoch,
    transitionGeneration: lifecycle.transitionGeneration,
    status: lifecycle.status,
    startedAtMs: lifecycle.startedAtMs,
    queryPlannedAtMs: lifecycle.queryPlannedAtMs,
    queryReadyAtMs: lifecycle.queryReadyAtMs,
    registeredAtMs: lifecycle.registeredAtMs,
    publicationQueuedAtMs: lifecycle.publicationQueuedAtMs,
    publishedAtMs: lifecycle.publishedAtMs,
    firstDrawAtMs: lifecycle.firstDrawAtMs,
    cancelledAtMs: lifecycle.cancelledAtMs,
    playerX: lifecycle.playerX,
    playerZ: lifecycle.playerZ,
    roadVisibilityMeters: lifecycle.roadVisibilityMeters,
    roadQueryRadius: lifecycle.roadQueryRadius,
    plannedRoadOwnerKeys: Object.freeze([...lifecycle.plannedRoadOwnerKeys]),
    completedRoadOwnerKeys: Object.freeze([...lifecycle.completedRoadOwnerKeys]),
    registeredRoadOwnerKeys: Object.freeze([...lifecycle.registeredRoadOwnerKeys]),
    publishedRoadOwnerKeys: Object.freeze([...lifecycle.publishedRoadOwnerKeys]),
    firstDrawRoadOwnerKeys: Object.freeze([...lifecycle.firstDrawRoadOwnerKeys]),
    roadOwnerLoadEvents: Object.freeze(lifecycle.roadOwnerLoadEvents.map(event => Object.freeze({
      ...event,
    }))),
    cacheHitCount: lifecycle.cacheHitCount,
    cacheMissCount: lifecycle.cacheMissCount,
    loadedRoadRecordCount: lifecycle.loadedRoadRecordCount,
    registeredRoadRecordCount: lifecycle.registeredRoadRecordCount,
    publishedRoadRecordCount: lifecycle.publishedRoadRecordCount,
    firstDrawRoadRecordCount: lifecycle.firstDrawRoadRecordCount,
    cancellationReason: lifecycle.cancellationReason,
  }) : null;

  const beginRoadLifecycle = ({
    syncEpoch: lifecycleEpoch,
    transitionGeneration = null,
    playerX,
    playerZ,
  }) => {
    if (!roadLifecycleDiagnosticEnabled) return null;
    const lifecycle = {
      syncEpoch: lifecycleEpoch,
      transitionGeneration,
      status: 'requested',
      startedAtMs: monotonicNow(),
      queryPlannedAtMs: null,
      queryReadyAtMs: null,
      registeredAtMs: null,
      publicationQueuedAtMs: null,
      publishedAtMs: null,
      firstDrawAtMs: null,
      cancelledAtMs: null,
      playerX,
      playerZ,
      roadVisibilityMeters: null,
      roadQueryRadius: null,
      plannedRoadOwnerKeys: [],
      completedRoadOwnerKeys: [],
      registeredRoadOwnerKeys: [],
      publishedRoadOwnerKeys: [],
      firstDrawRoadOwnerKeys: [],
      roadOwnerLoadEvents: [],
      cacheHitCount: 0,
      cacheMissCount: 0,
      loadedRoadRecordCount: 0,
      registeredRoadRecordCount: 0,
      publishedRoadRecordCount: 0,
      firstDrawRoadRecordCount: 0,
      cancellationReason: null,
    };
    roadLifecycleByEpoch.set(lifecycleEpoch, lifecycle);
    roadLifecycleHistory.push(lifecycle);
    while (roadLifecycleHistory.length > W8_ROAD_LIFECYCLE_DIAGNOSTIC_HISTORY_LIMIT) {
      const removed = roadLifecycleHistory.shift();
      if (roadLifecycleByEpoch.get(removed.syncEpoch) === removed) {
        roadLifecycleByEpoch.delete(removed.syncEpoch);
      }
      roadLifecycleDroppedHistoryCount += 1;
    }
    return lifecycle;
  };

  const lifecycleFor = lifecycleEpoch => roadLifecycleDiagnosticEnabled
    ? roadLifecycleByEpoch.get(lifecycleEpoch) ?? null : null;

  const cancelRoadLifecycle = (lifecycleEpoch, reason) => {
    const lifecycle = lifecycleFor(lifecycleEpoch);
    if (!lifecycle || ['published', 'first-draw', 'cancelled'].includes(lifecycle.status)) return;
    lifecycle.status = 'cancelled';
    lifecycle.cancelledAtMs = monotonicNow();
    lifecycle.cancellationReason = reason;
  };

  const roadObjectsByOwner = generation => {
    const grouped = new Map();
    for (const object of generation?.canonicalObjects?.values?.() ?? []) {
      if (object.record?.featureType !== 'settlement-road') continue;
      const values = grouped.get(object.ownerKey) ?? [];
      values.push(object);
      grouped.set(object.ownerKey, values);
    }
    return grouped;
  };

  const markRoadLifecycleRegistered = generation => {
    const lifecycle = lifecycleFor(generation?.epoch);
    const grouped = roadObjectsByOwner(generation);
    if (!lifecycle || grouped.size === 0) return;
    lifecycle.registeredRoadOwnerKeys = [...grouped.keys()].sort();
    lifecycle.registeredRoadRecordCount = [...grouped.values()]
      .reduce((total, values) => total + values.length, 0);
    if (lifecycle.registeredAtMs === null) {
      lifecycle.registeredAtMs = monotonicNow();
      lifecycle.status = 'registered';
    }
  };

  const markRoadLifecyclePublicationQueued = generation => {
    const lifecycle = lifecycleFor(generation?.epoch);
    if (!lifecycle || roadObjectsByOwner(generation).size === 0
      || lifecycle.publicationQueuedAtMs !== null
      || lifecycle.publishedAtMs !== null) return;
    lifecycle.publicationQueuedAtMs = monotonicNow();
    lifecycle.status = 'publication-queued';
  };

  const markRoadLifecyclePublished = generation => {
    const grouped = roadObjectsByOwner(generation);
    if (grouped.size === 0) return;
    if (generation && (!publishedRoadGeneration
      || Number(generation.epoch ?? -1) >= Number(publishedRoadGeneration.epoch ?? -1))) {
      publishedRoadGeneration = generation;
    }
    const lifecycle = lifecycleFor(generation?.epoch);
    if (!lifecycle) return;
    lifecycle.publishedRoadOwnerKeys = [...grouped.keys()].sort();
    lifecycle.publishedRoadRecordCount = [...grouped.values()]
      .reduce((total, values) => total + values.length, 0);
    if (lifecycle.publishedAtMs === null) {
      lifecycle.publishedAtMs = monotonicNow();
      lifecycle.status = 'published';
    }
  };

  const markRoadLifecycleFirstDraw = (generation, receipt) => {
    const lifecycle = lifecycleFor(generation?.epoch);
    if (!lifecycle || lifecycle.firstDrawAtMs !== null) return false;
    const roadBuckets = [...(generation?.canonicalBuckets?.values?.() ?? [])]
      .filter(isSettlementRoadBucket);
    const drawn = roadBuckets.some(bucket => bucket.mesh
      && hasDrawableInCompletedFrame({ root: bucket.mesh, receipt }));
    if (!drawn) return false;
    const grouped = roadObjectsByOwner(generation);
    lifecycle.firstDrawRoadOwnerKeys = [...grouped.keys()].sort();
    lifecycle.firstDrawRoadRecordCount = [...grouped.values()]
      .reduce((total, values) => total + values.length, 0);
    lifecycle.firstDrawAtMs = receipt.completedAtMs;
    lifecycle.status = 'first-draw';
    return true;
  };
  let activeLocalTerrainGeneration = null;
  let preparedRenderDistanceLocalTerrain = null;
  const preparedTerrainPresentationGenerations = new Map();
  let terrainPresentationGenerationPrepareCount = 0;
  let terrainPresentationGenerationClaimCount = 0;
  let terrainPresentationGenerationDiscardCount = 0;
  let terrainPresentationGenerationStalePublishCount = 0;
  let terrainPresentationGenerationMaximumStagedCount = 0;
  let terrainPresentationGenerationMaximumGeometryCount = 0;
  let terrainPresentationGenerationMaximumUploadBytes = 0;
  let terrainPresentationGenerationMaximumSliceMs = 0;
  let terrainPresentationGenerationMaximumOldNewOverlapGeometryCount = 0;
  let terrainPresentationGenerationMaximumResidentGeometryCount = 0;
  let terrainPresentationGenerationMaximumResidentUploadBytes = 0;
  const localTerrainOwnerIndexData = new WeakMap();
  let committedRuntimeTransitionContract = null;
  const acceptRuntimeTransitionContract = transitionContract => {
    if (!transitionContract) return true;
    if (!committedRuntimeTransitionContract) {
      committedRuntimeTransitionContract = transitionContract;
      return true;
    }
    if (sameRuntimeTransitionContract(
      transitionContract,
      committedRuntimeTransitionContract,
    )) return true;
    if (transitionContract.generation < committedRuntimeTransitionContract.generation) {
      return false;
    }
    if (transitionContract.generation === committedRuntimeTransitionContract.generation) {
      throw new Error('conflicting Runtime transition contracts share one generation');
    }
    committedRuntimeTransitionContract = transitionContract;
    return true;
  };
  const transitionIsCurrent = transitionContract => !transitionContract
    || sameRuntimeTransitionContract(
      transitionContract,
      committedRuntimeTransitionContract,
    );
  let syncEpoch = 0;
  let committedEpoch = 0;
  let staleEpochDiscardCount = 0;
  let committedRenderOrigin = null;
  let staleRenderOriginRejectCount = 0;
  let localTerrainSyncEpoch = 0;
  let committedLocalTerrainEpoch = 0;

  const recordDistantPublication = generation => {
    if (!streamingTelemetry) return;
    const planId = generation.transitionContract?.generation ?? null;
    const centerOwnerKey = generation.transitionContract?.centerChunkKey ?? null;
    const summaries = new Map();
    if (centerOwnerKey) {
      summaries.set(`${centerOwnerKey}\n${WORLD_STREAMING_TARGET.DISTANT}`, {
        target: WORLD_STREAMING_TARGET.DISTANT,
        ownerKey: centerOwnerKey,
        resourceKey: centerOwnerKey,
        stableId: null,
        count: 1,
      });
    }
    for (const object of generation.canonicalObjects.values()) {
      if (object.visibleLod === 'hidden' || object.visibleLod === 'destroyed'
        || object.presentationTier === null) continue;
      const target = worldStreamingTargetForCanonicalObject(object.record);
      if (target) {
        const key = `${object.ownerKey}\n${target}`;
        const current = summaries.get(key) ?? {
          target,
          ownerKey: object.ownerKey,
          resourceKey: object.ownerKey,
          stableId: object.stableId,
          count: 0,
        };
        current.count += 1;
        summaries.set(key, current);
      }
      if (typeof object.settlementId === 'string' && object.settlementId) {
        const key = `${object.ownerKey}\n${WORLD_STREAMING_TARGET.SETTLEMENT}`;
        const current = summaries.get(key) ?? {
          target: WORLD_STREAMING_TARGET.SETTLEMENT,
          ownerKey: object.ownerKey,
          resourceKey: object.ownerKey,
          stableId: object.settlementId,
          count: 0,
        };
        current.count += 1;
        summaries.set(key, current);
      }
    }
    const pending = [];
    for (const summary of summaries.values()) {
      const details = {
        target: summary.target,
        stream: WORLD_STREAMING_STREAM.DISTANT,
        resourceKey: summary.resourceKey,
        ownerKey: summary.ownerKey,
        stableId: summary.stableId,
        planId,
        metadata: { instanceCount: summary.count, epoch: generation.epoch },
      };
      const published = streamingTelemetry.record(WORLD_STREAMING_EVENT.PUBLISH, details);
      pending.push({ ...details, correlationId: published?.correlationId ?? null });
    }
    pendingDistantFirstDraw = { epoch: generation.epoch, events: pending };
  };
  let localTerrainCommitCount = 0;
  let localTerrainRejectionCount = 0;
  let localTerrainStaleDiscardCount = 0;
  let localTerrainLastRequestedEpoch = 0;
  let localTerrainLastActiveKeyCount = 0;
  let localTerrainLastResolvedChunkCount = 0;
  let localTerrainLastRenderedKeyCount = 0;
  let localTerrainLastMidgroundOwnerCount = 0;
  let localTerrainLastMissingOwnerKeys = Object.freeze([]);
  let localTerrainLastRejectionReason = null;
  let localTerrainLastSyncDurationMs = 0;
  let localTerrainLastRootSwapDurationMs = 0;
  let localTerrainLastMaximumSliceMs = 0;
  let localTerrainLastSliceCount = 0;
  let presentationSchedulerNaturalSlices = 0;
  let presentationSchedulerRoadSlices = 0;
  let farLastMaximumSliceMs = 0;
  let farLastSliceCount = 0;
  let stagingLocalTerrainRootId = null;
  const pendingFarSyncEpochs = new Set();
  let activeQueryCount = 0;
  let maximumObservedQueryConcurrency = 0;
  const queryWaiters = [];
  const templateCache = new Map();
  const farOwnerChunkCache = new Map();
  let nearVisibleSnapshotIdentity = null;
  let nearPublishedSnapshotIdentity = null;
  let nearVisibleSnapshotState = Object.freeze({
    stableIds: new Set(),
    signature: '',
  });
  const readNearVisibleSnapshotState = () => {
    const snapshot = getNearVisibleStableIds() ?? [];
    const publicationSnapshot = getNearPublishedStableIds?.() ?? null;
    if (snapshot === nearVisibleSnapshotIdentity
      && publicationSnapshot === nearPublishedSnapshotIdentity) {
      return nearVisibleSnapshotState;
    }
    const published = publicationSnapshot === null ? null : new Set(publicationSnapshot);
    const stableIds = new Set([...snapshot].filter(stableId => (
      published === null || published.has(stableId)
    )));
    nearVisibleSnapshotIdentity = snapshot;
    nearPublishedSnapshotIdentity = publicationSnapshot;
    nearVisibleSnapshotState = Object.freeze({
      stableIds,
      signature: [...stableIds].sort((left, right) => left.localeCompare(right)).join('\n'),
    });
    return nearVisibleSnapshotState;
  };
  const clipmapSampleCache = new Map();
  const midgroundOwnerSampleCache = new Map();
  const macroSurfaceWindowCache = new Map();
  let macroSurfaceWindowQueryCount = 0;
  let macroSurfaceWindowReuseCount = 0;
  let macroSurfacePolicyBuildCount = 0;
  let macroSurfaceWindowMaximumQueryMs = 0;
  let midgroundOwnerSampleCacheHits = 0;
  let midgroundOwnerSampleCacheMisses = 0;
  let midgroundOwnerSampleCacheEvictions = 0;
  let midgroundTotalNewSampleCount = 0;
  let midgroundTotalReusedSampleCount = 0;
  let midgroundTotalDiscardedSampleCount = 0;
  const riverCorridorWindowCache = new Map();
  let currentCanonicalSurfacePolicy = null;
  const surfacePolicyForChunks = (chunks, additionalRiverCorridors = []) => {
    const regions = new Map();
    const riverCorridors = new Map();
    for (const chunk of chunks) {
      for (const region of chunk?.canonicalSurfacePolicy?.regions ?? []) {
        regions.set(region.settlementId, region);
      }
      for (const corridor of chunk?.canonicalSurfacePolicy?.riverCorridors ?? []) {
        riverCorridors.set(JSON.stringify(corridor), corridor);
      }
    }
    for (const corridor of additionalRiverCorridors) {
      if (corridor) riverCorridors.set(JSON.stringify(corridor), corridor);
    }
    return Object.freeze({
      schemaVersion: 'w8-settlement-surface-policy-1',
      regions: Object.freeze([...regions.values()]
        .sort((left, right) => left.settlementId.localeCompare(right.settlementId))),
      riverCorridors: Object.freeze([...riverCorridors.values()]
        .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))),
    });
  };
  const riverSurfaceCorridorsForClipmap = (
    centerChunkX,
    centerChunkZ,
    policy,
    terrainRiverExtentMeters,
  ) => {
    const cacheKey = `${centerChunkX},${centerChunkZ}:${terrainRiverExtentMeters}`;
    if (riverCorridorWindowCache.has(cacheKey)) {
      const cached = riverCorridorWindowCache.get(cacheKey);
      riverCorridorWindowCache.delete(cacheKey);
      riverCorridorWindowCache.set(cacheKey, cached);
      return cached;
    }
    const centerWorldX = (centerChunkX + 0.5) * LOGICAL_CHUNK_SIZE_METERS;
    const centerWorldZ = (centerChunkZ + 0.5) * LOGICAL_CHUNK_SIZE_METERS;
    const settlementReferences = (policy?.regions ?? []).map(region => ({
      settlementId: region.settlementId,
      center: region.center,
      radiusMeters: region.flatCoreRadiusMeters + region.transitionWidthMeters,
    }));
    const minimumChunkX = Math.floor(
      (centerWorldX - terrainRiverExtentMeters) / LOGICAL_CHUNK_SIZE_METERS,
    );
    const maximumChunkX = Math.floor(
      (centerWorldX + terrainRiverExtentMeters) / LOGICAL_CHUNK_SIZE_METERS,
    );
    const minimumChunkZ = Math.floor(
      (centerWorldZ - terrainRiverExtentMeters) / LOGICAL_CHUNK_SIZE_METERS,
    );
    const maximumChunkZ = Math.floor(
      (centerWorldZ + terrainRiverExtentMeters) / LOGICAL_CHUNK_SIZE_METERS,
    );
    const corridors = [];
    for (let chunkZ = minimumChunkZ; chunkZ <= maximumChunkZ; chunkZ += 1) {
      for (let chunkX = minimumChunkX; chunkX <= maximumChunkX; chunkX += 1) {
        if (!canonicalRiverMayAffectChunk({
          chunkX,
          chunkZ,
          settlementReferences,
        })) continue;
        const corridor = createCanonicalRiverSurfaceCorridor({
          sourceStableId: canonicalRiverSourceStableId,
          chunkX,
          chunkZ,
          settlementReferences,
        });
        if (corridor) corridors.push(corridor);
      }
    }
    const result = Object.freeze(corridors);
    riverCorridorWindowCache.set(cacheKey, result);
    if (riverCorridorWindowCache.size > RIVER_CORRIDOR_WINDOW_CACHE_CAPACITY) {
      riverCorridorWindowCache.delete(riverCorridorWindowCache.keys().next().value);
    }
    return result;
  };
  const riverSurfaceCorridorsForClipmapIncrementally = async (
    centerChunkX,
    centerChunkZ,
    policy,
    terrainRiverExtentMeters,
    scheduler,
  ) => {
    const cacheKey = `${centerChunkX},${centerChunkZ}:${terrainRiverExtentMeters}`;
    if (riverCorridorWindowCache.has(cacheKey)) {
      const cached = riverCorridorWindowCache.get(cacheKey);
      riverCorridorWindowCache.delete(cacheKey);
      riverCorridorWindowCache.set(cacheKey, cached);
      return cached;
    }
    const centerWorldX = (centerChunkX + 0.5) * LOGICAL_CHUNK_SIZE_METERS;
    const centerWorldZ = (centerChunkZ + 0.5) * LOGICAL_CHUNK_SIZE_METERS;
    const settlementReferences = (policy?.regions ?? []).map(region => ({
      settlementId: region.settlementId,
      center: region.center,
      radiusMeters: region.flatCoreRadiusMeters + region.transitionWidthMeters,
    }));
    const minimumChunkX = Math.floor(
      (centerWorldX - terrainRiverExtentMeters) / LOGICAL_CHUNK_SIZE_METERS,
    );
    const maximumChunkX = Math.floor(
      (centerWorldX + terrainRiverExtentMeters) / LOGICAL_CHUNK_SIZE_METERS,
    );
    const minimumChunkZ = Math.floor(
      (centerWorldZ - terrainRiverExtentMeters) / LOGICAL_CHUNK_SIZE_METERS,
    );
    const maximumChunkZ = Math.floor(
      (centerWorldZ + terrainRiverExtentMeters) / LOGICAL_CHUNK_SIZE_METERS,
    );
    const corridors = [];
    for (let chunkZ = minimumChunkZ; chunkZ <= maximumChunkZ; chunkZ += 1) {
      for (let chunkX = minimumChunkX; chunkX <= maximumChunkX; chunkX += 1) {
        if (canonicalRiverMayAffectChunk({ chunkX, chunkZ, settlementReferences })) {
          const corridor = createCanonicalRiverSurfaceCorridor({
            sourceStableId: canonicalRiverSourceStableId,
            chunkX,
            chunkZ,
            settlementReferences,
          });
          if (corridor) corridors.push(corridor);
        }
        const pendingYield = scheduler.checkpoint();
        if (pendingYield) await pendingYield;
      }
    }
    const result = Object.freeze(corridors);
    riverCorridorWindowCache.set(cacheKey, result);
    if (riverCorridorWindowCache.size > RIVER_CORRIDOR_WINDOW_CACHE_CAPACITY) {
      riverCorridorWindowCache.delete(riverCorridorWindowCache.keys().next().value);
    }
    return result;
  };
  const rememberRiverCorridorWindow = ({
    centerChunkX,
    centerChunkZ,
    terrainRiverExtentMeters,
    corridors,
  }) => {
    const cacheKey = `${centerChunkX},${centerChunkZ}:${terrainRiverExtentMeters}`;
    riverCorridorWindowCache.delete(cacheKey);
    riverCorridorWindowCache.set(cacheKey, Object.freeze([...corridors]));
    if (riverCorridorWindowCache.size > RIVER_CORRIDOR_WINDOW_CACHE_CAPACITY) {
      riverCorridorWindowCache.delete(riverCorridorWindowCache.keys().next().value);
    }
  };
  let clipmapSampleCacheHits = 0;
  let clipmapSampleCacheMisses = 0;
  let clipmapSampleCacheEvictions = 0;
  let clipmapSurfaceSampleReuseCount = 0;
  let clipmapSurfaceSampleRefreshCount = 0;
  let clipmapBuildCount = 0;
  let clipmapFullBuildCount = 0;
  let clipmapIncrementalBuildCount = 0;
  let clipmapTotalSampleCount = 0;
  let clipmapTotalNewlySampledCount = 0;
  let clipmapTotalReusedSampleCount = 0;
  let clipmapTotalVertexWriteCount = 0;
  let clipmapTotalBufferUploadBytes = 0;
  let clipmapGeometryAllocationCount = 0;
  let clipmapIndexAllocationCount = 0;
  let clipmapGeometryDisposeCount = 0;
  let clipmapLastBuildDurationMs = 0;
  let clipmapMaximumBuildDurationMs = 0;
  const clipmapGeometryPoolByPreset = new Map();
  const clipmapShiftSlotMapCache = new Map();
  const midgroundGeometryPool = [];
  let midgroundGeometryAllocationCount = 0;
  let midgroundGeometryReuseCount = 0;
  let midgroundGeometryDisposeCount = 0;
  let visibleTerrainHoleFrame = 0;
  let continuousTerrainCoverageComplete = false;
  let continuousTerrainCoverageMiss = 0;
  const acquireMidgroundGeometryResource = ({
    positions,
    colors,
    indices,
    generation,
  }) => {
    let resource = midgroundGeometryPool.find(value => value.generation === null
      && value.positionCount === positions.length
      && value.colorCount === colors.length);
    let allocated = false;
    if (!resource) {
      const geometry = makeFlatClipmapGeometry(THREE, positions, colors, indices);
      geometry.userData = {
        ...(geometry.userData ?? {}),
        worldFixedMidgroundTerrain: true,
      };
      resource = {
        geometry,
        generation: null,
        positionCount: positions.length,
        colorCount: colors.length,
      };
      midgroundGeometryPool.push(resource);
      midgroundGeometryAllocationCount += 1;
      allocated = true;
    } else {
      const positionAttribute = resource.geometry.attributes?.position;
      const colorAttribute = resource.geometry.attributes?.color;
      const positionValues = positionAttribute?.array ?? positionAttribute?.values;
      const colorValues = colorAttribute?.array ?? colorAttribute?.values;
      positionValues.set?.(positions);
      colorValues.set?.(colors);
      if (!positionValues.set) {
        for (let index = 0; index < positions.length; index += 1) positionValues[index] = positions[index];
      }
      if (!colorValues.set) {
        for (let index = 0; index < colors.length; index += 1) colorValues[index] = colors[index];
      }
      if (positionAttribute) positionAttribute.needsUpdate = true;
      if (colorAttribute) colorAttribute.needsUpdate = true;
      const currentIndex = resource.geometry.index?.array ?? resource.geometry.index;
      if (currentIndex?.length === indices.length) {
        currentIndex.set?.(indices);
        if (!currentIndex.set) {
          for (let index = 0; index < indices.length; index += 1) currentIndex[index] = indices[index];
        }
        if (resource.geometry.index && typeof resource.geometry.index === 'object') {
          resource.geometry.index.needsUpdate = true;
        }
      } else resource.geometry.setIndex(indices);
      midgroundGeometryReuseCount += 1;
    }
    resource.generation = generation;
    generation.midgroundGeometryResource = resource;
    return Object.freeze({ resource, allocated });
  };
  const releaseMidgroundGeometryResource = generation => {
    const resource = generation?.midgroundGeometryResource;
    if (!resource || resource.generation !== generation) return false;
    resource.generation = null;
    generation.midgroundGeometryResource = null;
    generation.ownedGeometries?.delete(resource.geometry);
    return true;
  };
  const releaseClipmapGeometryResource = generation => {
    const resource = generation?.clipmapGeometryResource;
    if (!resource || resource.generation !== generation) return false;
    resource.generation = null;
    generation.clipmapGeometryResource = null;
    generation.ownedGeometries?.delete(resource.geometry);
    return true;
  };
  let farOwnerChunkCacheHits = 0;
  let farOwnerChunkCacheMisses = 0;
  let farOwnerChunkCacheEvictions = 0;
  let treeLodDiagnosticsEnabled = false;
  let disposed = false;
  const SYNC_CANCELLED = Symbol('w8-distant-sync-cancelled');
  const LOCAL_SYNC_CANCELLED = Symbol('w8-local-terrain-sync-cancelled');

  const monotonicNow = () => globalThis.performance?.now?.() ?? Date.now();
  const yieldPresentationWorkToMainThread = yieldToMainThread
    ?? (() => new Promise(resolve => globalThis.setTimeout(resolve, 0)));
  const terrainScheduler = terrainContinuationScheduler
    ?? createDeadlineAwareTerrainPresentationScheduler({ clock: monotonicNow });
  const materialColorHex = material => {
    const color = material?.color;
    if (typeof color?.getHex === 'function') return color.getHex();
    if (Number.isFinite(color?.value)) return color.value;
    if (Number.isFinite(color)) return color;
    return null;
  };
  const snapshotMaterial = (path, material) => Object.freeze({
    path,
    materialName: material?.name ?? null,
    materialType: material?.type ?? material?.constructor?.name ?? null,
    lightingModel: material?.isMeshPhongMaterial === true
      || material?.type === 'MeshPhongMaterial'
      || material?.constructor?.name === 'MeshPhongMaterial'
      ? 'phong' : material?.isMeshLambertMaterial === true
        || material?.type === 'MeshLambertMaterial'
        || material?.constructor?.name === 'MeshLambertMaterial'
        ? 'lambert' : 'unknown',
    baseColorHex: materialColorHex(material),
    vertexColors: material?.vertexColors === true,
    flatShading: material?.flatShading === true,
    shininess: Number.isFinite(material?.shininess) ? material.shininess : null,
    fog: material?.fog !== false,
    opacity: Number.isFinite(material?.opacity) ? material.opacity : null,
    transparent: material?.transparent === true,
    alphaTest: Number.isFinite(material?.alphaTest) ? material.alphaTest : null,
    alphaHash: material?.alphaHash === true,
    toneMapped: material?.toneMapped !== false,
    depthWrite: material?.depthWrite !== false,
    mapColorSpace: material?.map?.colorSpace ?? null,
    naturalLodMode: material?.userData?.naturalLodMode ?? null,
    naturalLodKind: material?.userData?.naturalLodKind ?? null,
    sourceTinted: material?.userData?.naturalLodSourceTinted ?? null,
    customProgramCacheKey: typeof material?.customProgramCacheKey === 'function'
      ? material.customProgramCacheKey() : null,
    customAtmosphericFogBlend: ['atmospheric', 'far'].includes(
      material?.userData?.naturalLodMode,
    ),
  });
  const createSliceScheduler = ({
    assertCurrent,
    budgetMs = PRESENTATION_SLICE_BUDGET_MS,
    unitLimit = PRESENTATION_SLICE_UNIT_LIMIT,
    workKind = 'background',
    isUrgent = false,
    trackGeneration = workKind === 'terrain',
  } = {}) => {
    const generationStartedAt = monotonicNow();
    const terrainGenerationToken = workKind === 'terrain' && trackGeneration
      ? terrainScheduler.beginGeneration?.({ isUrgent, stage: 'surface' }) ?? null : null;
    let sliceStartedAt = generationStartedAt;
    let units = 0;
    let maximumSliceMs = 0;
    let sliceCount = 0;
    let cpuMs = 0;
    let yieldWaitMs = 0;
    let finalized = false;
    const recordSlice = () => {
      const durationMs = Math.max(0, monotonicNow() - sliceStartedAt);
      maximumSliceMs = Math.max(maximumSliceMs, durationMs);
      cpuMs += durationMs;
      if (workKind === 'terrain') {
        terrainScheduler.recordSlice?.(durationMs);
        if (terrainGenerationToken !== null) {
          terrainScheduler.recordGenerationSlice?.(terrainGenerationToken, durationMs);
        }
      }
      else if (workKind === 'natural') presentationSchedulerNaturalSlices += 1;
      return durationMs;
    };
    const finalize = () => {
      const wallMs = Math.max(0, monotonicNow() - generationStartedAt);
      if (!finalized) {
        finalized = true;
        if (workKind === 'terrain' && terrainGenerationToken !== null) {
          terrainScheduler.completeGeneration?.(terrainGenerationToken, {
            cpuMs,
            yieldWaitMs,
            wallMs,
          });
        }
      }
      return Object.freeze({ maximumSliceMs, sliceCount, cpuMs, yieldWaitMs, wallMs });
    };
    return Object.freeze({
      checkpoint({ force = false, units: completedUnits = 1 } = {}) {
        assertCurrent?.();
        units += completedUnits;
        const elapsed = monotonicNow() - sliceStartedAt;
        if (!force && elapsed < budgetMs && units < unitLimit) return null;
        recordSlice();
        sliceCount += 1;
        const waitStartedAt = monotonicNow();
        const continuation = workKind === 'terrain'
          ? terrainScheduler.waitForContinuation({ isUrgent })
          : yieldPresentationWorkToMainThread();
        return Promise.resolve(continuation).then(resume => {
          const wallWaitMs = Math.max(0, monotonicNow() - waitStartedAt);
          const schedulerWaitMs = Number.isFinite(resume?.waitMs)
            ? Math.max(0, resume.waitMs)
            : wallWaitMs;
          yieldWaitMs += wallWaitMs;
          if (terrainGenerationToken !== null) {
            terrainScheduler.recordGenerationYield?.(terrainGenerationToken, schedulerWaitMs);
          }
          assertCurrent?.();
          sliceStartedAt = monotonicNow();
          units = 0;
        });
      },
      async waitFor(promise) {
        assertCurrent?.();
        recordSlice();
        sliceCount += 1;
        const waitStartedAt = monotonicNow();
        try {
          return await promise;
        } finally {
          yieldWaitMs += Math.max(0, monotonicNow() - waitStartedAt);
          sliceStartedAt = monotonicNow();
          units = 0;
          assertCurrent?.();
        }
      },
      finish() {
        assertCurrent?.();
        recordSlice();
        return finalize();
      },
      snapshot() {
        recordSlice();
        return finalize();
      },
      setStage(stage) {
        if (terrainGenerationToken === null) return false;
        return terrainScheduler.setGenerationStage?.(terrainGenerationToken, stage) === true;
      },
    });
  };

  const acceptCommittedRenderOrigin = renderOrigin => {
    if (!Number.isSafeInteger(renderOrigin?.renderOriginChunkX)
      || !Number.isSafeInteger(renderOrigin?.renderOriginChunkZ)) {
      throw new TypeError('Distant presentation requires a committed render origin');
    }
    const incomingEpoch = Number.isSafeInteger(renderOrigin.rebaseCount)
      ? renderOrigin.rebaseCount : null;
    const currentEpoch = Number.isSafeInteger(committedRenderOrigin?.rebaseCount)
      ? committedRenderOrigin.rebaseCount : null;
    if (incomingEpoch !== null && currentEpoch !== null && incomingEpoch < currentEpoch) {
      staleRenderOriginRejectCount += 1;
      return false;
    }
    if (incomingEpoch !== null && currentEpoch !== null && incomingEpoch === currentEpoch
      && (renderOrigin.renderOriginChunkX !== committedRenderOrigin.renderOriginChunkX
        || renderOrigin.renderOriginChunkZ !== committedRenderOrigin.renderOriginChunkZ)) {
      throw new Error(`Distant render origin identity mismatch at epoch ${incomingEpoch}`);
    }
    const changed = !committedRenderOrigin
      || renderOrigin.renderOriginChunkX !== committedRenderOrigin.renderOriginChunkX
      || renderOrigin.renderOriginChunkZ !== committedRenderOrigin.renderOriginChunkZ
      || (incomingEpoch !== null && incomingEpoch !== currentEpoch);
    if (!changed) return true;
    committedRenderOrigin = Object.freeze({
      renderOriginChunkX: renderOrigin.renderOriginChunkX,
      renderOriginChunkZ: renderOrigin.renderOriginChunkZ,
      rebaseCount: incomingEpoch,
    });
    if (pendingFarSyncEpochs.size > 0 && incomingEpoch !== null
      && (currentEpoch === null || incomingEpoch > currentEpoch)) {
      syncEpoch += 1;
      cancelCanonicalChunkRequests?.({
        consumerId: 'distant-owner-query',
        beforeEpoch: syncEpoch + 1,
      });
    }
    return true;
  };

  const disposeGeneration = generation => {
    if (!generation) return;
    for (const pathId of treePathIdsForGeneration(generation)) {
      recordTreePathAudit(pathId, { disposeCount: 1 });
    }
    root.remove(generation.root);
    scene.remove?.(generation.root);
    for (const child of generation.root.children ?? []) child.dispose?.();
    generation.root.clear?.();
    releaseMidgroundGeometryResource(generation);
    releaseClipmapGeometryResource(generation);
    for (const geometry of generation.ownedGeometries) {
      if (geometry.userData?.worldFixedClipmap === true) clipmapGeometryDisposeCount += 1;
      geometry.dispose?.();
    }
    generation.ownedGeometries.clear();
    for (const material of generation.ownedMaterials ?? []) material.dispose?.();
    generation.ownedMaterials?.clear?.();
  };
  const deferredGenerationDisposals = [];
  const deferGenerationDispose = generation => {
    if (!generation) return;
    root.remove(generation.root);
    scene.remove?.(generation.root);
    releaseMidgroundGeometryResource(generation);
    releaseClipmapGeometryResource(generation);
    deferredGenerationDisposals.push({
      generation,
      rootToClear: generation.root,
      children: [...(generation.root.children ?? [])],
      geometries: [...(generation.ownedGeometries ?? [])],
      materials: [...(generation.ownedMaterials ?? [])],
      stage: 'children',
    });
  };
  const retireGeneration = generation => {
    if (incrementalStaticTreePages) deferGenerationDispose(generation);
    else disposeGeneration(generation);
  };
  let terrainStripRingPublicationCount = 0;
  let terrainInitialRootPublicationCount = 0;
  const publishLocalTerrainGeneration = (generation, previous) => {
    if (!previous?.root || previous.root.parent !== root) {
      root.add(generation.root);
      generation.activatedAtMs = monotonicNow();
      if (generation.clipmapGeometryResource) generation.clipmapGeometryResource.published = true;
      terrainInitialRootPublicationCount += 1;
      return Object.freeze({
        publicationScope: 'initial-complete-terrain-root',
        reusedRoot: false,
      });
    }
    const liveRoot = previous.root;
    const stagedRoot = generation.root;
    const meshByName = (target, name) => target.children?.find(child => child.name === name);
    const liveMedium = meshByName(liveRoot, 'w8-midground-outer-sixteen-terrain');
    const liveLow = meshByName(liveRoot, 'w8-seeded-macro-terrain-clipmap');
    const stagedMedium = meshByName(stagedRoot, 'w8-midground-outer-sixteen-terrain');
    const stagedLow = meshByName(stagedRoot, 'w8-seeded-macro-terrain-clipmap');
    if (![liveMedium, liveLow, stagedMedium, stagedLow].every(Boolean)) {
      root.add(stagedRoot);
      generation.activatedAtMs = monotonicNow();
      if (generation.clipmapGeometryResource) generation.clipmapGeometryResource.published = true;
      retireGeneration(previous);
      terrainInitialRootPublicationCount += 1;
      return Object.freeze({
        publicationScope: 'complete-terrain-root-fallback',
        reusedRoot: false,
      });
    }
    const replaceMeshPresentation = (live, staged) => {
      live.geometry = staged.geometry;
      live.material = staged.material;
      live.name = staged.name;
      live.castShadow = staged.castShadow;
      live.receiveShadow = staged.receiveShadow;
      live.visible = staged.visible;
      live.renderOrder = staged.renderOrder;
      live.userData = { ...(staged.userData ?? {}) };
      live.position.set(staged.position.x, staged.position.y, staged.position.z);
      live.rotation.set(staged.rotation.x, staged.rotation.y, staged.rotation.z);
      live.scale.set(staged.scale.x, staged.scale.y, staged.scale.z);
      stagedRoot.remove(staged);
    };
    const previousMediumGeometry = liveMedium.geometry;
    replaceMeshPresentation(liveMedium, stagedMedium);
    replaceMeshPresentation(liveLow, stagedLow);
    const previousMidgroundResource = previous.midgroundGeometryResource;
    if (previousMidgroundResource
      && previousMediumGeometry === liveMedium.geometry) {
      previousMidgroundResource.generation = generation;
      generation.midgroundGeometryResource = previousMidgroundResource;
      previous.midgroundGeometryResource = null;
      previous.ownedGeometries?.delete(previousMediumGeometry);
      generation.ownedGeometries.add(previousMediumGeometry);
    } else releaseMidgroundGeometryResource(previous);
    releaseClipmapGeometryResource(previous);
    for (const geometry of previous.ownedGeometries ?? []) {
      if (generation.ownedGeometries.has(geometry)
        || (previousMediumGeometry === liveMedium.geometry
          && geometry === previousMediumGeometry)) continue;
      geometry.dispose?.();
    }
    previous.ownedGeometries?.clear?.();
    for (const material of previous.ownedMaterials ?? []) material.dispose?.();
    previous.ownedMaterials?.clear?.();
    if (previousMediumGeometry === liveMedium.geometry) {
      generation.ownedGeometries.add(previousMediumGeometry);
    }
    const retiredRoot = stagedRoot;
    retiredRoot.name = `w8-retired-local-terrain-epoch-${previous.epoch ?? 'unknown'}`;
    retiredRoot.clear?.();
    liveRoot.name = `w8-logical-continuous-terrain-epoch-${generation.epoch}`;
    liveRoot.userData = {
      ...(stagedRoot.userData ?? {}),
      logicalTerrainSurface: true,
      publicationScope: 'entering-owner-strip-and-low-ring',
    };
    liveRoot.position.set(stagedRoot.position.x, stagedRoot.position.y, stagedRoot.position.z);
    previous.root = retiredRoot;
    generation.root = liveRoot;
    generation.localTerrainMesh = liveMedium;
    generation.activatedAtMs = monotonicNow();
    if (generation.clipmapGeometryResource) generation.clipmapGeometryResource.published = true;
    terrainStripRingPublicationCount += 1;
    return Object.freeze({
      publicationScope: 'entering-owner-strip-and-low-ring',
      reusedRoot: true,
    });
  };

  const matrixValues = matrix => matrix?.elements ?? null;
  const matricesEqual = (left, right) => {
    const leftValues = matrixValues(left);
    const rightValues = matrixValues(right);
    if (leftValues && rightValues) {
      if (leftValues.length !== rightValues.length) return false;
      for (let index = 0; index < leftValues.length; index += 1) {
        if (leftValues[index] !== rightValues[index]) return false;
      }
      return true;
    }
    return JSON.stringify(left) === JSON.stringify(right);
  };
  const attributeBytes = attribute => {
    const values = attribute?.array ?? attribute?.values ?? null;
    if (!values) return 0;
    return Number.isFinite(values.byteLength) ? values.byteLength : values.length * 4;
  };
  const estimateMeshUploadBytes = mesh => {
    if (!mesh) return 0;
    if (!mesh.instanceMatrix) {
      const attributeBytesTotal = Object.values(mesh.geometry?.attributes ?? {})
        .reduce((total, attribute) => total + attributeBytes(attribute), 0);
      const indexBytes = attributeBytes(mesh.geometry?.index);
      const directIndexBytes = ArrayBuffer.isView(mesh.geometry?.index)
        ? mesh.geometry.index.byteLength : 0;
      return attributeBytesTotal + Math.max(indexBytes, directIndexBytes);
    }
    let bytes = attributeBytes(mesh.instanceMatrix) + attributeBytes(mesh.instanceColor);
    if (bytes === 0 && Number.isFinite(mesh.count)) bytes += mesh.count * 16 * 4;
    for (const attribute of Object.values(mesh.geometry?.attributes ?? {})) {
      if (attribute === mesh.instanceMatrix || attribute === mesh.instanceColor) continue;
      if (attribute?.isInstancedBufferAttribute || attribute?.itemSize && (
        attribute?.count === mesh.capacity || attribute?.count === mesh.count
      )) bytes += attributeBytes(attribute);
    }
    return bytes;
  };
  const directCanonicalMeshEntries = generation => new Map(
    [...(generation?.canonicalBuckets?.entries?.() ?? [])]
      .filter(([, bucket]) => bucket.mesh || bucket.persistentReuseEntryKey)
      .map(([key, bucket]) => [`bucket:${key}`, { key, bucket, mesh: bucket.mesh, generation }]),
  );
  const assertPreparedDistantGenerationMaterialized = generation => {
    for (const [key, bucket] of generation?.canonicalBuckets?.entries?.() ?? []) {
      if (!bucket?.items?.length || bucket.mesh) continue;
      throw new Error(`prepared Distant bucket is not materialized: ${key}`);
    }
  };
  const directAuxiliaryMeshEntries = generation => {
    const canonicalMeshes = new Set(
      [...(generation?.canonicalBuckets?.values?.() ?? [])].map(bucket => bucket.mesh),
    );
    const counts = new Map();
    const entries = new Map();
    for (const child of generation?.stagingRoot?.children ?? generation?.root?.children ?? []) {
      if (canonicalMeshes.has(child)) continue;
      const name = child.name || child.type || 'auxiliary';
      const ordinal = counts.get(name) ?? 0;
      counts.set(name, ordinal + 1);
      const key = `aux:${name}:${ordinal}`;
      entries.set(key, { key, bucket: null, mesh: child, generation });
    }
    return entries;
  };
  const itemVisibilitySignature = (generation, item) => {
    const opacity = canonicalInstanceOpacity(item.object, item);
    const visible = ['mid', 'far'].includes(item.object.visibleLod)
      && !(item.object.remoteHorizon
        && (generation.nearVisibleStableIds ?? new Set()).has(item.object.stableId))
      && opacity > 0;
    return `${visible ? 1 : 0}:${opacity}`;
  };
  const remoteSourceColorsEqual = (left, right) => (
    left === right || (left != null && right != null
      && left.r === right.r && left.g === right.g && left.b === right.b)
  );
  const assignPersistentItemKeys = bucket => {
    const ordinals = new Map();
    for (const item of bucket.items) {
      if (!item) continue;
      const stableId = item.object.stableId;
      const ordinal = ordinals.get(stableId) ?? 0;
      ordinals.set(stableId, ordinal + 1);
      item.persistentKey = `${stableId}\n${ordinal}`;
    }
  };
  const initializePersistentBucketSlots = bucket => {
    if (bucket.persistentSlotByKey) return;
    assignPersistentItemKeys(bucket);
    bucket.persistentSlotByKey = new Map();
    for (let slot = 0; slot < bucket.items.length; slot += 1) {
      const item = bucket.items[slot];
      if (!item) continue;
      item.slot = slot;
      bucket.persistentSlotByKey.set(item.persistentKey, slot);
    }
  };
  const createPersistentBucketWork = (generation, desired, live) => {
    initializePersistentBucketSlots(live);
    assignPersistentItemKeys(desired);
    const desiredByKey = new Map(desired.items.map(item => [item.persistentKey, item]));
    const removedSlots = [];
    for (const [key, slot] of live.persistentSlotByKey) {
      if (!desiredByKey.has(key)) removedSlots.push(slot);
    }
    removedSlots.sort((left, right) => right - left);
    const nextItems = [...live.items];
    const nextSlotByKey = new Map();
    const operations = [];
    let nextUnusedSlot = nextItems.length;
    let reusedSlotCount = 0;
    for (const item of desired.items) {
      const currentSlot = live.persistentSlotByKey.get(item.persistentKey);
      const slot = currentSlot ?? removedSlots.pop() ?? nextUnusedSlot++;
      if (slot >= (live.capacity ?? live.mesh.capacity)) {
        throw new RangeError(`persistent Distant bucket capacity exceeded: ${desired.key}`);
      }
      const previousItem = currentSlot === undefined ? null : live.items[currentSlot];
      item.slot = slot;
      nextItems[slot] = item;
      nextSlotByKey.set(item.persistentKey, slot);
      const changed = !previousItem
        || !matricesEqual(previousItem.matrix, item.matrix)
        || !remoteSourceColorsEqual(previousItem.remoteSourceColor, item.remoteSourceColor)
        || itemVisibilitySignature(activeGeneration ?? generation, previousItem)
          !== itemVisibilitySignature(generation, item);
      if (changed) operations.push({ slot, previousItem, desiredItem: item });
      else reusedSlotCount += 1;
    }
    for (const [key, slot] of live.persistentSlotByKey) {
      if (nextSlotByKey.has(key)) continue;
      if (nextItems[slot]?.persistentKey === key) nextItems[slot] = null;
      if (!operations.some(operation => operation.slot === slot)) {
        operations.push({ slot, previousItem: live.items[slot], desiredItem: null });
      }
    }
    while (nextItems.length && !nextItems.at(-1)) nextItems.pop();
    operations.sort((left, right) => {
      const leftRequired = generation.activeKeys.has(left.desiredItem?.object?.ownerKey) ? 0 : 1;
      const rightRequired = generation.activeKeys.has(right.desiredItem?.object?.ownerKey) ? 0 : 1;
      return leftRequired - rightRequired || left.slot - right.slot;
    });
    return {
      type: 'bucket',
      key: `bucket:${desired.key}`,
      generation,
      desired,
      live,
      operations,
      cursor: 0,
      preparedSlots: [],
      nextItems,
      nextSlotByKey,
      reusedSlotCount,
      required: desired.items.some(item => generation.activeKeys.has(item.object.ownerKey)),
    };
  };
  const cleanupRetiredDistantGenerations = () => {
    const liveGenerations = new Set([...liveDistantEntries.values()].map(entry => entry.generation));
    for (const generation of [...retiredDistantGenerations]) {
      if (liveGenerations.has(generation) || generation === activeGeneration) continue;
      const detachedRoot = generation.stagingRoot;
      deferredGenerationDisposals.push({
        generation,
        rootToClear: detachedRoot ?? null,
        children: [...(detachedRoot?.children ?? [])],
        geometries: [...(generation.ownedGeometries ?? [])],
        materials: [...(generation.ownedMaterials ?? [])],
        stage: 'children',
      });
      retiredDistantGenerations.delete(generation);
    }
  };
  const rollbackUnpublishedPersistentBucketWrites = publication => {
    const work = publication?.queue?.[0];
    if (work?.type !== 'bucket' || work.cursor <= 0) return;
    const hidden = hiddenCanonicalMatrix();
    for (let index = 0; index < work.cursor; index += 1) {
      const operation = work.operations[index];
      const item = operation.previousItem;
      const opacity = item ? canonicalInstanceOpacity(item.object, item) : 0;
      const visible = item && ['mid', 'far'].includes(item.object.visibleLod)
        && !(item.object.remoteHorizon
          && (publication.previous.nearVisibleStableIds ?? new Set()).has(item.object.stableId))
        && opacity > 0;
      work.live.mesh.setMatrixAt(operation.slot, visible ? item.matrix : hidden);
      if (item) {
        writeRemoteBuildingAnchor(work.live, operation.slot, item.object, publication.previous);
        writeRemoteSourceColor(work.live, operation.slot, item);
        writeNaturalAnchor(work.live, operation.slot, item.object, publication.previous);
        writeNaturalInitialReveal(
          work.live, operation.slot, item.object, publication.previous, item,
        );
        writeLocalHandoffOpacity(work.live, operation.slot, visible ? opacity : 0);
      }
    }
  };
  const completePersistentDistantPublication = publication => {
    if (pendingDistantPublication !== publication) return false;
    const generation = publication.generation;
    pendingDistantPublication = null;
    generation.root = persistentDistantRoot;
    generation.stagingRoot = publication.stagingRoot;
    recordDiagnosticEvent('distant-publication-complete', {
      syncEpoch: generation.epoch,
      transitionGeneration: generation.transitionContract?.generation ?? null,
      coverageSignature: generation.transitionContract?.coverageSignature ?? null,
      renderDistancePreset: generation.renderDistancePreset,
      rootId: generation.root?.name ?? null,
      rootAttached: generation.root?.parent === root,
      buildingPublicationSource,
      settlementRoadPublicationSource,
      settlementPublicationPlanId,
      settlementPublicationRevision,
    });
    persistentDistantPublishedGeneration = generation;
    markRoadLifecyclePublished(generation);
    positionGenerationForOrigin(generation, committedRenderOrigin);
    if (generation.naturalReveal < 1) generation.naturalRevealStartedAt = monotonicNow();
    recordDistantPublication(generation);
    distantPersistentPublicationCount += 1;
    cleanupRetiredDistantGenerations();
    if (generation.independentRoadPresentation === true) {
      requestIndependentRoadPublication();
    }
    return true;
  };
  const processPersistentDistantPublication = budgetMs => {
    const publication = pendingDistantPublication;
    if (!publication || !(budgetMs > 0)) return Object.freeze({ admissions: 0, bytes: 0 });
    const startedAt = monotonicNow();
    let admissions = 0;
    let uploadBytes = 0;
    let matrixUpdates = 0;
    let bufferUpdates = 0;
    const work = publication.queue[0] ?? null;
    if (work?.type === 'bucket') {
      const hidden = hiddenCanonicalMatrix();
      while (work.cursor < work.operations.length
        && work.preparedSlots.length < STATIC_TREE_PAGE_UNIT_LIMIT
        && monotonicNow() - startedAt < budgetMs) {
        const operation = work.operations[work.cursor];
        const item = operation.desiredItem;
        const opacity = item ? canonicalInstanceOpacity(item.object, item) : 0;
        const visible = item && ['mid', 'far'].includes(item.object.visibleLod)
          && !(item.object.remoteHorizon
            && (work.generation.nearVisibleStableIds ?? new Set()).has(item.object.stableId))
          && opacity > 0;
        work.live.mesh.setMatrixAt(operation.slot, visible ? item.matrix : hidden);
        if (item) {
          writeRemoteBuildingAnchor(work.live, operation.slot, item.object, work.generation);
          writeRemoteSourceColor(work.live, operation.slot, item);
          writeNaturalAnchor(work.live, operation.slot, item.object, work.generation);
          writeNaturalInitialReveal(
            work.live, operation.slot, item.object, work.generation, item,
          );
          writeLocalHandoffOpacity(work.live, operation.slot, visible ? opacity : 0);
        }
        work.preparedSlots.push(operation.slot);
        work.cursor += 1;
        matrixUpdates += 1;
      }
      if (work.cursor >= work.operations.length) {
        const slotBytes = 16 * 4
          + Number(Boolean(work.live.remoteAnchorAttribute)) * 2 * 4
          + Number(Boolean(work.live.remoteSourceColorAttribute)) * 3 * 4
          + Number(Boolean(work.live.naturalAnchorAttribute)) * 2 * 4
          + Number(Boolean(work.live.naturalInitialRevealAttribute)) * 4
          + Number(Boolean(work.live.localHandoffOpacityAttribute)) * 4;
        const bytes = new Set(work.preparedSlots).size * slotBytes;
        if (bytes <= DISTANT_PERSISTENT_UPLOAD_BUDGET_BYTES) {
          const slots = [...new Set(work.preparedSlots)].sort((left, right) => left - right);
          const matrixUpload = markAttributeRanges(work.live.mesh.instanceMatrix, slots, 16);
          const remoteUpload = markAttributeRanges(work.live.remoteAnchorAttribute, slots, 2);
          const remoteColorUpload = markAttributeRanges(
            work.live.remoteSourceColorAttribute,
            slots,
            3,
          );
          const anchorUpload = markAttributeRanges(work.live.naturalAnchorAttribute, slots, 2);
          const revealUpload = markAttributeRanges(
            work.live.naturalInitialRevealAttribute,
            slots,
            1,
          );
          const handoffUpload = markAttributeRanges(
            work.live.localHandoffOpacityAttribute,
            slots,
            1,
          );
          uploadBytes += (matrixUpload?.byteCount ?? 0)
            + (remoteUpload?.byteCount ?? 0)
            + (remoteColorUpload?.byteCount ?? 0)
            + (anchorUpload?.byteCount ?? 0)
            + (revealUpload?.byteCount ?? 0)
            + (handoffUpload?.byteCount ?? 0);
          bufferUpdates += [
            matrixUpload,
            remoteUpload,
            remoteColorUpload,
            anchorUpload,
            revealUpload,
            handoffUpload,
          ].filter(Boolean).length;
          work.live.items = work.nextItems;
          work.live.persistentSlotByKey = work.nextSlotByKey;
          work.live.mesh.count = work.nextItems.length;
          work.live.mesh.userData.canonicalStableIds = work.nextItems.map(item => {
            if (!item) return null;
            const opacity = canonicalInstanceOpacity(item.object, item);
            return ['mid', 'far'].includes(item.object.visibleLod) && opacity > 0
              ? item.object.stableId : null;
          });
          work.live.mesh.userData.canonicalObjects = work.nextItems.map(item => item?.object.record ?? null);
          work.live.mesh.userData.canonicalOpacities = work.nextItems.map(item => (
            item ? canonicalInstanceOpacity(item.object, item) : 0
          ));
          work.live.mesh.boundingBox = null;
          work.live.mesh.boundingSphere = null;
          distantPersistentBoundsRecalculationCount += 1;
          if (typeof work.live.mesh.computeBoundingSphere === 'function') {
            work.live.mesh.computeBoundingSphere();
          }
          work.generation.canonicalBuckets.set(work.desired.key, work.live);
          for (const item of work.nextItems) {
            if (!item) continue;
            item.object.instances = item.object.instances.map(instance => (
              instance.bucket === work.desired ? { bucket: work.live, item } : instance
            ));
          }
          liveDistantEntries.set(work.key, {
            key: work.key,
            bucket: work.live,
            mesh: work.live.mesh,
            generation: liveDistantEntries.get(work.key)?.generation ?? publication.previous,
          });
          distantPersistentReusedMeshCount += 1;
          publication.queue.shift();
          admissions = 1;
        } else {
          distantPersistentOverBudgetUploadCount += 1;
          throw new RangeError(`persistent Distant bucket upload exceeds frame budget: ${work.key}`);
        }
      }
    } else if (work) {
      const bytes = work.type === 'remove' ? 0 : estimateMeshUploadBytes(work.desired.mesh);
      if (bytes <= DISTANT_PERSISTENT_UPLOAD_BUDGET_BYTES) {
        publication.queue.shift();
        const previous = liveDistantEntries.get(work.key) ?? null;
        const roadPublicationWork = isSettlementRoadBucket(work.desired?.bucket)
          || isSettlementRoadBucket(previous?.bucket);
        if (previous) {
          persistentDistantRoot.remove(previous.mesh);
          previous.mesh.dispose?.();
          liveDistantEntries.delete(work.key);
          if (previous.generation && previous.generation !== publication.generation) {
            retiredDistantGenerations.add(previous.generation);
          }
          distantPersistentRemovedMeshCount += 1;
        }
        if (work.type !== 'remove') {
          const next = work.desired;
          next.mesh.parent?.remove?.(next.mesh);
          persistentDistantRoot.add(next.mesh);
          distantPersistentBoundsRecalculationCount += 1;
          if (typeof next.mesh.computeBoundingSphere === 'function') {
            next.mesh.computeBoundingSphere();
          }
          liveDistantEntries.set(work.key, next);
          distantPersistentCreatedMeshCount += 1;
          if (work.key.startsWith('bucket:')) distantPersistentNewCanonicalMeshCount += 1;
          else distantPersistentNewAuxiliaryMeshCount += 1;
          uploadBytes += bytes;
        }
        if (roadPublicationWork) markRoadLifecyclePublished(publication.generation);
        admissions = 1;
      }
    }
    if (uploadBytes > DISTANT_PERSISTENT_UPLOAD_BUDGET_BYTES) {
      distantPersistentOverBudgetUploadCount += 1;
    }
    distantPersistentUploadByteCount += uploadBytes;
    distantPersistentMatrixUpdateCount += matrixUpdates;
    distantPersistentBufferUpdateCount += bufferUpdates;
    distantPersistentMaximumMatrixUpdatesPerFrame = Math.max(
      distantPersistentMaximumMatrixUpdatesPerFrame,
      matrixUpdates,
    );
    distantPersistentMaximumBufferUpdatesPerFrame = Math.max(
      distantPersistentMaximumBufferUpdatesPerFrame,
      bufferUpdates,
    );
    distantPersistentMaximumUploadBytesPerFrame = Math.max(
      distantPersistentMaximumUploadBytesPerFrame,
      uploadBytes,
    );
    distantPersistentMaximumMeshAdmissionsPerFrame = Math.max(
      distantPersistentMaximumMeshAdmissionsPerFrame,
      admissions,
    );
    if (admissions > DISTANT_PERSISTENT_MESH_ADMISSION_LIMIT) {
      distantPersistentAdmissionLimitViolationCount += 1;
    }
    distantPersistentMaximumSliceMs = Math.max(
      distantPersistentMaximumSliceMs,
      monotonicNow() - startedAt,
    );
    if (publication.queue.length === 0) completePersistentDistantPublication(publication);
    return Object.freeze({ admissions, bytes: uploadBytes });
  };
  const beginPersistentDistantPublication = (generation, previous) => {
    if (!persistentDistantRoot || !previous) return false;
    const displayPrevious = persistentDistantPublishedGeneration ?? previous;
    if (pendingDistantPublication) {
      rollbackUnpublishedPersistentBucketWrites(pendingDistantPublication);
      retiredDistantGenerations.add(pendingDistantPublication.generation);
    }
    const desiredEntries = new Map([
      ...directCanonicalMeshEntries(generation),
      ...directAuxiliaryMeshEntries(generation),
    ]);
    const queue = [];
    for (const [key, desired] of desiredEntries) {
      const live = liveDistantEntries.get(key) ?? null;
      const reusableBucket = key.startsWith('bucket:') && live
        && desired.bucket.persistentReuseEntryKey === key;
      if (reusableBucket) queue.push(createPersistentBucketWork(
        generation,
        desired.bucket,
        live.bucket,
      ));
      else queue.push({ type: live ? 'replace' : 'add', key, desired });
    }
    for (const [key, live] of liveDistantEntries) {
      if (generation.independentRoadPresentation === true
        && isSettlementRoadBucket(live?.bucket)) continue;
      if (!desiredEntries.has(key)) queue.push({ type: 'remove', key, desired: null });
    }
    queue.sort((left, right) => {
      const rank = work => {
        if (pendingPublicationWorkIsRoad(work)) return -1;
        if (work.type === 'bucket') return work.required ? 0 : 1;
        if (work.type === 'remove') return 4;
        return work.key.startsWith('bucket:') ? 2 : 3;
      };
      return rank(left) - rank(right) || left.key.localeCompare(right.key);
    });
    const stagingRoot = generation.root;
    generation.buildOriginChunkX = displayPrevious.buildOriginChunkX;
    generation.buildOriginChunkZ = displayPrevious.buildOriginChunkZ;
    positionGenerationForOrigin(generation, committedRenderOrigin);
    generation.root = persistentDistantRoot;
    generation.naturalLodMaterials = new Map([
      ...(displayPrevious.naturalLodMaterials ?? new Map()),
      ...(generation.naturalLodMaterials ?? new Map()),
    ]);
    generation.localFullHandoffMaterials = new Map([
      ...(displayPrevious.localFullHandoffMaterials ?? new Map()),
      ...(generation.localFullHandoffMaterials ?? new Map()),
    ]);
    generation.remoteHorizonSilhouetteMaterial ??=
      displayPrevious.remoteHorizonSilhouetteMaterial;
    generation.horizonBuildingSilhouetteMaterial ??=
      displayPrevious.horizonBuildingSilhouetteMaterial;
    retiredDistantGenerations.add(displayPrevious);
    activeGeneration = generation;
    if (generation.independentRoadPresentation === true && publishedRoadGeneration) {
      installRoadCanonicalReferences(generation, publishedRoadGeneration);
    }
    pendingDistantPublication = {
      generation,
      previous: displayPrevious,
      stagingRoot,
      queue,
    };
    if (queue.length === 0) completePersistentDistantPublication(pendingDistantPublication);
    return true;
  };
  const processDeferredGenerationDisposals = (
    budgetMs = STATIC_TREE_DISPOSE_BUDGET_MS,
    resourceLimit = Number.POSITIVE_INFINITY,
  ) => {
    const startedAt = monotonicNow();
    let disposedResources = 0;
    while (deferredGenerationDisposals.length
      && disposedResources < resourceLimit
      && monotonicNow() - startedAt < budgetMs) {
      const entry = deferredGenerationDisposals[0];
      if (entry.children.length) entry.children.pop().dispose?.();
      else if (entry.geometries.length) entry.geometries.pop().dispose?.();
      else if (entry.materials.length) entry.materials.pop().dispose?.();
      else {
        entry.rootToClear?.clear?.();
        entry.generation.ownedGeometries?.clear?.();
        entry.generation.ownedMaterials?.clear?.();
        deferredGenerationDisposals.shift();
        continue;
      }
      disposedResources += 1;
    }
    return disposedResources;
  };

  const readThroughLru = async (
    cache,
    key,
    capacity,
    load,
    onCacheEvent = null,
    pendingIdentity = null,
  ) => {
    if (cache.has(key)) {
      const entry = cache.get(key);
      if (!entry.pending || pendingIdentity === null
        || entry.pendingIdentity === pendingIdentity) {
        onCacheEvent?.('hit');
        cache.delete(key);
        cache.set(key, entry);
        return entry.promise;
      }
      // A superseded ChunkData subscriber resolves to null when its epoch is
      // cancelled. Never let a newer sync inherit that pending result.
      cache.delete(key);
    }
    onCacheEvent?.('miss');
    const entry = { pending: true, pendingIdentity, promise: null };
    entry.promise = Promise.resolve().then(load).then(
      value => {
        entry.pending = false;
        if (value == null && cache.get(key) === entry) cache.delete(key);
        return value;
      },
      error => {
        if (cache.get(key) === entry) cache.delete(key);
        throw error;
      },
    );
    cache.set(key, entry);
    while (cache.size > capacity) {
      const eviction = [...cache].find(([entryKey, value]) => entryKey !== key && !value.pending);
      if (!eviction) break;
      cache.delete(eviction[0]);
      onCacheEvent?.('eviction');
    }
    return entry.promise;
  };

  const resolveBaseClipmapSample = (
    worldX,
    worldZ,
    surfacePolicy = currentCanonicalSurfacePolicy,
    refreshSurface = true,
  ) => {
    // The expensive macro/biome identity is a logical world-grid coordinate. It
    // must not include the player-relative center, a transient surface-policy
    // object identity, or the Floating Origin.
    const key = `${worldX},${worldZ}`;
    let entry = clipmapSampleCache.get(key);
    let naturalSampleReused = true;
    if (entry) {
      clipmapSampleCacheHits += 1;
      // LRU touch: a moving clipmap retains its current world window without
      // increasing the long-standing 65,536 sample capacity.
      clipmapSampleCache.delete(key);
      clipmapSampleCache.set(key, entry);
    } else {
      naturalSampleReused = false;
      const macro = macroEvaluator.evaluate(worldX, worldZ);
      const step = 0.5;
      const dx = (macroEvaluator.evaluate(worldX + step, worldZ).offsetMm
        - macroEvaluator.evaluate(worldX - step, worldZ).offsetMm) * 0.001 / (2 * step);
      const dz = (macroEvaluator.evaluate(worldX, worldZ + step).offsetMm
        - macroEvaluator.evaluate(worldX, worldZ - step).offsetMm) * 0.001 / (2 * step);
      const slope = Math.hypot(dx, dz);
      const biome = biomeEvaluator.evaluate({ x: worldX, z: worldZ }, macro, slope);
      const ridge = clamp(
        macro.components.ridgesMm / G5_MACRO_TERRAIN.ridges.amplitudeMm,
        0,
        1,
      );
      const moisture = clamp(biome.climate.moisture
        + clamp(-macro.components.valleysMm / G5_MACRO_TERRAIN.valleys.amplitudeMm, 0, 1)
          * 0.12
        - ridge * 0.09, 0, 1);
      const rockiness = clamp(0.035 + ridge * 0.36
        + clamp(slope / G5_MACRO_TERRAIN.maximumSlope, 0, 1) * 0.58, 0, 1);
      entry = {
        naturalHeight: 0.4 + macro.offsetMm * 0.001,
        naturalColor: Object.freeze(w8TerrainColorFromWeights(naturalMaterialWeights(
          biome.memberships,
          moisture,
          rockiness,
          slope,
        ))),
        moisture,
        ridge,
        slope,
        biome,
        surfaceSignature: null,
        value: null,
        lastNaturalSampleReused: false,
        lastSurfaceSampleReused: false,
      };
      clipmapSampleCache.set(key, entry);
      clipmapSampleCacheMisses += 1;
      while (clipmapSampleCache.size > CLIPMAP_SAMPLE_CACHE_CAPACITY) {
        clipmapSampleCache.delete(clipmapSampleCache.keys().next().value);
        clipmapSampleCacheEvictions += 1;
      }
    }
    let surfaceSampleReused = entry.value !== null && refreshSurface === false;
    if (!surfaceSampleReused) {
      const transition = resolveCanonicalSurfaceWeights(
        surfacePolicy,
        worldX,
        worldZ,
      ).naturalWeight;
      const river = resolveCanonicalRiverBed(
        surfacePolicy?.riverCorridors,
        worldX,
        worldZ,
      );
      const surfaceSignature = `${transition}:${river.bankWeight}:${river.depthMeters}`;
      surfaceSampleReused = entry.surfaceSignature === surfaceSignature && entry.value !== null;
      if (!surfaceSampleReused) {
      const baseHeight = entry.naturalHeight * transition;
      const surface = Object.freeze({
        naturalWeight: transition,
        finiteWeight: 1 - transition,
        riverBankWeight: river.bankWeight,
      });
      entry.surfaceSignature = surfaceSignature;
      entry.value = Object.freeze({
        height: baseHeight - river.depthMeters,
        heightMeters: baseHeight - river.depthMeters,
        baseHeight,
        riverSurfaceHeight: river.depthMeters > 0 ? baseHeight : null,
        riverSurfaceHeightMeters: river.depthMeters > 0 ? baseHeight : null,
        riverStableId: river.sourceStableId,
        color: resolveCanonicalSurfaceColorRgb({
          naturalColor: entry.naturalColor,
          surface,
          worldX,
          worldZ,
        }),
        moisture: entry.moisture,
        ridge: entry.ridge,
      });
      clipmapSurfaceSampleRefreshCount += 1;
      }
    }
    if (surfaceSampleReused) {
      clipmapSurfaceSampleReuseCount += 1;
    }
    entry.lastNaturalSampleReused = naturalSampleReused;
    entry.lastSurfaceSampleReused = surfaceSampleReused;
    return entry;
  };

  const baseClipmapSample = (
    worldX,
    worldZ,
    surfacePolicy = currentCanonicalSurfacePolicy,
  ) => resolveBaseClipmapSample(worldX, worldZ, surfacePolicy).value;

  const ensureMacroSurfaceWindow = (centerMacroX, centerMacroZ) => {
    const key = `${centerMacroX},${centerMacroZ}`;
    if (macroSurfaceWindowCache.has(key)) {
      const cached = macroSurfaceWindowCache.get(key);
      macroSurfaceWindowCache.delete(key);
      macroSurfaceWindowCache.set(key, cached);
      macroSurfaceWindowReuseCount += 1;
      return cached.promise;
    }
    const centerWorldX = (centerMacroX + 0.5) * MACRO_CELL_SIZE_METERS;
    const centerWorldZ = (centerMacroZ + 0.5) * MACRO_CELL_SIZE_METERS;
    const queryRadiusMeters = MACRO_RESIDENT_RADIUS_METERS
      + Math.SQRT2 * MACRO_CELL_SIZE_METERS;
    const startedAt = monotonicNow();
    const entry = {
      key,
      centerMacroX,
      centerMacroZ,
      cellPolicies: new Map(),
      settlements: null,
      promise: null,
    };
    macroSurfaceWindowQueryCount += 1;
    entry.promise = Promise.resolve(findSettlementsNear(
      centerWorldX,
      centerWorldZ,
      queryRadiusMeters,
    )).then(settlements => {
      entry.settlements = Object.freeze([...(settlements ?? [])]);
      macroSurfaceWindowMaximumQueryMs = Math.max(
        macroSurfaceWindowMaximumQueryMs,
        monotonicNow() - startedAt,
      );
      return entry;
    }).catch(error => {
      if (macroSurfaceWindowCache.get(key) === entry) {
        macroSurfaceWindowCache.delete(key);
      }
      throw error;
    });
    macroSurfaceWindowCache.set(key, entry);
    while (macroSurfaceWindowCache.size > 3) {
      macroSurfaceWindowCache.delete(macroSurfaceWindowCache.keys().next().value);
    }
    return entry.promise;
  };

  const macroSurfacePolicyForCell = (window, macroX, macroZ) => {
    const key = `${macroX},${macroZ}`;
    if (window.cellPolicies.has(key)) return window.cellPolicies.get(key);
    const corridors = [];
    for (let ownerOffsetZ = 0; ownerOffsetZ < 4; ownerOffsetZ += 1) {
      for (let ownerOffsetX = 0; ownerOffsetX < 4; ownerOffsetX += 1) {
        const corridor = createCanonicalRiverSurfaceCorridor({
          sourceStableId: canonicalRiverSourceStableId,
          chunkX: macroX * 4 + ownerOffsetX,
          chunkZ: macroZ * 4 + ownerOffsetZ,
          settlementReferences: window.settlements,
        });
        if (corridor) corridors.push(corridor);
      }
    }
    const policy = createSettlementSurfacePolicy(window.settlements, corridors);
    window.cellPolicies.set(key, policy);
    macroSurfacePolicyBuildCount += 1;
    return policy;
  };

  const macroCellGenerator = enableMacroCoarseWorld
    ? createMacroCoarseCellGenerator({
      sampleGround(worldX, worldZ, context) {
        return resolveBaseClipmapSample(
          worldX,
          worldZ,
          context?.surfacePolicy ?? currentCanonicalSurfacePolicy,
        ).value;
      },
    })
    : null;

  if (enableMacroCoarseWorld) {
    macroCoarseWorldController = createMacroCoarseWorldController({
      async generateCell({ macroX, macroZ, context }) {
        const surfaceWindow = await (context?.surfaceWindowPromise
          ?? ensureMacroSurfaceWindow(macroX, macroZ));
        const surfacePolicy = macroSurfacePolicyForCell(surfaceWindow, macroX, macroZ);
        const [terrainCell, canonicalTreeCell] = await Promise.all([
          macroCellGenerator.generateCell({
            macroX,
            macroZ,
            context: Object.freeze({ surfacePolicy }),
          }),
          directCanonicalTreeSupply
            ? generateCanonicalTreeCell({ macroX, macroZ }) : Promise.resolve(null),
        ]);
        if (directCanonicalTreeSupply
          && (canonicalTreeCell?.schemaVersion !== W8_CANONICAL_TREE_CELL_SCHEMA
            || canonicalTreeCell.key !== terrainCell.key)) {
          throw new Error(`invalid canonical Tree cell result: ${terrainCell.key}`);
        }
        return Object.freeze({
          ...terrainCell,
          ...(canonicalTreeCell ? { canonicalTreeCell } : {}),
        });
      },
      publishCell(cell) {
        if (!macroCoarseWorldPresentation) {
          throw new Error('Macro coarse presentation must exist before publication');
        }
        const terrainPublished = macroCoarseWorldPresentation.publishCell(cell);
        const treeStaged = !directCanonicalTreeSupply
          || stageDirectCanonicalTreeCell(cell.canonicalTreeCell);
        return terrainPublished && treeStaged;
      },
      retireCell(key) {
        if (directCanonicalTreeSupply) retireDirectCanonicalTreeCell(key);
        return macroCoarseWorldPresentation?.retireCell(key) ?? false;
      },
    });
  }

  const ensureMacroCoarseWorldPresentation = (playerLogicalX, playerLogicalZ) => {
    if (!enableMacroCoarseWorld || macroCoarseWorldPresentation) {
      return macroCoarseWorldPresentation;
    }
    const center = logicalWorldToMacroCell(playerLogicalX, playerLogicalZ);
    const anchor = {
      x: (center.macroX + 0.5) * MACRO_CELL_SIZE_METERS,
      z: (center.macroZ + 0.5) * MACRO_CELL_SIZE_METERS,
    };
    macroCoarseWorldPresentation = createMacroCoarseWorldPresentation({
      THREE,
      parent: root,
      terrainSourceMaterial: terrainMaterial,
      maximumCells: MACRO_MAX_RETAINED_CELLS,
      unitsPerMeter: UNITS_PER_METER,
      logicalChunkSizeMeters: LOGICAL_CHUNK_SIZE_METERS,
      anchorWorldX: anchor.x,
      anchorWorldZ: anchor.z,
    });
    return macroCoarseWorldPresentation;
  };

  let macroCoarseWorldLastPlayerX = null;
  let macroCoarseWorldLastPlayerZ = null;
  let macroCoarseWorldLastRenderOrigin = null;
  const updateMacroCoarseWorldPresentation = ({
    playerLogicalX,
    playerLogicalZ,
    renderOrigin,
  }) => {
    const presentation = ensureMacroCoarseWorldPresentation(playerLogicalX, playerLogicalZ);
    if (!presentation) return false;
    macroCoarseWorldLastPlayerX = playerLogicalX;
    macroCoarseWorldLastPlayerZ = playerLogicalZ;
    macroCoarseWorldLastRenderOrigin = renderOrigin;
    const detailTerrainGeneration = activeLocalTerrainGeneration?.root?.parent === root
      ? activeLocalTerrainGeneration : null;
    return presentation.update({
      playerWorldX: playerLogicalX,
      playerWorldZ: playerLogicalZ,
      renderOrigin,
      detailTerrainReady: detailTerrainGeneration !== null,
      detailTerrainCenterWorldX: detailTerrainGeneration
        ? (detailTerrainGeneration.centerChunkX + 0.5) * LOGICAL_CHUNK_SIZE_METERS : 0,
      detailTerrainCenterWorldZ: detailTerrainGeneration
        ? (detailTerrainGeneration.centerChunkZ + 0.5) * LOGICAL_CHUNK_SIZE_METERS : 0,
      detailTerrainExtentMeters:
        detailTerrainGeneration?.renderDistancePolicy?.terrainCoverageDistanceMeters ?? 0,
    });
  };
  const refreshMacroCoarseWorldPresentation = (
    renderOrigin = macroCoarseWorldLastRenderOrigin,
  ) => {
    if (!macroCoarseWorldPresentation
      || !Number.isFinite(macroCoarseWorldLastPlayerX)
      || !Number.isFinite(macroCoarseWorldLastPlayerZ)
      || !renderOrigin) return false;
    return updateMacroCoarseWorldPresentation({
      playerLogicalX: macroCoarseWorldLastPlayerX,
      playerLogicalZ: macroCoarseWorldLastPlayerZ,
      renderOrigin,
    });
  };

  const sampleCanonicalObjectGround = (
    worldX,
    worldZ,
    surfacePolicy = currentCanonicalSurfacePolicy,
  ) => {
    const ownerX = Math.floor(worldX / LOGICAL_CHUNK_SIZE_METERS);
    const ownerZ = Math.floor(worldZ / LOGICAL_CHUNK_SIZE_METERS);
    const localX = worldX - ownerX * LOGICAL_CHUNK_SIZE_METERS;
    const localZ = worldZ - ownerZ * LOGICAL_CHUNK_SIZE_METERS;
    const sampleSpacingMeters = 0.5;
    const fx = clamp(localX / sampleSpacingMeters, 0, 32);
    const fz = clamp(localZ / sampleSpacingMeters, 0, 32);
    const x0 = Math.floor(fx); const z0 = Math.floor(fz);
    const x1 = Math.min(32, x0 + 1); const z1 = Math.min(32, z0 + 1);
    const tx = fx - x0; const tz = fz - z0;
    const at = (sampleX, sampleZ) => Math.round(400 + macroEvaluator.evaluate(
      ownerX * LOGICAL_CHUNK_SIZE_METERS + sampleX * sampleSpacingMeters,
      ownerZ * LOGICAL_CHUNK_SIZE_METERS + sampleZ * sampleSpacingMeters,
    ).offsetMm) * 0.001;
    const northwest = at(x0, z0);
    const northeast = at(x1, z0);
    const southwest = at(x0, z1);
    const southeast = at(x1, z1);
    const naturalHeight = tx + tz <= 1
      ? northwest + tx * (northeast - northwest) + tz * (southwest - northwest)
      : northeast * (1 - tz) + southwest * (1 - tx) + southeast * (tx + tz - 1);
    const naturalWeight = resolveCanonicalSurfaceWeights(
      surfacePolicy,
      worldX,
      worldZ,
    ).naturalWeight;
    return Math.round(naturalHeight * naturalWeight * 1e6) / 1e6;
  };

  const prepareMidgroundTerrainBuild = () => ({
    positions: [],
    colors: [],
    indices: [],
    ownerIndexRanges: new Map(),
    ownerVertexRanges: new Map(),
    reusedOwnerKeys: new Set(),
    newOwnerKeys: new Set(),
    reusedSampleCount: 0,
    newSampleCount: 0,
  });

  const midgroundOwnerSampleFor = chunk => {
    const ownerKey = `${chunk.chunkX},${chunk.chunkZ}`;
    const identity = `${chunk.contentHash ?? chunk.chunkId ?? 'no-content-hash'}:${
      chunk.terrain?.resolution?.x ?? 0}x${chunk.terrain?.resolution?.z ?? 0}`;
    const cached = midgroundOwnerSampleCache.get(ownerKey);
    if (cached?.identity === identity) {
      midgroundOwnerSampleCache.delete(ownerKey);
      midgroundOwnerSampleCache.set(ownerKey, cached);
      midgroundOwnerSampleCacheHits += 1;
      return Object.freeze({ sample: cached, reused: true });
    }
    const terrain = chunk.terrain;
    const sampleAxis = length => {
      const values = [];
      for (let index = 0; index < length - 1; index += 2) values.push(index);
      values.push(length - 1);
      return values;
    };
    const sampleX = sampleAxis(terrain.resolution.x);
    const sampleZ = sampleAxis(terrain.resolution.z);
    const width = sampleX.length;
    const depth = sampleZ.length;
    const positionsWorldMeters = new Float32Array(width * depth * 3);
    const colors = new Float32Array(width * depth * 3);
    for (let z = 0; z < depth; z += 1) {
      for (let x = 0; x < width; x += 1) {
        const sourceX = sampleX[x];
        const sourceZ = sampleZ[z];
        const sourceIndex = sourceZ * terrain.resolution.x + sourceX;
        const worldX = chunk.chunkX * LOGICAL_CHUNK_SIZE_METERS
          + sourceX / (terrain.resolution.x - 1) * LOGICAL_CHUNK_SIZE_METERS;
        const worldZ = chunk.chunkZ * LOGICAL_CHUNK_SIZE_METERS
          + sourceZ / (terrain.resolution.z - 1) * LOGICAL_CHUNK_SIZE_METERS;
        const surface = chunk.canonicalSurfacePolicy
          ? resolveCanonicalGroundSurface({ chunkData: chunk, worldX, worldZ })
          : {
              heightMeters: terrain.heights[sourceIndex] * terrain.heightUnitMeters,
              naturalWeight: 1,
              finiteWeight: 0,
            };
        const offset = (z * width + x) * 3;
        positionsWorldMeters[offset] = worldX;
        positionsWorldMeters[offset + 1] = surface.heightMeters;
        positionsWorldMeters[offset + 2] = worldZ;
        const naturalColor = w8TerrainColorFromWeights(
          terrain.materialWeights.slice(sourceIndex * 5, sourceIndex * 5 + 5),
        );
        const color = resolveCanonicalSurfaceColorRgb({
          naturalColor,
          surface,
          worldX,
          worldZ,
        });
        if (!color.every(Number.isFinite)
          || (color[0] === 0 && color[1] === 0 && color[2] === 0)) {
          throw new Error(`invalid canonical Terrain color at Medium owner ${ownerKey}`);
        }
        colors[offset] = color[0];
        colors[offset + 1] = color[1];
        colors[offset + 2] = color[2];
      }
    }
    const localIndices = new Uint16Array((width - 1) * (depth - 1) * 6);
    let cursor = 0;
    for (let z = 0; z < depth - 1; z += 1) {
      for (let x = 0; x < width - 1; x += 1) {
        const northwest = z * width + x;
        localIndices[cursor++] = northwest;
        localIndices[cursor++] = northwest + width;
        localIndices[cursor++] = northwest + 1;
        localIndices[cursor++] = northwest + 1;
        localIndices[cursor++] = northwest + width;
        localIndices[cursor++] = northwest + width + 1;
      }
    }
    const sample = Object.freeze({
      identity,
      ownerKey,
      width,
      depth,
      positionsWorldMeters,
      colors,
      localIndices,
      sampleCount: width * depth,
    });
    midgroundOwnerSampleCache.delete(ownerKey);
    midgroundOwnerSampleCache.set(ownerKey, sample);
    midgroundOwnerSampleCacheMisses += 1;
    while (midgroundOwnerSampleCache.size > MIDGROUND_OWNER_SAMPLE_CACHE_CAPACITY) {
      midgroundOwnerSampleCache.delete(midgroundOwnerSampleCache.keys().next().value);
      midgroundOwnerSampleCacheEvictions += 1;
    }
    return Object.freeze({ sample, reused: false });
  };

  const appendMidgroundTerrainChunk = (build, chunk, origin) => {
    const {
      positions,
      colors,
      indices,
      ownerIndexRanges,
      ownerVertexRanges,
    } = build;
    const { sample, reused } = midgroundOwnerSampleFor(chunk);
    const ownerIndexStart = indices.length;
    const ownerVertexStart = positions.length / 3;
    const originMetersX = origin.renderOriginChunkX * LOGICAL_CHUNK_SIZE_METERS;
    const originMetersZ = origin.renderOriginChunkZ * LOGICAL_CHUNK_SIZE_METERS;
    for (let offset = 0; offset < sample.positionsWorldMeters.length; offset += 3) {
      positions.push(
        (sample.positionsWorldMeters[offset] - originMetersX) * UNITS_PER_METER,
        sample.positionsWorldMeters[offset + 1] * UNITS_PER_METER,
        (sample.positionsWorldMeters[offset + 2] - originMetersZ) * UNITS_PER_METER,
      );
      colors.push(
        sample.colors[offset],
        sample.colors[offset + 1],
        sample.colors[offset + 2],
      );
    }
    for (const index of sample.localIndices) indices.push(ownerVertexStart + index);
    ownerIndexRanges.set(sample.ownerKey, Object.freeze({
      start: ownerIndexStart,
      count: indices.length - ownerIndexStart,
    }));
    ownerVertexRanges.set(sample.ownerKey, Object.freeze({
      start: ownerVertexStart,
      count: sample.sampleCount,
    }));
    if (reused) {
      build.reusedOwnerKeys.add(sample.ownerKey);
      build.reusedSampleCount += sample.sampleCount;
    } else {
      build.newOwnerKeys.add(sample.ownerKey);
      build.newSampleCount += sample.sampleCount;
    }
  };

  const finishMidgroundTerrainBuild = (build, context) => {
    const {
      positions,
      colors,
      indices,
      ownerIndexRanges,
      ownerVertexRanges,
      reusedOwnerKeys,
      newOwnerKeys,
      reusedSampleCount,
      newSampleCount,
    } = build;
    if (!positions.length) return;
    const diagnosticStartedAt = diagnosticsEnabled ? monotonicNow() : 0;
    const allIndices = Object.freeze([...indices]);
    const initialOwnerKeys = sortedKeyList(context.generation.midgroundOwnerKeys);
    const initialIndices = [];
    for (const ownerKey of initialOwnerKeys) {
      const range = ownerIndexRanges.get(ownerKey);
      if (!range) continue;
      initialIndices.push(...allIndices.slice(range.start, range.start + range.count));
    }
    const { resource, allocated } = acquireMidgroundGeometryResource({
      positions,
      colors,
      indices: initialIndices,
      generation: context.generation,
    });
    const { geometry } = resource;
    localTerrainOwnerIndexData.set(geometry, Object.freeze({
      allIndices,
      ownerIndexRanges,
      ownerVertexRanges,
      ownerKeys: Object.freeze(sortedKeyList(ownerIndexRanges.keys())),
    }));
    context.ownedGeometries.add(geometry);
    const mesh = new Mesh(geometry, terrainMaterial);
    mesh.name = 'w8-midground-outer-sixteen-terrain';
    mesh.castShadow = false; mesh.receiveShadow = false;
    mesh.userData = {
      presentationOnly: true,
      logicalTerrainSurface: true,
      terrainLodBand: W8_LOGICAL_TERRAIN_BAND.MEDIUM,
      localTerrainOwnerHandoff: true,
      ownerKeys: Object.freeze(sortedKeyList(ownerIndexRanges.keys())),
      visibleOwnerKeys: Object.freeze(initialOwnerKeys),
      visibleOwnerIndexCount: initialIndices.length,
    };
    context.generation.localTerrainMesh = mesh;
    context.generation.currentVisibleMidgroundOwnerKeys = new Set(initialOwnerKeys);
    const previousOwnerKeys = activeLocalTerrainGeneration?.activeKeys ?? new Set();
    const discardedOwnerCount = [...previousOwnerKeys]
      .filter(ownerKey => !context.generation.activeKeys.has(ownerKey)).length;
    const samplesPerOwner = ownerVertexRanges.values().next().value?.count ?? 0;
    const discardedSampleCount = discardedOwnerCount * samplesPerOwner;
    context.stats.midgroundSampleCount = reusedSampleCount + newSampleCount;
    context.stats.midgroundNewSampleCount = newSampleCount;
    context.stats.midgroundReusedSampleCount = reusedSampleCount;
    context.stats.midgroundDiscardedSampleCount = discardedSampleCount;
    context.stats.midgroundNewOwnerCount = newOwnerKeys.size;
    context.stats.midgroundReusedOwnerCount = reusedOwnerKeys.size;
    context.stats.midgroundDiscardedOwnerCount = discardedOwnerCount;
    context.stats.midgroundSampleReuseRatio = context.stats.midgroundSampleCount > 0
      ? reusedSampleCount / context.stats.midgroundSampleCount : 1;
    context.stats.midgroundGeometryAllocationCount = Number(allocated);
    context.stats.midgroundGeometryReuseCount = Number(!allocated);
    midgroundTotalNewSampleCount += newSampleCount;
    midgroundTotalReusedSampleCount += reusedSampleCount;
    midgroundTotalDiscardedSampleCount += discardedSampleCount;
    context.target.add(mesh);
    if (diagnosticsEnabled) recordDiagnosticWork('local-terrain-build', {
      calls: 1,
      owners: ownerIndexRanges.size,
      newOwners: newOwnerKeys.size,
      reusedOwners: reusedOwnerKeys.size,
      discardedOwners: discardedOwnerCount,
      vertices: positions.length / 3,
      indices: initialIndices.length,
      allocatedBytes: (positions.length + colors.length + initialIndices.length) * 4,
      maximumSynchronousSliceMs: monotonicNow() - diagnosticStartedAt,
    });
  };

  const applyLocalTerrainOwnerHandoff = (
    generation,
    activeDataKeys,
    renderedKeys,
  ) => {
    if (!generation) return false;
    const mesh = generation.localTerrainMesh ?? generation.root.children?.find(child => (
      child.name === 'w8-midground-outer-sixteen-terrain'
    ));
    const ownerData = mesh ? localTerrainOwnerIndexData.get(mesh.geometry) : null;
    if (!mesh || !ownerData) return false;
    generation.localTerrainMesh = mesh;
    const currentActiveKeys = new Set(activeDataKeys);
    const currentRenderedKeys = new Set(renderedKeys);
    const visibleOwnerKeys = ownerData.ownerKeys.filter(ownerKey => (
      generation.activeKeys.has(ownerKey)
        && !currentRenderedKeys.has(ownerKey)
    ));
    const previousSignature = sortedKeyList(
      generation.currentVisibleMidgroundOwnerKeys ?? [],
    ).join('\n');
    const nextSignature = visibleOwnerKeys.join('\n');
    if (previousSignature !== nextSignature) {
      const diagnosticStartedAt = diagnosticsEnabled ? monotonicNow() : 0;
      const visibleIndices = [];
      for (const ownerKey of visibleOwnerKeys) {
        const range = ownerData.ownerIndexRanges.get(ownerKey);
        if (!range) continue;
        visibleIndices.push(...ownerData.allIndices.slice(
          range.start,
          range.start + range.count,
        ));
      }
      mesh.geometry.setIndex(visibleIndices);
      mesh.userData.visibleOwnerIndexCount = visibleIndices.length;
      generation.currentVisibleMidgroundOwnerKeys = new Set(visibleOwnerKeys);
      if (diagnosticsEnabled) recordDiagnosticWork('local-terrain-index-handoff', {
        calls: 1,
        owners: visibleOwnerKeys.length,
        rebuiltIndices: visibleIndices.length,
        uploadBytes: visibleIndices.length * 4,
        maximumSynchronousSliceMs: monotonicNow() - diagnosticStartedAt,
      });
    }
    mesh.userData.visibleOwnerKeys = Object.freeze([...visibleOwnerKeys]);
    mesh.userData.handoffActiveDataKeys = Object.freeze(sortedKeyList(currentActiveKeys));
    mesh.userData.handoffRenderedKeys = Object.freeze(sortedKeyList(currentRenderedKeys));
    return true;
  };

  const createMidgroundTerrain = (chunks, origin, context) => {
    const build = prepareMidgroundTerrainBuild();
    for (const chunk of chunks) appendMidgroundTerrainChunk(build, chunk, origin);
    finishMidgroundTerrainBuild(build, context);
  };

  const createMidgroundTerrainIncrementally = async (
    chunks,
    origin,
    context,
    scheduler,
  ) => {
    const build = prepareMidgroundTerrainBuild();
    for (const chunk of chunks) {
      appendMidgroundTerrainChunk(build, chunk, origin);
      const pendingYield = scheduler.checkpoint();
      if (pendingYield) await pendingYield;
    }
    finishMidgroundTerrainBuild(build, context);
    await scheduler.checkpoint({ force: true });
  };

  const canonicalPartsFor = record => {
    if (record.objectType === 'building') {
      return visualAssets.resolveBuildingParts?.(record)
        ?? visualAssets.featureParts[record.presentation.partSetKey]
        ?? record.presentation.parts;
    }
    if (record.presentation?.partSetKey) {
      return visualAssets.featureParts[record.presentation.partSetKey]
        ?? (record.presentation?.parts?.length ? record.presentation.parts : null);
    }
    return null;
  };

  const canonicalIdentity = (record, chunk, parts) => ({
    stableId: record.stableId,
    settlementId: record.settlementId ?? record.parentSettlementId ?? null,
    ...(record.candidateId ? {
      candidateId: record.candidateId,
      subtype: record.subtype ?? null,
    } : {}),
    buildingType: record.buildingType ?? null,
    landmarkType: record.landmarkType ?? null,
    featureType: record.featureType ?? (record.landmarkType ? 'settlement-landmark' : null),
    worldPosition: {
      x: record.worldPosition.x,
      y: record.worldPosition.y,
      z: record.worldPosition.z,
    },
    rotationY: record.rotationY ?? 0,
    dimensions: {
      widthMeters: record.widthMeters ?? null,
      heightMeters: record.heightMeters ?? null,
      depthMeters: record.depthMeters ?? null,
    },
    visual: record.visual ?? null,
    parts: parts?.map(part => ({
      geometry: part.geometry,
      material: part.material,
      position: [...part.position],
      scale: [...part.scale],
      rotation: [...part.rotation],
      materialRole: part.materialRole ?? null,
    })) ?? null,
    owningChunkCoordinate: {
      x: record.owningChunkCoordinate.x,
      z: record.owningChunkCoordinate.z,
    },
    chunkId: chunk.chunkId,
    canonicalSourceRevision: `${worldSeedHash}:${chunk.generatorVersion?.major ?? 'remote'}`,
    sourceW5ContentHash: chunk.sourceW5ContentHash ?? chunk.sourceChunkData?.contentHash ?? null,
  });

  const addCanonicalMatrix = (
    object,
    geometry,
    material,
    name,
    matrix,
    visibilityTiers = Object.freeze(['full']),
    context,
    remoteSourceColor = null,
  ) => {
    const key = `${geometry}:${material}:${name}`;
    const persistentDistant = context.generation.persistentDistant === true
      && isPersistentDistantBucketName(name);
    if (!context.generation.canonicalBuckets.has(key)) {
      const persistentNatural = context.generation.persistentNatural === true
        || context.generation.persistentTree === true;
      context.generation.canonicalBuckets.set(key, {
        key,
        geometry,
        material,
        name,
        items: [],
        ...(persistentNatural || persistentDistant ? {
          capacity: persistentNatural
            ? resolvePersistentPresentationBucketCapacity({
              generation: context.generation,
              bucket: { geometry, material, name },
              requiredSlots: 1,
            })
            : PERSISTENT_DISTANT_BUCKET_CAPACITY,
          persistent: true,
        } : {}),
      });
    }
    const bucket = context.generation.canonicalBuckets.get(key);
    const item = {
      object,
      matrix: matrix.clone?.() ?? structuredClone(matrix),
      visibilityTiers,
      remoteSourceColor,
    };
    bucket.items.push(item);
    if (context.generation.persistentNatural === true
      || context.generation.persistentTree === true || persistentDistant) {
      item.slot = bucket.items.length - 1;
      object.instances.push({ bucket, item });
      bucket.dirtySlots ??= new Set();
      bucket.dirtySlots.add(item.slot);
      context.generation.currentPageBuckets?.add?.(bucket);
    }
    return { bucket, item };
  };

  const registerCanonicalRecord = ({
    record,
    chunk,
    parts,
    farEligible,
    context,
  }) => {
    if (typeof record?.stableId !== 'string'
      || !Number.isFinite(record?.worldPosition?.x)
      || !Number.isFinite(record?.worldPosition?.y)
      || !Number.isFinite(record?.worldPosition?.z)
      || !Number.isInteger(record?.owningChunkCoordinate?.x)
      || !Number.isInteger(record?.owningChunkCoordinate?.z)) {
      throw new Error('canonical distant record is missing identity or ownership');
    }
    const identity = canonicalIdentity(record, chunk, parts);
    const identityKey = JSON.stringify(identity);
    const existing = context.generation.canonicalObjects.get(record.stableId);
    if (existing) {
      if (existing.identityKey !== identityKey) {
        context.stats.identityAuditErrorCount += 1;
        throw new Error(`canonical LOD identity mismatch: ${record.stableId}`);
      }
      existing.farEligible ||= farEligible;
      return { object: existing, isNew: false };
    }
    const roadEndpointHeight = point => {
      if (Number.isFinite(point?.y)) return point.y;
      try {
        return resolveCanonicalGroundSurface({
          chunkData: chunk, worldX: point.x, worldZ: point.z,
        }).heightMeters;
      } catch {
        return record.worldPosition.y;
      }
    };
    const naturalKind = naturalPresentationKind(record);
    const object = {
      stableId: record.stableId,
      settlementId: identity.settlementId,
      record,
      ...(record.featureType === 'settlement-road' ? {
        renderRoadElevation: Object.freeze({
          startY: roadEndpointHeight(record.start),
          endY: roadEndpointHeight(record.end),
        }),
      } : {}),
      identity,
      identityKey,
      ownerKey: `${record.owningChunkCoordinate.x},${record.owningChunkCoordinate.z}`,
      worldX: record.worldPosition.x,
      worldZ: record.worldPosition.z,
      destructible: record.featureType === 'settlement-building' || record.destructible === true,
      naturalKind,
      canonicalFarTreeDensityRank: naturalKind === W8_VEGETATION_LOD_KINDS.TREE
        ? (Number.isFinite(record.densityRank)
          ? clamp(record.densityRank, 0, 1)
          : resolveW8CanonicalFarTreeDensityRank(record.stableId)) : null,
      canonicalCoarseTree: context.generation.coarseFirstNatural === true
        && naturalKind === W8_VEGETATION_LOD_KINDS.TREE,
      naturalBlend: null,
      farEligible,
      visibleLod: null,
      presentationTier: null,
      localBuildingHandoff: false,
      fullPresentationOpacity: 0,
      horizonPresentationOpacity: 0,
      remotePresentationOpacity: 0,
      instances: [],
    };
    context.generation.canonicalObjects.set(record.stableId, object);
    context.generation.currentPageStableIds?.push?.(record.stableId);
    context.stats.canonicalRecordCount += 1;
    if (record.remotePresentationOnly === true) {
      // Remote silhouettes have dedicated counters below and must not inflate
      // the canonical full-detail category counts.
    } else if (record.featureType === 'settlement-building') {
      context.stats.canonicalBuildingRecordCount += 1;
    } else if (object.naturalKind === W8_VEGETATION_LOD_KINDS.TREE) {
      context.stats.canonicalVegetationRecordCount += 1;
      context.stats.canonicalTreeRecordCount += 1;
    } else if (object.naturalKind === W8_VEGETATION_LOD_KINDS.BUSH) {
      context.stats.canonicalVegetationRecordCount += 1;
      context.stats.canonicalShrubRecordCount += 1;
    } else if (object.naturalKind === W8_VEGETATION_LOD_KINDS.GRASS) {
      context.stats.canonicalVegetationRecordCount += 1;
      context.stats.canonicalGrassRecordCount += 1;
    } else if (object.naturalKind === W8_VEGETATION_LOD_KINDS.ROCK) {
      context.stats.canonicalRockRecordCount += 1;
    } else if (record.featureType === 'settlement-road') {
      context.stats.canonicalRoadRecordCount += 1;
    } else if (record.featureType === 'canonical-river') {
      context.stats.canonicalActiveRiverRecordCount += 1;
      context.stats.canonicalRiverRecordCount += 1;
      context.stats.canonicalRiverRoadCrossingCount += record.roadCrossings?.length ?? 0;
    } else if (record.objectType === 'streetLamp' || record.objectType === 'roadSign') {
      context.stats.canonicalWorldDetailRecordCount += 1;
    } else if (record.landmarkType) {
      context.stats.canonicalLandmarkRecordCount += 1;
    }
    return { object, isNew: true };
  };

  const canonicalPartMatrix = (record, part, dimensions, origin) => {
    const originMetersX = origin.renderOriginChunkX * LOGICAL_CHUNK_SIZE_METERS;
    const originMetersZ = origin.renderOriginChunkZ * LOGICAL_CHUNK_SIZE_METERS;
    const rotationY = Number.isFinite(record.rotationY) ? record.rotationY : 0;
    const offsetX = part.position[0] * dimensions.width;
    const offsetZ = part.position[2] * dimensions.depth;
    const cosine = Math.cos(rotationY); const sine = Math.sin(rotationY);
    transform.position.set(
      (record.worldPosition.x - originMetersX) * UNITS_PER_METER
        + offsetX * cosine + offsetZ * sine,
      record.worldPosition.y * UNITS_PER_METER + part.position[1] * dimensions.height,
      (record.worldPosition.z - originMetersZ) * UNITS_PER_METER
        - offsetX * sine + offsetZ * cosine,
    );
    transform.rotation.set(part.rotation[0], rotationY + part.rotation[1], part.rotation[2]);
    transform.scale.set(
      dimensions.width * part.scale[0],
      dimensions.height * part.scale[1],
      dimensions.depth * part.scale[2],
    );
    transform.updateMatrix();
    return transform.matrix;
  };

  const canonicalNaturalSilhouettePart = (record, parts, kind) => {
    if (kind === W8_VEGETATION_LOD_KINDS.TREE) {
      const geometry = record.subtype === 'conifer-tree' ? 'cone' : 'sphere';
      return parts.find(part => part.geometry === geometry)
        ?? parts.find(part => part.material !== 'treeTrunk')
        ?? parts[0]
        ?? null;
    }
    return parts[0] ?? null;
  };

  const canonicalFarTreeParts = (record, parts) => {
    const resolved = resolveW8LowPolyTreePresentationParts({
      subtype: record.subtype,
      parts,
      supportsDodeca: Boolean(visualAssets.geometries?.dodeca),
      supportsCone: Boolean(visualAssets.geometries?.cone),
    });
    const hasTrunk = resolved.some(part => part.material === 'treeTrunk'
      || /trunk/i.test(part.materialRole ?? ''));
    return hasTrunk && resolved.length >= 2 ? [...resolved] : [];
  };

  const canonicalFarTreeResourceKey = parts => {
    const signature = parts.map(part => [
      part.geometry,
      part.material,
      ...part.position,
      ...part.scale,
      ...part.rotation,
    ].join(',')).join('|');
    return `${textHash(signature).toString(16)}:${parts
      .map(part => `${part.geometry}-${part.material}`).join('+')}`;
  };

  const canonicalFarTreeMatrix = (record, dimensions, origin) => canonicalPartMatrix(
    record,
    Object.freeze({
      position: Object.freeze([0, 0, 0]),
      scale: Object.freeze([1, 1, 1]),
      rotation: Object.freeze([0, 0, 0]),
    }),
    dimensions,
    origin,
  );

  const scaledNaturalPart = (part, scale) => Object.freeze({
    ...part,
    position: part.position,
    rotation: part.rotation,
    scale: Object.freeze([
      part.scale[0] * scale,
      part.scale[1] * (0.94 + (scale - 1) * 0.35),
      part.scale[2] * scale,
    ]),
  });

  const isHorizonRecord = record => record?.lodPolicy?.presentationTiers?.includes('horizon') === true;

  const canonicalHorizonParts = (parts, quality = 'high') => {
    const body = parts.find(part => part.materialRole === 'wall') ?? parts[0] ?? null;
    const cap = parts.find(part => part !== body && part.materialRole === 'roof')
      ?? parts.find(part => part !== body && /tower|roof/i.test(part.geometry ?? ''))
      ?? parts.find(part => part !== body)
      ?? null;
    return (quality === 'high' ? [body, cap] : [body]).filter(Boolean);
  };

  const remoteHorizonSourceColor = (record, part, kind, policy) => {
    const visualColor = kind === 'building'
      ? (part.materialRole === 'wall' ? record.visual?.wallColor
        : part.materialRole === 'roof' ? record.visual?.roofColor : null)
      : null;
    const materialColor = visualAssets.materials?.[part.material]?.color;
    const source = Number.isFinite(visualColor)
      ? visualColor
      : materialColor?.isColor === true
        ? materialColor
        : policy.atmosphere.silhouetteColorHex;
    // Three r160 Color(number) converts the authored sRGB hex into its linear
    // working space. Raw byte normalization would make every remote source
    // tint too bright and diverge from canonical Building materials.
    let color = source?.isColor === true ? source : new Color(source);
    // Lightweight non-WebGL harnesses may provide a Color placeholder without
    // r/g/b fields. Keep the production r160 conversion authoritative, with
    // an exact sRGB fallback for that isolated test boundary.
    if (![color?.r, color?.g, color?.b].every(Number.isFinite)
      && Number.isFinite(source)) {
      const toLinear = component => (
        component < 0.04045
          ? component / 12.92
          : ((component + 0.055) / 1.055) ** 2.4
      );
      color = Object.freeze({
        r: toLinear(((Math.trunc(source) >>> 16) & 0xff) / 0xff),
        g: toLinear(((Math.trunc(source) >>> 8) & 0xff) / 0xff),
        b: toLinear((Math.trunc(source) & 0xff) / 0xff),
      });
    }
    if (![color.r, color.g, color.b].every(Number.isFinite)) {
      throw new Error(`remote Settlement source tint is invalid: ${record.stableId}/${part.materialRole ?? part.material}`);
    }
    return Object.freeze({ r: color.r, g: color.g, b: color.b });
  };

  const remoteHorizonRecord = ({
    source,
    candidate,
    index,
    kind,
    surfacePolicy,
  }) => {
    const center = candidate.center ?? candidate.worldPosition;
    const x = source.x ?? source.worldPosition?.x ?? center.x;
    const z = source.z ?? source.worldPosition?.z ?? center.z;
    const groundY = sampleCanonicalObjectGround(x, z, surfacePolicy);
    const landmarkType = source.landmarkType ?? null;
    const buildingType = source.buildingType ?? source.type ?? null;
    const partSetKey = landmarkType ?? buildingType;
    const owner = determineDetailCandidateOwner({ x, z });
    return Object.freeze({
      schemaVersion: 'w8-remote-settlement-horizon-record-1',
      objectType: landmarkType ?? 'building',
      stableId: source.stableId ?? `${candidate.settlementId}:remote-horizon:${kind}:${index}`,
      settlementId: candidate.settlementId,
      featureType: kind === 'landmark'
        ? 'settlement-landmark' : 'settlement-building',
      remotePresentationOnly: true,
      buildingType,
      landmarkType,
      visual: source.visual ?? null,
      settlementType: candidate.settlementType ?? null,
      townType: candidate.townType ?? null,
      worldPosition: Object.freeze({ x, y: groundY, z }),
      position: Object.freeze({ x, y: groundY, z }),
      rotationY: source.rotationY ?? 0,
      widthMeters: source.widthMeters ?? 5,
      heightMeters: source.heightMeters ?? 4,
      depthMeters: source.depthMeters ?? 5,
      owningChunkCoordinate: Object.freeze({ x: owner.x, z: owner.z }),
      lodPolicy: Object.freeze({
        schemaVersion: 'w8-remote-settlement-horizon-lod-1',
        visibilityMeters: Object.freeze({ high: Infinity, medium: Infinity, low: 0 }),
        near: null,
        outer: null,
        far: Object.freeze({ ownerSet: 'queried', presentationTier: 'remote-horizon' }),
        presentationTiers: Object.freeze(['remote-horizon']),
        proxy: true,
      }),
      presentation: Object.freeze({
        partSetKey,
        parts: Object.freeze(visualAssets.featureParts[partSetKey] ?? []),
        presentationTiers: Object.freeze(['remote-horizon']),
      }),
      sourceStableId: source.stableId ?? null,
    });
  };

  const remoteHandoffIdentity = record => JSON.stringify({
    stableId: record.stableId,
    settlementId: record.settlementId ?? record.parentSettlementId ?? null,
    buildingType: record.buildingType ?? null,
    landmarkType: record.landmarkType ?? null,
    x: record.worldPosition.x,
    y: record.worldPosition.y,
    z: record.worldPosition.z,
    rotationY: record.rotationY ?? 0,
    widthMeters: record.widthMeters ?? null,
    heightMeters: record.heightMeters ?? null,
    depthMeters: record.depthMeters ?? null,
    ownerX: record.owningChunkCoordinate.x,
    ownerZ: record.owningChunkCoordinate.z,
  });

  const registerRemoteHorizonRecord = ({ record, chunk, parts, context }) => {
    const existing = context.generation.canonicalObjects.get(record.stableId);
    if (!existing) return registerCanonicalRecord({
      record,
      chunk,
      parts,
      farEligible: true,
      context,
    });
    const existingIdentity = remoteHandoffIdentity(existing.record);
    const remoteIdentity = remoteHandoffIdentity(record);
    if (existingIdentity !== remoteIdentity) {
      context.stats.identityAuditErrorCount += 1;
      throw new Error(`canonical remote handoff identity mismatch: ${record.stableId}; ${existingIdentity} !== ${remoteIdentity}`);
    }
    existing.farEligible = true;
    return { object: existing, isNew: false };
  };

  const addRemoteSettlementHorizon = async ({ remote, origin, context, scheduler }) => {
    const { candidate, template, landmarks, radiusMeters } = remote;
    const canonicalBuildings = selectRemoteHorizonBuildings({
      template,
      quality: context.generation.quality,
      renderDistancePreset: context.generation.renderDistancePreset,
    });
    const sources = [
      ...canonicalBuildings.map(source => ({ source, kind: 'building' })),
      ...(landmarks ?? []).map(source => ({ source, kind: 'landmark' })),
    ];
    context.stats.remoteHorizonCanonicalBuildingCount += canonicalBuildings.length;
    let added = 0;
    let addedBuilding = 0;
    for (let index = 0; index < sources.length; index += 1) {
      try {
        const { source, kind } = sources[index];
        const record = remoteHorizonRecord({
          source, candidate, index, kind, surfacePolicy: context.surfacePolicy,
        });
        const parts = kind === 'building'
          ? (visualAssets.resolveBuildingParts?.(record)
            ?? visualAssets.featureParts[record.buildingType]
            ?? record.presentation.parts)
          : visualAssets.featureParts[record.landmarkType] ?? record.presentation.parts;
        const horizonParts = canonicalHorizonParts(parts ?? [], context.generation.quality);
        if (!horizonParts.length) continue;
        const syntheticChunk = {
          chunkId: `remote-horizon:${candidate.settlementId}`,
          contentHash: `remote-horizon:${candidate.settlementId}`,
          sourceW5ContentHash: null,
        };
        const registration = registerRemoteHorizonRecord({
          record,
          chunk: syntheticChunk,
          parts,
          context,
        });
        Object.assign(registration.object, {
          remoteHorizon: true,
          settlementCenterX: (candidate.center ?? candidate.worldPosition).x,
          settlementCenterZ: (candidate.center ?? candidate.worldPosition).z,
          settlementRadiusMeters: radiusMeters,
        });
        if (registration.object.instances.some(instance => (
          instance.item.visibilityTiers.includes('remote-horizon')
        ))) continue;
        const dimensions = {
          width: record.widthMeters * UNITS_PER_METER,
          height: record.heightMeters * UNITS_PER_METER,
          depth: record.depthMeters * UNITS_PER_METER,
        };
        for (const part of horizonParts) {
          addCanonicalMatrix(
            registration.object,
            part.geometry,
            '__remote-horizon__',
            kind === 'building' ? 'remote-horizon-building' : 'remote-horizon-landmark',
            canonicalPartMatrix(record, part, dimensions, origin),
            Object.freeze(['remote-horizon']),
            context,
            remoteHorizonSourceColor(
              record,
              part,
              kind,
              context.generation.settlementPresentationPolicy.remote,
            ),
          );
        }
        context.generation.remotePartBudgetRemaining -= horizonParts.length;
        if (context.generation.remotePartBudgetRemaining < 0) {
          throw new Error('remote Settlement silhouette exceeded its finite-derived part budget');
        }
        if (kind === 'building') {
          context.stats.remoteHorizonBuildingCount += 1;
          if (registration.isNew) context.stats.remoteHorizonSyntheticBuildingCount += 1;
          else context.stats.remoteHorizonMergedBuildingCount += 1;
          addedBuilding += 1;
        } else {
          context.stats.remoteHorizonLandmarkCount += 1;
          if (registration.isNew) context.stats.remoteHorizonSyntheticLandmarkCount += 1;
          else context.stats.remoteHorizonMergedLandmarkCount += 1;
        }
        added += 1;
      } finally {
        const pendingYield = scheduler.checkpoint();
        if (pendingYield) await pendingYield;
      }
    }
    context.stats.remoteHorizonMissingBuildingCount += canonicalBuildings.length - addedBuilding;
    if (added) context.stats.remoteHorizonSettlementCount += 1;
  };

  const addCanonicalRecord = ({
    record,
    chunk,
    origin,
    farEligible,
    context,
  }) => {
    if (record.featureType === 'canonical-river') {
      const registration = registerCanonicalRecord({
        record,
        chunk,
        parts: [{
          geometry: '__road__',
          material: 'water',
          position: [0, 0, 0],
          scale: [1, 1, 1],
          rotation: [-Math.PI / 2, 0, 0],
        }],
        farEligible,
        context,
      });
      if (!registration.isNew) return;
      const originMetersX = origin.renderOriginChunkX * LOGICAL_CHUNK_SIZE_METERS;
      const originMetersZ = origin.renderOriginChunkZ * LOGICAL_CHUNK_SIZE_METERS;
      for (const line of record.centerlines ?? []) {
        for (let index = 0; index < line.length - 1; index += 1) {
          const start = line[index];
          const end = line[index + 1];
          const dx = end.x - start.x;
          const dz = end.z - start.z;
          const worldX = (start.x + end.x) / 2;
          const worldZ = (start.z + end.z) / 2;
          const surfaceY = record.remoteRiverProjection
            ? (baseClipmapSample(worldX, worldZ, context.surfacePolicy).riverSurfaceHeight
              ?? baseClipmapSample(worldX, worldZ, context.surfacePolicy).baseHeight)
            : ((start.y + end.y) / 2);
          transform.position.set(
            (worldX - originMetersX) * UNITS_PER_METER,
            surfaceY * UNITS_PER_METER + 1.5,
            (worldZ - originMetersZ) * UNITS_PER_METER,
          );
          transform.rotation.set(-Math.PI / 2, 0, Math.atan2(dz, dx));
          transform.scale.set(
            (Math.hypot(dx, dz) + 0.01) * UNITS_PER_METER,
            record.widthMeters * UNITS_PER_METER,
            1,
          );
          transform.updateMatrix();
          addCanonicalMatrix(
            registration.object, '__road__', 'water', 'river', transform.matrix, undefined, context,
          );
          context.stats.canonicalActiveRiverSegmentCount += 1;
          context.stats.canonicalActiveRiverLengthMeters += Math.hypot(dx, dz);
          context.stats.canonicalRiverSegmentCount += 1;
          context.stats.canonicalRiverLengthMeters += Math.hypot(dx, dz);
        }
      }
      return;
    }
    if (record.featureType === 'settlement-road') {
      const registration = registerCanonicalRecord({
        record,
        chunk,
        parts: [{
          geometry: '__road__',
          material: 'road',
          position: [0, 0, 0],
          scale: [1, 1, 1],
          rotation: [-Math.PI / 2, 0, 0],
        }],
        farEligible,
        context,
      });
      if (!registration.isNew) return;
      const dx = record.end.x - record.start.x;
      const dz = record.end.z - record.start.z;
      const originMetersX = origin.renderOriginChunkX * LOGICAL_CHUNK_SIZE_METERS;
      const originMetersZ = origin.renderOriginChunkZ * LOGICAL_CHUNK_SIZE_METERS;
      transform.position.set(
        ((record.start.x + record.end.x) / 2 - originMetersX) * UNITS_PER_METER,
        (record.worldPosition.y + 0.075) * UNITS_PER_METER,
        ((record.start.z + record.end.z) / 2 - originMetersZ) * UNITS_PER_METER,
      );
      transform.rotation.set(-Math.PI / 2, 0, Math.atan2(dz, dx));
      transform.scale.set(
        Math.hypot(dx, dz) * UNITS_PER_METER,
        record.widthMeters * UNITS_PER_METER,
        1,
      );
      transform.updateMatrix();
      addCanonicalMatrix(
        registration.object, '__road__', 'road', 'road', transform.matrix, undefined, context,
      );
      return;
    }

    const parts = canonicalPartsFor(record);
    if (!parts?.length) {
      throw new Error(`canonical record has no finite visual parts: ${record.stableId}`);
    }
    const registration = registerCanonicalRecord({
      record,
      chunk,
      parts,
      farEligible,
      context,
    });
    if (!registration.isNew) return;
    const dimensions = {
      width: record.widthMeters * UNITS_PER_METER,
      height: record.heightMeters * UNITS_PER_METER,
      depth: record.depthMeters * UNITS_PER_METER,
    };
    if (record.featureType === 'settlement-building') {
      const civic = ['school', 'church'].includes(record.buildingType);
      for (const surface of [record.lot?.path, record.lot?.forecourt]) {
        if (!surface || !(surface.width > 0) || !(surface.depth > 0)) continue;
        const originMetersX = origin.renderOriginChunkX * LOGICAL_CHUNK_SIZE_METERS;
        const originMetersZ = origin.renderOriginChunkZ * LOGICAL_CHUNK_SIZE_METERS;
        transform.position.set(
          (surface.centerX - originMetersX) * UNITS_PER_METER,
          (record.worldPosition.y + 0.07575) * UNITS_PER_METER,
          (surface.centerZ - originMetersZ) * UNITS_PER_METER,
        );
        transform.rotation.set(-Math.PI / 2, 0, surface.rotationY);
        transform.scale.set(surface.width * UNITS_PER_METER, surface.depth * UNITS_PER_METER, 1);
        transform.updateMatrix();
        addCanonicalMatrix(
          registration.object,
          '__road__',
          civic ? 'lotCivic' : 'lotResidential',
          'lot',
          transform.matrix,
          undefined,
          context,
        );
      }
    }
    const naturalKind = registration.object.naturalKind;
    if (naturalKind) {
      const naturalPolicy = resolveW8VegetationLodPolicy(
        naturalKind,
        context.generation.renderDistancePreset,
      );
      const tree = naturalKind === W8_VEGETATION_LOD_KINDS.TREE;
      const silhouettePart = canonicalNaturalSilhouettePart(record, parts, naturalKind);
      if (tree && context.generation.coarseFirstNatural === true) {
        const coarseParts = canonicalFarTreeParts(record, parts);
        // Production authored Trees contribute canonical trunk + foliage. A
        // one-part isolated fixture remains drawable without inventing a
        // synthetic part or identity.
        if (coarseParts.length === 0 && parts.length > 0) coarseParts.push(parts[0]);
        if (coarseParts.length === 0) return;
        const resourceKey = canonicalFarTreeResourceKey(coarseParts);
        const { bucket, item } = addCanonicalMatrix(
          registration.object,
          `__canonical-low-poly-tree__:${resourceKey}`,
          `__canonical-low-poly-tree__:${resourceKey}`,
          'natural-forest-tree',
          canonicalFarTreeMatrix(record, dimensions, origin),
          Object.freeze(['natural-lod']),
          context,
        );
        bucket.canonicalFarTreeParts ??= Object.freeze(coarseParts);
        bucket.canonicalCoarseTreeTier = 'all-distance';
        const canonicalRank = registration.object.canonicalFarTreeDensityRank;
        item.canonicalFarTreeDensityRank = canonicalRank;
        registration.object.canonicalCoarseTreeDensityRank = canonicalRank;
        return;
      }
      if (!tree && context.generation.coarseFirstNatural === true) {
        // Direct Macro Natural may carry only real canonical Rock records.
        // Bush is Near-only ambient decoration; synthetic Far identities remain
        // forbidden for every Natural kind.
        const canonicalCoarseKind = naturalKind === W8_VEGETATION_LOD_KINDS.ROCK
          && record.coarsePresenceKind === 'canonical-rock'
          ? 'canonical-rock'
          : null;
        if (!canonicalCoarseKind) return;
        const coarseParts = silhouettePart
          ? [scaledNaturalPart(silhouettePart, naturalPolicy.atmosphericScale)]
          : [];
        if (coarseParts.length === 0) return;
        for (const part of coarseParts) {
          addCanonicalMatrix(
            registration.object,
            part.geometry,
            naturalKind === W8_VEGETATION_LOD_KINDS.ROCK
              ? part.material : SHARED_NATURAL_SILHOUETTE_MATERIAL,
            `natural-atmospheric-${naturalKind}`,
            canonicalPartMatrix(record, part, dimensions, origin),
            Object.freeze(['natural-lod']),
            context,
          );
        }
        registration.object.canonicalCoarseNatural = true;
        registration.object.canonicalCoarseNaturalKind = canonicalCoarseKind;
        return;
      }
      for (const part of parts) {
        addCanonicalMatrix(
          registration.object,
          part.geometry,
          part.material,
          `natural-full-${naturalKind}`,
          canonicalPartMatrix(record, part, dimensions, origin),
          Object.freeze(['natural-lod']),
          context,
        );
      }
      if (silhouettePart && naturalPolicy.forestToAtmospheric) {
        addCanonicalMatrix(
          registration.object,
          silhouettePart.geometry,
          naturalKind === W8_VEGETATION_LOD_KINDS.ROCK || tree
            ? silhouettePart.material : SHARED_NATURAL_SILHOUETTE_MATERIAL,
          `natural-forest-${naturalKind}`,
          canonicalPartMatrix(
            record,
            scaledNaturalPart(silhouettePart, naturalPolicy.forestScale),
            dimensions,
            origin,
          ),
          Object.freeze(['natural-lod']),
          context,
        );
      }
      if (silhouettePart) {
        addCanonicalMatrix(
          registration.object,
          silhouettePart.geometry,
          naturalKind === W8_VEGETATION_LOD_KINDS.ROCK || tree
            ? silhouettePart.material : SHARED_NATURAL_SILHOUETTE_MATERIAL,
          `natural-atmospheric-${naturalKind}`,
          canonicalPartMatrix(
            record,
            scaledNaturalPart(silhouettePart, naturalPolicy.atmosphericScale),
            dimensions,
            origin,
          ),
          Object.freeze(['natural-lod']),
          context,
        );
      }
      if (tree && naturalPolicy.farEntry) {
        const densityRank = registration.object.canonicalFarTreeDensityRank;
        if (densityRank < naturalPolicy.farDensity.innerDensity) {
          const farParts = canonicalFarTreeParts(record, parts);
          if (farParts.length !== 2) return;
          const resourceKey = canonicalFarTreeResourceKey(farParts);
          const { bucket, item } = addCanonicalMatrix(
            registration.object,
            `__canonical-far-tree__:${resourceKey}`,
            `__canonical-far-tree__:${resourceKey}`,
            'natural-far-tree',
            canonicalFarTreeMatrix(record, dimensions, origin),
            Object.freeze(['natural-lod']),
            context,
          );
          bucket.canonicalFarTreeParts ??= Object.freeze(farParts);
          item.canonicalFarTreeDensityRank = densityRank;
        }
      }
      return;
    }
    for (const part of parts) {
      addCanonicalMatrix(
        registration.object,
        part.geometry,
        part.material,
        record.landmarkType ? 'landmark' : 'building',
        canonicalPartMatrix(record, part, dimensions, origin),
        undefined,
        context,
      );
    }
    if (isHorizonRecord(record)) {
      const horizonBucket = record.featureType === 'settlement-building'
        ? 'horizon-building' : 'horizon-landmark';
      for (const part of canonicalHorizonParts(parts, context.generation.quality)) {
        addCanonicalMatrix(
          registration.object,
          part.geometry,
          '__horizon__',
          horizonBucket,
          canonicalPartMatrix(record, part, dimensions, origin),
          Object.freeze(['horizon']),
          context,
        );
      }
    }
  };

  const addCanonicalChunk = async ({
    chunk,
    origin,
    farEligibleSettlementIds = null,
    farEligibleRoadSettlementIds = null,
    coveredSettlementIds = null,
    coveredRoadSettlementIds = null,
    includeNatural = false,
    farNaturalEligible = false,
    includeNearDetails = false,
    includeRoadRecords = true,
    includeNonRoadRecords = true,
    queryCenter = null,
    naturalQueryCenter = null,
    queryRadius = Infinity,
    roadQueryRadius = queryRadius,
    naturalQueryRadius = Infinity,
    naturalDetailQueryRadius = Infinity,
    naturalKindFilter = null,
    context,
    scheduler,
  }) => {
    const presentationResource = presentationOwnerResourceOf(chunk);
    const layers = chunk.presentationLayers;
    if (includeNatural && context.generation.excludeNatural !== true) {
      const candidates = resolveW8CanonicalCandidateSet(chunk);
      for (const candidate of candidates.vegetation) {
        try {
          if (naturalQueryCenter && Math.hypot(
            candidate.worldPosition.x - naturalQueryCenter.x,
            candidate.worldPosition.z - naturalQueryCenter.z,
          ) > naturalQueryRadius) continue;
          const canonical = resolveW8CanonicalWorldObject(candidate);
          const candidateKind = naturalPresentationKind(canonical);
          // Bush is a Near-only ambient decoration. Formal shrub proposals,
          // including stale/legacy data, must never enter Distant Natural.
          if (candidateKind === W8_VEGETATION_LOD_KINDS.BUSH) continue;
          if (naturalKindFilter && !naturalKindFilter.has(candidateKind)) continue;
          if (context.generation.excludeTreeNatural === true
            && candidateKind === W8_VEGETATION_LOD_KINDS.TREE) continue;
          if (context.generation.treeOnly === true
            && context.generation.naturalOnly !== true
            && candidateKind !== W8_VEGETATION_LOD_KINDS.TREE) continue;
          const canonicalGroundY = chunk.canonicalSurfacePolicy && !presentationResource
            ? resolveCanonicalGroundSurface({
              chunkData: chunk, worldX: canonical.position.x, worldZ: canonical.position.z,
            }).heightMeters : canonical.position.y;
          addCanonicalRecord({
            record: Object.freeze({
              ...canonical,
              ...(Number.isFinite(candidate.densityRank) ? {
                densityRank: clamp(candidate.densityRank, 0, 1),
              } : {}),
              worldPosition: Object.freeze({
                ...canonical.worldPosition,
                y: canonicalGroundY,
              }),
              position: Object.freeze({
                ...canonical.position,
                y: canonicalGroundY,
              }),
            }),
            chunk,
            origin,
            farEligible: farNaturalEligible,
            context,
          });
        } finally {
          const pendingYield = scheduler.checkpoint();
          if (pendingYield) await pendingYield;
        }
      }
      for (const candidate of (context.generation.treeOnly === true
        && context.generation.naturalOnly !== true)
        ? [] : candidates.rocks) {
        try {
          if (naturalKindFilter
            && !naturalKindFilter.has(W8_VEGETATION_LOD_KINDS.ROCK)) continue;
          const sourceRecord = resolveW8RockCanonicalObject(candidate);
          const groundY = chunk.canonicalSurfacePolicy && !presentationResource ? resolveCanonicalGroundSurface({
            chunkData: chunk, worldX: sourceRecord.worldPosition.x, worldZ: sourceRecord.worldPosition.z,
          }).heightMeters : sourceRecord.worldPosition.y;
          const record = Object.freeze({
            ...sourceRecord,
            worldPosition: Object.freeze({ ...sourceRecord.worldPosition, y: groundY }),
            position: Object.freeze({ ...sourceRecord.position, y: groundY }),
          });
          const rockVisibilityMeters = resolveW8RockVisibilityMeters(
            record,
            context.generation.renderDistancePreset,
          );
          if (naturalQueryCenter && Math.hypot(
            candidate.worldPosition.x - naturalQueryCenter.x,
            candidate.worldPosition.z - naturalQueryCenter.z,
          ) > Math.min(naturalDetailQueryRadius, rockVisibilityMeters)) continue;
          addCanonicalRecord({
            record,
            chunk,
            origin,
            farEligible: farNaturalEligible,
            context,
          });
        } finally {
          const pendingYield = scheduler.checkpoint();
          if (pendingYield) await pendingYield;
        }
      }
      for (const detail of (context.generation.treeOnly === true
        && context.generation.naturalOnly !== true)
        ? [] : (layers?.ambientDetails ?? chunk.ambientDetails ?? [])) {
        try {
          if (detail.detailType !== 'grass') continue;
          const record = resolveW8CanonicalWorldObject(detail);
          const naturalKind = naturalPresentationKind(record);
          if (naturalKindFilter && !naturalKindFilter.has(naturalKind)) continue;
          const visibilityMeters = resolveW8VegetationLodPolicy(
            naturalKind,
            context.generation.renderDistancePreset,
          ).visibilityMeters;
          if (naturalQueryCenter && Math.hypot(
            record.worldPosition.x - naturalQueryCenter.x,
            record.worldPosition.z - naturalQueryCenter.z,
          ) > Math.min(naturalQueryRadius, visibilityMeters)) continue;
          addCanonicalRecord({
            record,
            chunk,
            origin,
            farEligible: farNaturalEligible,
            context,
          });
        } finally {
          const pendingYield = scheduler.checkpoint();
          if (pendingYield) await pendingYield;
        }
      }
    }
    if (context.generation.treeOnly === true || context.generation.naturalOnly === true) return;
    if (includeNonRoadRecords && includeNearDetails) {
      for (const detail of presentationResource?.street?.map(
        expandPresentationAuxiliaryRecord,
      ) ?? layers?.streetDetails ?? chunk.streetDetails ?? []) {
        try {
          if (!['streetLamp', 'roadSign'].includes(detail.detailType)) continue;
          addCanonicalRecord({
            record: resolveW8CanonicalWorldObject(detail),
            chunk,
            origin,
            farEligible: false,
            context,
          });
        } finally {
          const pendingYield = scheduler.checkpoint();
          if (pendingYield) await pendingYield;
        }
      }
    }
    if (includeNonRoadRecords
      && context.generation.activeKeys.has(`${chunk.chunkX},${chunk.chunkZ}`)) {
      for (const surface of layers?.water ?? chunk.waterSurfaces ?? []) {
        try {
          if (surface.waterType !== 'river') continue;
          // Active Chunk River is owned exclusively by Near/Outer presentation.
          // The staged Far projection is the only representation allowed after
          // this owner leaves the active set, avoiding a duplicate during the
          // delayed Far-root replacement.
          addCanonicalRecord({ record: surface, chunk, origin, farEligible: false, context });
        } finally {
          const pendingYield = scheduler.checkpoint();
          if (pendingYield) await pendingYield;
        }
      }
    }
    const records = [
      ...(presentationResource?.structures ?? []).map(expandPresentationStructureRecord),
      ...(presentationResource?.landmarks ?? []).map(expandPresentationAuxiliaryRecord),
      ...(layers?.formal?.roadsAndBuildings ?? chunk.settlementFeatures ?? []),
      ...(layers?.landmarks ?? chunk.settlementLandmarks ?? []),
    ];
    for (const sourceRecord of records) {
      try {
        const record = sourceRecord.featureType === 'settlement-road'
          ? sourceRecord : resolveW8CanonicalWorldObject(sourceRecord);
        const settlementId = record.settlementId ?? record.parentSettlementId;
        const road = record.featureType === 'settlement-road';
        if ((road && !includeRoadRecords) || (!road && !includeNonRoadRecords)) continue;
        const recordFarEligibleSettlementIds = road
          ? (farEligibleRoadSettlementIds ?? farEligibleSettlementIds)
          : farEligibleSettlementIds;
        const recordCoveredSettlementIds = road
          ? (coveredRoadSettlementIds ?? coveredSettlementIds)
          : coveredSettlementIds;
        const canonicalMajorRoad = record.canonicalMajorRoad === true;
        const coarsePresentationOwner = context.generation.coarseFirstNatural === true;
        const queriedOwner = coarsePresentationOwner || canonicalMajorRoad
          || recordFarEligibleSettlementIds?.has(settlementId) === true;
        const farEligible = coarsePresentationOwner || canonicalMajorRoad
          || queriedOwner || recordCoveredSettlementIds?.has(settlementId) === true;
        if (recordFarEligibleSettlementIds && !queriedOwner) continue;
        if (queryCenter && Math.hypot(
          record.worldPosition.x - queryCenter.x,
          record.worldPosition.z - queryCenter.z,
        ) > (road ? roadQueryRadius : queryRadius)) continue;
        addCanonicalRecord({ record, chunk, origin, farEligible, context });
      } finally {
        const pendingYield = scheduler.checkpoint();
        if (pendingYield) await pendingYield;
      }
    }
  };

  const configureLocalHandoffMaterial = (material, mode) => {
    const sourceTransparent = material.transparent === true;
    const sourceOpacity = Number.isFinite(material.opacity) ? material.opacity : 1;
    if (sourceTransparent) {
      material.transparent = true;
      material.alphaHash = false;
    } else {
      material.transparent = false;
      material.alphaHash = true;
      material.depthWrite = true;
    }
    material.opacity = sourceOpacity;
    material.userData = {
      ...(material.userData ?? {}),
      localBuildingHandoff: true,
      localBuildingHandoffMode: 'instance-opacity-shader',
      localBuildingHandoffTier: mode,
    };
    const previousOnBeforeCompile = material.onBeforeCompile;
    const previousProgramCacheKey = material.customProgramCacheKey?.bind(material);
    material.onBeforeCompile = shader => {
      previousOnBeforeCompile?.call(material, shader);
      const vertexAnchor = '#include <begin_vertex>';
      const fragmentColor = '#include <color_fragment>';
      if (!shader.vertexShader.includes(vertexAnchor)
        || !shader.fragmentShader.includes(fragmentColor)) {
        throw new Error('local Building handoff shader chunks are unavailable');
      }
      shader.vertexShader = [
        'attribute float w8LocalHandoffOpacity;',
        'varying float vW8LocalHandoffOpacity;',
        shader.vertexShader,
      ].join('\n').replace(
        vertexAnchor,
        `${vertexAnchor}\nvW8LocalHandoffOpacity = w8LocalHandoffOpacity;`,
      );
      shader.fragmentShader = [
        'varying float vW8LocalHandoffOpacity;',
        shader.fragmentShader,
      ].join('\n').replace(
        fragmentColor,
        `${fragmentColor}\ndiffuseColor.a *= vW8LocalHandoffOpacity;`,
      );
    };
    material.customProgramCacheKey = () => [
      previousProgramCacheKey?.() ?? '',
      `w8-local-building-handoff-${mode}-v1`,
    ].join(':');
    return material;
  };

  const parseNaturalLodBucket = bucket => {
    const match = /^natural-(full|forest|atmospheric|far)-(tree|bush|grass|rock)$/
      .exec(bucket?.name ?? '');
    if (!match) return null;
    return Object.freeze({ mode: match[1], kind: match[2] });
  };

  const resolvePersistentNaturalBucketCapacity = ({
    generation,
    bucket,
    requiredSlots = 0,
  }) => {
    const naturalLod = parseNaturalLodBucket(bucket);
    if (!naturalLod) {
      throw new Error(`persistent Natural bucket is not a Natural LOD bucket: ${bucket?.name}`);
    }
    const coverage = generation?.naturalCapacityByKind?.get?.(naturalLod.kind) ?? null;
    if (!coverage) {
      // Compatibility for isolated presentation tests and the legacy Tree
      // adapter. Production Static Natural plans always supply policy coverage.
      return Math.max(PERSISTENT_DISTANT_BUCKET_CAPACITY, requiredSlots);
    }
    try {
      return resolveW8PersistentNaturalBucketCapacity({
        kind: naturalLod.kind,
        mode: naturalLod.mode,
        maximumCanonicalOwnerCount: coverage.maximumCanonicalOwnerCount,
        maximumManifestOwnerCount: coverage.maximumManifestOwnerCount,
        requiredSlots,
      });
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      throw new RangeError([
        `persistent Natural bucket capacity exceeded: ${bucket.geometry}:${bucket.material}:${bucket.name}`,
        error.message,
      ].join(' '), { cause: error });
    }
  };

  const resolvePersistentPresentationBucketCapacity = ({
    generation,
    bucket,
    requiredSlots = 0,
  }) => parseNaturalLodBucket(bucket)
    ? resolvePersistentNaturalBucketCapacity({ generation, bucket, requiredSlots })
    : Math.max(PERSISTENT_DISTANT_BUCKET_CAPACITY, requiredSlots);

  const isPersistentDistantBucketName = name => (
    /^natural-(full|forest|atmospheric|far)-(tree|bush|grass|rock)$/.test(name ?? '')
    || [
      'building',
      'horizon-building',
      'horizon-landmark',
      'remote-horizon-building',
      'remote-horizon-landmark',
    ].includes(name)
  );

  const treePathIdForBucket = (bucket, generation) => {
    const naturalLod = parseNaturalLodBucket(bucket);
    if (naturalLod?.kind !== W8_VEGETATION_LOD_KINDS.TREE) return null;
    if (naturalLod.mode === 'atmospheric') return TREE_RENDER_PATH.ULTRA;
    return generation?.persistentTree === true
      ? TREE_RENDER_PATH.STATIC : TREE_RENDER_PATH.LEGACY;
  };

  const treePathIdsForGeneration = (generation, { visibleOnly = false } = {}) => {
    const result = new Set();
    for (const bucket of generation?.canonicalBuckets?.values?.() ?? []) {
      const pathId = bucket.mesh?.userData?.treePathId
        ?? treePathIdForBucket(bucket, generation);
      if (!pathId) continue;
      if (visibleOnly && (generation.root?.visible === false
        || bucket.mesh?.visible === false || !(bucket.mesh?.count > 0))) continue;
      result.add(pathId);
    }
    return result;
  };

  const createNaturalLodMaterial = ({
    mode, kind, sourceMaterial, materialKey, context,
  }) => {
    const coarseTree = mode === 'forest'
      && kind === W8_VEGETATION_LOD_KINDS.TREE
      && context.generation.coarseFirstNatural === true;
    const coarseNaturalPresence = mode === 'atmospheric'
      && kind !== W8_VEGETATION_LOD_KINDS.TREE
      && context.generation.coarseFirstNatural === true;
    const sourceTinted = mode === 'full'
      || kind === W8_VEGETATION_LOD_KINDS.ROCK
      || kind === W8_VEGETATION_LOD_KINDS.TREE;
    const cacheKey = sourceTinted
      ? `${mode}:${kind}:${materialKey}` : `${mode}:${kind}`;
    const cached = context.generation.naturalLodMaterials.get(cacheKey);
    if (cached) return cached;
    let material;
    if (sourceTinted) {
      material = sourceMaterial?.clone?.();
      if (!material || material === sourceMaterial) {
        throw new Error('Natural LOD source-tinted tier requires a cloned shared material');
      }
    } else {
      material = new Material({
        color: mode === 'forest'
          ? W8_FOREST_SILHOUETTE_COLOR_HEX
          : W8_ATMOSPHERIC_VEGETATION_COLOR_HEX,
        flatShading: true,
        shininess: 0,
        fog: mode !== 'atmospheric' && mode !== 'far',
      });
    }
    const policy = resolveW8VegetationLodPolicy(
      kind,
      context.generation.renderDistancePreset,
    );
    const enter = coarseTree
      ? null
      : coarseNaturalPresence
        // Canonical coarse Rock uses the same world identity as its
        // Near records. Keep them visible all the way inward until the Near
        // renderer reports an actual completed drawable receipt; distance
        // alone must never create a blank handoff band.
        ? null
        : mode === 'far'
        ? policy.farEntry
        : mode === 'forest'
        ? policy.fullToForest
        : mode === 'atmospheric'
          ? (policy.forestToAtmospheric ?? policy.fullToForest)
          : null;
    const exit = coarseTree
      ? Object.freeze({
        minimum: PRESENTATION_OWNER_COARSE_VISIBILITY_METERS
          - PRESENTATION_OWNER_COARSE_FADE_METERS,
        maximum: PRESENTATION_OWNER_COARSE_VISIBILITY_METERS,
      })
      : coarseNaturalPresence
        ? policy.coarsePresenceFade
        : mode === 'far'
        ? policy.farFade
        : mode === 'full'
        ? policy.fullToForest
        : mode === 'forest' ? policy.forestToAtmospheric : policy.atmosphericFade;
    if (!exit) throw new Error(`Natural LOD ${kind}/${mode} has no exit policy`);
    const visibilityMeters = coarseTree
      ? PRESENTATION_OWNER_COARSE_VISIBILITY_METERS : policy.visibilityMeters;
    const uniforms = {
      w8NaturalPlayerLocalXZ: { value: { x: 0, y: 0 } },
      w8NaturalUnitsPerMeter: { value: UNITS_PER_METER },
      w8NaturalEnterStart: { value: enter?.minimum ?? -1 },
      w8NaturalEnterEnd: { value: enter?.maximum ?? 0 },
      w8NaturalExitStart: { value: exit.minimum },
      w8NaturalExitEnd: { value: exit.maximum },
      w8NaturalFogColor: { value: new Color(W8_RENDER_FOG_COLOR_HEX) },
      w8NaturalFogBlendStart: {
        value: coarseNaturalPresence
          ? policy.coarsePresenceFogStartMeters
          : coarseTree || mode === 'far'
            ? policy.farEntry.minimum
            : policy.forestToAtmospheric?.minimum ?? policy.fullToForest.minimum,
      },
      w8NaturalFogStrength: { value: coarseNaturalPresence ? 0.56 : 0.88 },
      w8NaturalVisibility: { value: visibilityMeters },
      w8NaturalReveal: { value: context.generation.naturalReveal },
      w8NaturalTimeMs: { value: monotonicNow() },
    };
    material.transparent = false;
    material.alphaHash = true;
    material.depthWrite = true;
    material.fog = !coarseTree && mode !== 'atmospheric' && mode !== 'far';
    material.opacity = Number.isFinite(material.opacity) ? material.opacity : 1;
    material.userData = {
      ...(material.userData ?? {}),
      naturalLod: true,
      naturalLodMode: mode,
      naturalLodKind: kind,
      naturalLodSourceTinted: sourceTinted,
      naturalLodDistanceSource: 'instance-anchor',
      canonicalCoarseTree: coarseTree,
      canonicalCoarseNaturalPresence: coarseNaturalPresence,
      canonicalCoarseNaturalInnerContinuity: coarseNaturalPresence,
      naturalLodUniforms: uniforms,
    };
    const previousOnBeforeCompile = material.onBeforeCompile;
    const previousProgramCacheKey = material.customProgramCacheKey?.bind(material);
    material.onBeforeCompile = shader => {
      previousOnBeforeCompile?.call(material, shader);
      Object.assign(shader.uniforms, uniforms);
      const vertexAnchor = '#include <begin_vertex>';
      const fragmentColor = '#include <color_fragment>';
      if (!shader.vertexShader.includes(vertexAnchor)
        || !shader.fragmentShader.includes(fragmentColor)) {
        throw new Error('Vegetation LOD shader chunks are unavailable');
      }
      shader.vertexShader = [
        'uniform vec2 w8NaturalPlayerLocalXZ;',
        'uniform float w8NaturalUnitsPerMeter;',
        'attribute vec2 w8NaturalAnchorXZ;',
        'attribute float w8NaturalInitialReveal;',
        'varying float vW8NaturalDistanceMeters;',
        'varying float vW8NaturalInitialReveal;',
        shader.vertexShader,
      ].join('\n').replace(
        vertexAnchor,
        [
          vertexAnchor,
          'vW8NaturalDistanceMeters = length(w8NaturalAnchorXZ - w8NaturalPlayerLocalXZ) / w8NaturalUnitsPerMeter;',
          'vW8NaturalInitialReveal = w8NaturalInitialReveal;',
        ].join('\n'),
      );
      const entryExpression = mode === 'full' || coarseTree
        ? '1.0'
        : 'smoothstep(w8NaturalEnterStart, w8NaturalEnterEnd, vW8NaturalDistanceMeters)';
      shader.fragmentShader = [
        'uniform float w8NaturalEnterStart;',
        'uniform float w8NaturalEnterEnd;',
        'uniform float w8NaturalExitStart;',
        'uniform float w8NaturalExitEnd;',
        'uniform vec3 w8NaturalFogColor;',
        'uniform float w8NaturalFogBlendStart;',
        'uniform float w8NaturalFogStrength;',
        'uniform float w8NaturalVisibility;',
        'uniform float w8NaturalReveal;',
        'uniform float w8NaturalTimeMs;',
        'varying float vW8NaturalDistanceMeters;',
        'varying float vW8NaturalInitialReveal;',
        shader.fragmentShader,
      ].join('\n').replace(fragmentColor, [
        fragmentColor,
        `float w8NaturalEntry = ${entryExpression};`,
        'float w8NaturalExit = 1.0 - smoothstep(w8NaturalExitStart, w8NaturalExitEnd, vW8NaturalDistanceMeters);',
        'float w8NaturalStreamReveal = max(clamp(vW8NaturalInitialReveal, 0.0, 1.0), w8NaturalReveal);',
        'float w8NaturalHandoffEnabled = step(-0.5, vW8NaturalInitialReveal);',
        'diffuseColor.a *= w8NaturalEntry * w8NaturalExit * w8NaturalStreamReveal * w8NaturalHandoffEnabled;',
        ...(coarseTree || ['atmospheric', 'far'].includes(mode) ? [
          'float w8NaturalFogBlend = w8NaturalFogStrength * smoothstep(w8NaturalFogBlendStart, w8NaturalVisibility, vW8NaturalDistanceMeters);',
          'diffuseColor.rgb = mix(diffuseColor.rgb, w8NaturalFogColor, w8NaturalFogBlend);',
        ] : []),
      ].join('\n'));
    };
    material.customProgramCacheKey = () => [
      previousProgramCacheKey?.() ?? '',
      `w8-natural-lod-${kind}-${mode}-${coarseTree ? 'all-distance-low-poly'
        : coarseNaturalPresence ? 'coarse-presence' : 'tiered'}-v12`,
    ].join(':');
    context.generation.naturalLodMaterials.set(cacheKey, material);
    context.generation.ownedMaterials.add(material);
    return material;
  };

  const createHorizonSilhouetteMaterial = ({ handoff = false } = {}) => {
    const material = new Material({
      color: W8_SETTLEMENT_SILHOUETTE_COLOR_HEX,
      flatShading: true,
      shininess: 0,
    });
    return handoff ? configureLocalHandoffMaterial(material, 'horizon') : material;
  };

  const createRemoteHorizonSilhouetteMaterial = policy => {
    const uniforms = {
      w8RemotePlayerLocalXZ: { value: { x: 0, y: 0 } },
      w8RemoteFadeStart: { value: policy.fadeStartMeters },
      w8RemoteFogEnd: { value: policy.atmosphere.fogIntegrationEndMeters },
      w8RemoteFadeEnd: { value: policy.fadeEndMeters },
      w8RemoteHidden: { value: policy.hiddenDistanceMeters },
      w8RemoteFogEdgeBlend: { value: policy.atmosphere.fogEdgeBlend },
      w8RemoteFogEdgeOpacity: { value: policy.atmosphere.fogEdgeOpacity },
      w8RemoteMaximumFogBlend: { value: policy.atmosphere.maximumFogBlend },
      w8RemoteFogColor: {
        value: new Color(policy.atmosphere.fogColorHex),
      },
      w8RemoteUnitsPerMeter: { value: UNITS_PER_METER },
    };
    const material = new Material({
      color: 0xffffff,
      flatShading: true,
      shininess: 0,
      fog: false,
      transparent: false,
      alphaHash: true,
      opacity: 1,
      depthWrite: true,
    });
    material.userData = {
      ...(material.userData ?? {}),
      remoteBuildingAtmosphere: true,
      remoteBuildingAtmosphereMode: 'instance-anchor-shader',
      remoteAtmosphereUniforms: uniforms,
    };
    material.onBeforeCompile = shader => {
      Object.assign(shader.uniforms, uniforms);
      const vertexAnchor = '#include <begin_vertex>';
      const fragmentColor = '#include <color_fragment>';
      if (!shader.vertexShader.includes(vertexAnchor)
        || !shader.fragmentShader.includes(fragmentColor)) {
        throw new Error('remote Settlement atmosphere shader chunks are unavailable');
      }
      shader.vertexShader = [
        'uniform vec2 w8RemotePlayerLocalXZ;',
        'uniform float w8RemoteUnitsPerMeter;',
        'attribute vec2 w8RemoteAnchorXZ;',
        'attribute vec3 w8RemoteSourceColor;',
        'varying float vW8RemoteDistanceMeters;',
        'varying vec3 vW8RemoteSourceColor;',
        shader.vertexShader,
      ].join('\n').replace(
        vertexAnchor,
        `${vertexAnchor}\nvW8RemoteDistanceMeters = length(w8RemoteAnchorXZ - w8RemotePlayerLocalXZ) / w8RemoteUnitsPerMeter;\nvW8RemoteSourceColor = w8RemoteSourceColor;`,
      );
      shader.fragmentShader = [
        'uniform float w8RemoteFadeStart;',
        'uniform float w8RemoteFogEnd;',
        'uniform float w8RemoteFadeEnd;',
        'uniform float w8RemoteHidden;',
        'uniform float w8RemoteFogEdgeBlend;',
        'uniform float w8RemoteFogEdgeOpacity;',
        'uniform float w8RemoteMaximumFogBlend;',
        'uniform vec3 w8RemoteFogColor;',
        'varying float vW8RemoteDistanceMeters;',
        'varying vec3 vW8RemoteSourceColor;',
        shader.fragmentShader,
      ].join('\n').replace(fragmentColor, [
        fragmentColor,
        'float w8RemoteFogProgress = smoothstep(w8RemoteFadeStart, w8RemoteFogEnd, vW8RemoteDistanceMeters);',
        'float w8RemoteHorizonProgress = smoothstep(w8RemoteFogEnd, w8RemoteFadeEnd, vW8RemoteDistanceMeters);',
        'float w8RemoteFogBlend = w8RemoteFogEdgeBlend * w8RemoteFogProgress;',
        'float w8RemoteOpacity = 1.0 - (1.0 - w8RemoteFogEdgeOpacity) * w8RemoteFogProgress;',
        'if (vW8RemoteDistanceMeters > w8RemoteFogEnd) {',
        '  w8RemoteFogBlend = mix(w8RemoteFogEdgeBlend, w8RemoteMaximumFogBlend, w8RemoteHorizonProgress);',
        '  w8RemoteOpacity = w8RemoteFogEdgeOpacity * (1.0 - w8RemoteHorizonProgress);',
        '}',
        'if (vW8RemoteDistanceMeters >= w8RemoteHidden) w8RemoteOpacity = 0.0;',
        'diffuseColor.rgb = mix(vW8RemoteSourceColor, w8RemoteFogColor, w8RemoteFogBlend);',
        'diffuseColor.a *= w8RemoteOpacity;',
      ].join('\n'));
    };
    material.customProgramCacheKey = () => 'w8-remote-building-atmosphere-v2';
    return material;
  };

  const createRemoteHorizonGeometry = (sourceGeometry, bucket, context) => {
    const InstancedBufferAttribute = THREE.InstancedBufferAttribute;
    const geometry = sourceGeometry?.clone?.();
    if (!geometry || geometry === sourceGeometry
      || typeof geometry.setAttribute !== 'function'
      || typeof InstancedBufferAttribute !== 'function') {
      throw new Error('remote Settlement atmosphere requires cloned instanced geometry');
    }
    const anchorAttribute = new InstancedBufferAttribute(
      new Float32Array((bucket.capacity ?? bucket.items.length) * 2),
      2,
    );
    const sourceColorAttribute = new InstancedBufferAttribute(
      new Float32Array((bucket.capacity ?? bucket.items.length) * 3),
      3,
    );
    geometry.setAttribute('w8RemoteAnchorXZ', anchorAttribute);
    geometry.setAttribute('w8RemoteSourceColor', sourceColorAttribute);
    bucket.remoteAnchorAttribute = anchorAttribute;
    bucket.remoteSourceColorAttribute = sourceColorAttribute;
    context.generation.ownedGeometries.add(geometry);
    return geometry;
  };

  const createLocalHandoffGeometry = (sourceGeometry, bucket, context) => {
    const InstancedBufferAttribute = THREE.InstancedBufferAttribute;
    const geometry = sourceGeometry?.clone?.();
    if (!geometry || geometry === sourceGeometry
      || typeof geometry.setAttribute !== 'function'
      || typeof InstancedBufferAttribute !== 'function') {
      throw new Error('local Building handoff requires cloned instanced geometry');
    }
    const opacityAttribute = new InstancedBufferAttribute(
      new Float32Array(bucket.capacity ?? bucket.items.length),
      1,
    );
    geometry.setAttribute('w8LocalHandoffOpacity', opacityAttribute);
    bucket.localHandoffOpacityAttribute = opacityAttribute;
    context.generation.ownedGeometries.add(geometry);
    return geometry;
  };

  const createNaturalLodGeometry = (sourceGeometry, bucket, context) => {
    const InstancedBufferAttribute = THREE.InstancedBufferAttribute;
    const canonicalFarTree = sourceGeometry?.userData?.canonicalFarTreeCombined === true;
    const geometry = canonicalFarTree ? sourceGeometry : sourceGeometry?.clone?.();
    if (!geometry || (!canonicalFarTree && geometry === sourceGeometry)
      || typeof geometry.setAttribute !== 'function'
      || typeof InstancedBufferAttribute !== 'function') {
      throw new Error('Vegetation LOD requires cloned instanced geometry');
    }
    const anchorAttribute = new InstancedBufferAttribute(
      new Float32Array((bucket.capacity ?? bucket.items.length) * 2),
      2,
    );
    const initialRevealAttribute = new InstancedBufferAttribute(
      new Float32Array(bucket.capacity ?? bucket.items.length),
      1,
    );
    geometry.setAttribute('w8NaturalAnchorXZ', anchorAttribute);
    geometry.setAttribute('w8NaturalInitialReveal', initialRevealAttribute);
    bucket.naturalAnchorAttribute = anchorAttribute;
    bucket.naturalInitialRevealAttribute = initialRevealAttribute;
    context.generation.ownedGeometries.add(geometry);
    return geometry;
  };

  const localFullHandoffMaterial = (sourceMaterial, context) => {
    const cached = context.generation.localFullHandoffMaterials.get(sourceMaterial);
    if (cached) return cached;
    const material = sourceMaterial?.clone?.();
    if (!material || material === sourceMaterial) {
      throw new Error('local Building handoff requires a cloned source material');
    }
    configureLocalHandoffMaterial(material, 'full');
    context.generation.localFullHandoffMaterials.set(sourceMaterial, material);
    context.generation.ownedMaterials.add(material);
    return material;
  };

  const isSettlementRoadBucket = bucket => bucket?.geometry === '__road__'
    && bucket.material === 'road' && bucket.name === 'road';

  const isSettlementRoadEntry = entry => isSettlementRoadBucket(entry?.bucket);

  const settlementRoadEntryForGeneration = generation => {
    const entries = [...directCanonicalMeshEntries(generation).entries()]
      .filter(([, entry]) => isSettlementRoadEntry(entry));
    if (entries.length > 1) {
      throw new Error(`Distant Road presentation produced ${entries.length} Road buckets`);
    }
    return entries[0] ?? null;
  };

  const pendingPublicationWorkIsRoad = work => {
    if (!work) return false;
    const live = liveDistantEntries.get(work.key) ?? null;
    const desiredBucket = work.type === 'bucket'
      ? work.desired : work.desired?.bucket;
    return isSettlementRoadBucket(desiredBucket)
      || isSettlementRoadBucket(work.live?.bucket)
      || isSettlementRoadBucket(live?.bucket);
  };

  const discardPendingRoadPublicationWork = () => {
    const publication = pendingDistantPublication;
    if (!publication) return 0;
    const retained = publication.queue.filter(work => !pendingPublicationWorkIsRoad(work));
    const removed = publication.queue.length - retained.length;
    if (removed === 0) return 0;
    publication.queue = retained;
    if (publication.queue.length === 0) completePersistentDistantPublication(publication);
    return removed;
  };

  const installRoadCanonicalReferences = (targetGeneration, roadGeneration) => {
    if (!targetGeneration) return;
    const previousRoadStableIds = [];
    let previousRoadRecordCount = 0;
    for (const [key, bucket] of [...targetGeneration.canonicalBuckets.entries()]) {
      if (isSettlementRoadBucket(bucket)) targetGeneration.canonicalBuckets.delete(key);
    }
    for (const [stableId, object] of [...targetGeneration.canonicalObjects.entries()]) {
      if (object.record?.featureType !== 'settlement-road') continue;
      previousRoadStableIds.push(stableId);
      previousRoadRecordCount += 1;
      targetGeneration.canonicalObjects.delete(stableId);
    }
    const nextRoadObjects = [...(roadGeneration?.canonicalObjects?.values?.() ?? [])]
      .filter(object => object.record?.featureType === 'settlement-road');
    for (const [key, bucket] of roadGeneration?.canonicalBuckets?.entries?.() ?? []) {
      if (!isSettlementRoadBucket(bucket)) continue;
      bucket.resourceOwnerGeneration = roadGeneration;
      targetGeneration.canonicalBuckets.set(key, bucket);
    }
    for (const object of nextRoadObjects) {
      targetGeneration.canonicalObjects.set(object.stableId, object);
    }
    targetGeneration.roadPresentationGeneration = roadGeneration;
    if (targetGeneration.distantVisibleStableIds instanceof Set) {
      for (const stableId of previousRoadStableIds) {
        targetGeneration.distantVisibleStableIds.delete(stableId);
      }
      for (const bucket of roadGeneration?.canonicalBuckets?.values?.() ?? []) {
        if (!isSettlementRoadBucket(bucket)) continue;
        for (const stableId of bucket.mesh?.userData?.canonicalStableIds ?? []) {
          if (stableId) targetGeneration.distantVisibleStableIds.add(stableId);
        }
      }
    }
    if (targetGeneration.stats) {
      targetGeneration.stats.canonicalRecordCount = Math.max(
        0,
        Number(targetGeneration.stats.canonicalRecordCount ?? 0)
          - previousRoadRecordCount + nextRoadObjects.length,
      );
      targetGeneration.stats.canonicalRoadRecordCount = nextRoadObjects.length;
      targetGeneration.stats.canonicalRoadMeshBucketCount = [...targetGeneration.canonicalBuckets.values()]
        .filter(isSettlementRoadBucket).length;
      targetGeneration.stats.canonicalMeshCount = [...targetGeneration.canonicalBuckets.values()]
        .filter(bucket => bucket.mesh).length;
      targetGeneration.stats.canonicalVisibleMeshCount = [...targetGeneration.canonicalBuckets.values()]
        .filter(bucket => bucket.mesh?.visible !== false).length;
    }
  };

  const publishPriorityRoadGeneration = generation => {
    if (!generation || !persistentDistantRoot || !activeGeneration) return false;
    discardPendingRoadPublicationWork();
    const desiredPair = settlementRoadEntryForGeneration(generation);
    const livePair = [...liveDistantEntries.entries()]
      .find(([, entry]) => isSettlementRoadEntry(entry)) ?? null;
    const previous = livePair?.[1] ?? null;
    if (livePair) {
      persistentDistantRoot.remove(previous.mesh);
      liveDistantEntries.delete(livePair[0]);
    }
    generation.stagingRoot = generation.root;
    if (desiredPair) {
      const [key, desired] = desiredPair;
      desired.bucket.resourceOwnerGeneration = generation;
      desired.mesh.parent?.remove?.(desired.mesh);
      persistentDistantRoot.add(desired.mesh);
      liveDistantEntries.set(key, desired);
    }
    if (previous?.generation && previous.generation !== generation) {
      retiredDistantGenerations.add(previous.generation);
    }
    retiredDistantGenerations.add(generation);
    installRoadCanonicalReferences(activeGeneration, generation);
    markRoadLifecyclePublicationQueued(generation);
    markRoadLifecyclePublished(generation);
    roadPriorityPublicationCount += 1;
    if (previous && desiredPair) roadPriorityReplacementCount += 1;
    else if (previous && !desiredPair) roadPriorityRemovalCount += 1;
    recordDiagnosticEvent('distant-road-priority-published', {
      syncEpoch: generation.epoch,
      transitionGeneration: generation.transitionContract?.generation ?? null,
      roadRecordCount: roadObjectsByOwner(generation).size === 0
        ? 0 : [...roadObjectsByOwner(generation).values()]
          .reduce((total, values) => total + values.length, 0),
      replacedExistingRoad: Boolean(previous),
      removedRoad: Boolean(previous && !desiredPair),
    });
    cleanupRetiredDistantGenerations();
    return true;
  };

  const createPriorityRoadGeneration = baseGeneration => {
    const roadRoot = new Group();
    roadRoot.name = `w8-priority-road-presentation-epoch-${baseGeneration.epoch}`;
    roadRoot.userData = {
      presentationOnly: true,
      priorityRoadPresentation: true,
      epoch: baseGeneration.epoch,
      renderDistancePreset: baseGeneration.renderDistancePreset,
    };
    const generation = {
      ...baseGeneration,
      root: roadRoot,
      stagingRoot: roadRoot,
      priorityRoadPresentation: true,
      persistentDistant: false,
      excludeTreeNatural: true,
      excludeNatural: true,
      ownedGeometries: new Set(),
      ownedMaterials: new Set(),
      stats: createStats(),
      canonicalBuckets: new Map(),
      canonicalObjects: new Map(),
      localFullHandoffMaterials: new Map(),
      naturalLodMaterials: new Map(),
      naturalLodPolicies: new Map(),
      nearVisibleStableIds: new Set(),
      nearVisibleStableSignature: '',
      nearVisibleSettlementIds: new Set(),
      nearVisibleSettlementSignature: '',
      distantVisibleStableIds: new Set(),
      remotePartBudgetRemaining: 0,
      roadVisibilityDiagnosticMaterial: null,
    };
    assignTransitionContract(generation, baseGeneration.transitionContract ?? null);
    return generation;
  };

  const buildAndPublishPriorityRoadGeneration = async ({
    baseGeneration,
    activeChunks,
    far,
    presentationBuildOrigin,
    renderOrigin,
    playerLogicalX,
    playerLogicalZ,
    assertCurrent,
    preserveExistingRoadWhenEmpty = false,
  }) => {
    const generation = createPriorityRoadGeneration(baseGeneration);
    const context = {
      target: generation.root,
      ownedGeometries: generation.ownedGeometries,
      stats: generation.stats,
      generation,
      surfacePolicy: generation.surfacePolicy,
    };
    const scheduler = createSliceScheduler({
      assertCurrent,
      budgetMs: ROAD_PRESENTATION_FRAME_BUDGET_MS,
      workKind: 'background',
    });
    let published = false;
    try {
      const chunks = [...activeChunks.values()].sort((left, right) => (
        left.chunkZ - right.chunkZ || left.chunkX - right.chunkX
      ));
      for (const chunk of chunks) {
        await addCanonicalChunk({
          chunk,
          origin: presentationBuildOrigin,
          coveredSettlementIds: far.settlementIds,
          coveredRoadSettlementIds: far.roadSettlementIds,
          includeNatural: false,
          farNaturalEligible: false,
          includeNearDetails: false,
          includeRoadRecords: true,
          includeNonRoadRecords: false,
          context,
          scheduler,
        });
      }
      await scheduler.checkpoint({ force: true });
      for (const source of far.chunks) {
        await addCanonicalChunk({
          chunk: source.chunk,
          origin: presentationBuildOrigin,
          farEligibleSettlementIds: source.settlementIds,
          farEligibleRoadSettlementIds: source.roadSettlementIds,
          includeNatural: false,
          farNaturalEligible: false,
          includeRoadRecords: true,
          includeNonRoadRecords: false,
          queryCenter: far.queryCenter,
          queryRadius: far.queryRadius,
          roadQueryRadius: far.roadQueryRadius,
          context,
          scheduler,
        });
      }
      await scheduler.checkpoint({ force: true });
      await finalizeCanonicalMeshesIncrementally(context, scheduler);
      if (preserveExistingRoadWhenEmpty && roadObjectsByOwner(generation).size === 0) {
        scheduler.finish();
        disposeGeneration(generation);
        return false;
      }
      markRoadLifecycleRegistered(generation);
      positionGenerationForOrigin(generation, renderOrigin);
      const dirtyBuckets = updateCanonicalVisibility(
        generation,
        playerLogicalX,
        playerLogicalZ,
        { compose: false },
      );
      await scheduler.checkpoint({ force: true });
      if (dirtyBuckets.size) {
        await composeCanonicalMeshesIncrementally(generation, dirtyBuckets, scheduler);
      }
      assertCurrent?.();
      published = publishPriorityRoadGeneration(generation);
      scheduler.finish();
      if (!published) disposeGeneration(generation);
      return published;
    } catch (error) {
      if (!published) disposeGeneration(generation);
      throw error;
    }
  };

  const cloneIndependentRoadOwner = owner => ({
    key: owner.key ?? `${owner.chunkX},${owner.chunkZ}`,
    chunkX: owner.chunkX,
    chunkZ: owner.chunkZ,
    settlementIds: new Set(owner.settlementIds ?? []),
    roadSettlementIds: new Set(owner.roadSettlementIds ?? []),
    canonicalMajorRoadCoverage: owner.canonicalMajorRoadCoverage === true,
    remoteHorizonSettlementIds: new Set(owner.remoteHorizonSettlementIds ?? []),
  });

  const mergeIndependentRoadOwner = (target, source) => {
    const merged = target ?? cloneIndependentRoadOwner(source);
    if (target) {
      for (const settlementId of source.settlementIds ?? []) {
        merged.settlementIds.add(settlementId);
      }
      for (const settlementId of source.roadSettlementIds ?? []) {
        merged.roadSettlementIds.add(settlementId);
      }
      for (const settlementId of source.remoteHorizonSettlementIds ?? []) {
        merged.remoteHorizonSettlementIds.add(settlementId);
      }
      merged.canonicalMajorRoadCoverage ||= source.canonicalMajorRoadCoverage === true;
    }
    return merged;
  };

  const rebuildIndependentRoadDesiredOwners = () => {
    const owners = new Map();
    for (const source of [independentRoadCanonicalOwners, independentRoadSettlementOwners]) {
      for (const owner of source.values()) {
        owners.set(owner.key, mergeIndependentRoadOwner(owners.get(owner.key), owner));
      }
    }
    independentRoadDesiredOwners = owners;
  };

  const independentRoadCoverageKeyFor = (
    playerLogicalX,
    playerLogicalZ,
    roadQueryRadius,
    renderDistancePreset,
  ) => {
    const chunkX = Math.floor(playerLogicalX / LOGICAL_CHUNK_SIZE_METERS);
    const chunkZ = Math.floor(playerLogicalZ / LOGICAL_CHUNK_SIZE_METERS);
    return `${chunkX},${chunkZ}:${renderDistancePreset}:${roadQueryRadius}`;
  };

  const independentRoadOwnerDistance = (owner, target = independentRoadTarget) => {
    if (!target) return Number.POSITIVE_INFINITY;
    const centerX = (owner.chunkX + 0.5) * LOGICAL_CHUNK_SIZE_METERS;
    const centerZ = (owner.chunkZ + 0.5) * LOGICAL_CHUNK_SIZE_METERS;
    return Math.hypot(centerX - target.playerLogicalX, centerZ - target.playerLogicalZ);
  };

  const independentRoadOwnerRetained = (owner, target = independentRoadTarget) => (
    Boolean(target) && independentRoadOwnerDistance(owner, target)
      <= target.roadQueryRadius + CANONICAL_QUERY_MARGIN_METERS
  );

  const trimIndependentRoadResolvedOwners = () => {
    if (!independentRoadTarget) return;
    for (const [key, owner] of independentRoadResolvedOwners) {
      if (independentRoadOwnerRetained(owner)) continue;
      independentRoadResolvedOwners.delete(key);
    }
  };

  const independentRoadRecordCount = (owner, chunk) => {
    const presentationResource = presentationOwnerResourceOf(chunk);
    const records = [
      ...(presentationResource?.structures ?? []).map(expandPresentationStructureRecord),
      ...(chunk?.presentationLayers?.formal?.roadsAndBuildings
        ?? chunk?.settlementFeatures ?? []),
    ];
    return records.filter(record => record?.featureType === 'settlement-road'
      && (record.canonicalMajorRoad === true
        || owner.roadSettlementIds.has(
          record.settlementId ?? record.parentSettlementId,
        ))).length;
  };

  const refreshIndependentRoadLifecyclePlan = () => {
    const target = independentRoadTarget;
    if (!target) return;
    const lifecycle = lifecycleFor(target.lifecycleEpoch);
    if (!lifecycle) return;
    const planned = [...independentRoadDesiredOwners.values()]
      .filter(owner => !target.activeKeys.has(owner.key)
        && independentRoadOwnerRetained(owner, target))
      .sort((left, right) => left.key.localeCompare(right.key));
    lifecycle.queryPlannedAtMs ??= monotonicNow();
    lifecycle.roadVisibilityMeters = target.roadVisibilityMeters;
    lifecycle.roadQueryRadius = target.roadQueryRadius;
    lifecycle.plannedRoadOwnerKeys = planned.map(owner => owner.key);
    const completed = [];
    let loadedRoadRecordCount = 0;
    for (const owner of planned) {
      const resolved = independentRoadResolvedOwners.get(owner.key);
      if (!resolved?.chunk) continue;
      completed.push(owner.key);
      loadedRoadRecordCount += independentRoadRecordCount(owner, resolved.chunk);
    }
    lifecycle.completedRoadOwnerKeys = completed;
    lifecycle.loadedRoadRecordCount = loadedRoadRecordCount;
    if (lifecycle.publishedAtMs === null) lifecycle.status = 'loading';
  };

  let runIndependentRoadPublicationLoop = async () => {};
  const requestIndependentRoadPublication = () => {
    independentRoadPublicationDirty = true;
    if (disposed || independentRoadPublicationRunning
      || independentRoadPublicationScheduled) return;
    if (!activeGeneration || !persistentDistantRoot || !independentRoadTarget) return;
    independentRoadPublicationScheduled = true;
    const run = () => {
      independentRoadPublicationScheduled = false;
      void runIndependentRoadPublicationLoop();
    };
    if (typeof globalThis.setTimeout === 'function') globalThis.setTimeout(run, 0);
    else Promise.resolve().then(run);
  };

  const kickIndependentRoadOwnerLoads = () => {
    const target = independentRoadTarget;
    if (disposed || !target) return;
    const owners = [...independentRoadDesiredOwners.values()]
      .filter(owner => !target.activeKeys.has(owner.key)
        && independentRoadOwnerRetained(owner, target))
      .sort((left, right) => (
        independentRoadOwnerDistance(left, target)
          - independentRoadOwnerDistance(right, target)
        || left.chunkZ - right.chunkZ
        || left.chunkX - right.chunkX
      ));
    while (independentRoadActiveLoadCount < CANONICAL_QUERY_CONCURRENCY) {
      const owner = owners.find(candidate => (
        !independentRoadResolvedOwners.has(candidate.key)
        && !independentRoadOwnerLoads.has(candidate.key)
        && independentRoadOwnerFailureRevision.get(candidate.key) !== target.revision
      ));
      if (!owner) break;
      const requestedOwner = cloneIndependentRoadOwner(owner);
      independentRoadActiveLoadCount += 1;
      const request = Promise.resolve().then(() => getCanonicalChunkData(
        requestedOwner.chunkX,
        requestedOwner.chunkZ,
        {
          priority: CHUNK_DATA_PRIORITY.DISTANT_OWNER,
          required: true,
          consumerId: DISTANT_ROAD_OWNER_CONSUMER_ID,
          epoch: DISTANT_ROAD_OWNER_CONSUMER_EPOCH,
        },
      )).then(chunk => {
        if (disposed) return;
        if (!chunk) {
          independentRoadOwnerFailureRevision.set(
            requestedOwner.key,
            independentRoadTarget?.revision ?? target.revision,
          );
          return;
        }
        const currentOwner = independentRoadDesiredOwners.get(requestedOwner.key)
          ?? requestedOwner;
        const resolved = {
          ...cloneIndependentRoadOwner(currentOwner),
          chunk,
        };
        if (!independentRoadOwnerRetained(resolved)) return;
        independentRoadResolvedOwners.set(requestedOwner.key, resolved);
        independentRoadPublicationVersion += 1;
        refreshIndependentRoadLifecyclePlan();
        requestIndependentRoadPublication();
      }, error => {
        independentRoadOwnerFailureRevision.set(requestedOwner.key, target.revision);
        recordDiagnosticEvent('distant-road-owner-query-failed', {
          ownerKey: requestedOwner.key,
          targetRevision: target.revision,
          message: error?.message ?? String(error),
        });
      }).finally(() => {
        independentRoadOwnerLoads.delete(requestedOwner.key);
        independentRoadActiveLoadCount = Math.max(0, independentRoadActiveLoadCount - 1);
        kickIndependentRoadOwnerLoads();
      });
      independentRoadOwnerLoads.set(requestedOwner.key, request);
    }
  };

  const applyIndependentRoadCoverage = ({ coverage, requestedKey }) => {
    const target = independentRoadTarget;
    if (!target) return false;
    const currentRequest = target.coverageKey === requestedKey;
    const owners = currentRequest
      ? new Map()
      : new Map([...independentRoadCanonicalOwners].filter(([, owner]) => (
        independentRoadOwnerRetained(owner, target)
      )));
    for (const coordinate of coverage?.ownerCoordinates ?? []) {
      const owner = cloneIndependentRoadOwner({
        key: coordinate.key ?? `${coordinate.chunkX},${coordinate.chunkZ}`,
        chunkX: coordinate.chunkX,
        chunkZ: coordinate.chunkZ,
        canonicalMajorRoadCoverage: true,
      });
      if (!independentRoadOwnerRetained(owner, target)) continue;
      owners.set(owner.key, owner);
    }
    independentRoadCanonicalOwners = owners;
    rebuildIndependentRoadDesiredOwners();
    if (currentRequest) {
      independentRoadCoverageAppliedKey = requestedKey;
      independentRoadCoverageFailedKey = null;
    }
    independentRoadOwnerFailureRevision.clear();
    independentRoadPublicationVersion += 1;
    trimIndependentRoadResolvedOwners();
    refreshIndependentRoadLifecyclePlan();
    kickIndependentRoadOwnerLoads();
    requestIndependentRoadPublication();
    return true;
  };

  const kickIndependentRoadCoverage = () => {
    const target = independentRoadTarget;
    if (disposed || independentRoadCoverageRunning || !target
      || !resolveCanonicalMajorRoadOwnerCoverage
      || independentRoadCoverageAppliedKey === target.coverageKey
      || independentRoadCoverageFailedKey === target.coverageKey) return;
    independentRoadCoverageRunning = true;
    void (async () => {
      try {
        while (!disposed && independentRoadTarget
          && independentRoadCoverageAppliedKey !== independentRoadTarget.coverageKey
          && independentRoadCoverageFailedKey !== independentRoadTarget.coverageKey) {
          const requestedTarget = independentRoadTarget;
          const requestedKey = requestedTarget.coverageKey;
          let coverage;
          try {
            coverage = await resolveCanonicalMajorRoadOwnerCoverage({
              centerWorldX: requestedTarget.playerLogicalX,
              centerWorldZ: requestedTarget.playerLogicalZ,
              radiusMeters: requestedTarget.roadQueryRadius,
              priority: CHUNK_DATA_PRIORITY.GAMEPLAY_REQUIRED,
              required: true,
              consumerId: DISTANT_ROAD_COVERAGE_CONSUMER_ID,
            });
          } catch (error) {
            recordDiagnosticEvent('distant-road-coverage-query-failed', {
              targetRevision: requestedTarget.revision,
              coverageKey: requestedKey,
              message: error?.message ?? String(error),
            });
            if (independentRoadTarget?.coverageKey === requestedKey) {
              independentRoadCoverageFailedKey = requestedKey;
              break;
            }
            continue;
          }
          if (disposed || !independentRoadTarget) break;
          applyIndependentRoadCoverage({ coverage, requestedKey });
        }
      } finally {
        independentRoadCoverageRunning = false;
        const current = independentRoadTarget;
        if (!disposed && current
          && independentRoadCoverageAppliedKey !== current.coverageKey
          && independentRoadCoverageFailedKey !== current.coverageKey) {
          const retry = () => kickIndependentRoadCoverage();
          if (typeof globalThis.setTimeout === 'function') globalThis.setTimeout(retry, 0);
          else Promise.resolve().then(retry);
        }
      }
    })();
  };

  const stageIndependentRoadContext = ({
    lifecycleEpoch,
    transitionContract,
    activeChunks,
    activeKeys,
    renderedKeys,
    renderOrigin,
    quality,
    renderDistancePreset,
    playerLogicalX,
    playerLogicalZ,
  }) => {
    const policy = resolveW8RenderDistancePolicy(renderDistancePreset);
    const settlementPolicy = resolveW8SettlementPresentationPolicy(
      quality,
      renderDistancePreset,
    );
    const roadVisibilityMeters = policy.worldPresentationDistanceMeters;
    const roadQueryRadius = roadVisibilityMeters + CANONICAL_QUERY_MARGIN_METERS;
    const previous = independentRoadTarget;
    const targetPlayerX = previous?.playerLogicalX ?? playerLogicalX;
    const targetPlayerZ = previous?.playerLogicalZ ?? playerLogicalZ;
    const coverageKey = independentRoadCoverageKeyFor(
      targetPlayerX,
      targetPlayerZ,
      roadQueryRadius,
      renderDistancePreset,
    );
    const coverageChanged = !previous || previous.coverageKey !== coverageKey;
    const revision = coverageChanged
      ? ++independentRoadTargetRevision
      : previous.revision;
    independentRoadTarget = {
      revision,
      coverageKey,
      lifecycleEpoch,
      transitionContract,
      activeChunks: new Map(activeChunks),
      activeKeys: new Set(activeKeys),
      renderedKeys: new Set(renderedKeys),
      renderOrigin: Object.freeze({ ...renderOrigin }),
      quality,
      renderDistancePreset,
      playerLogicalX: targetPlayerX,
      playerLogicalZ: targetPlayerZ,
      queryCenter: Object.freeze({ x: targetPlayerX, z: targetPlayerZ }),
      queryRadius: Math.max(
        policy.generalDetailDistanceMeters + CANONICAL_QUERY_MARGIN_METERS,
        roadQueryRadius,
        settlementPolicy.metadata.queryDistanceMeters,
      ),
      roadVisibilityMeters,
      roadQueryRadius,
      settlementIds: new Set(previous?.settlementIds ?? []),
      roadSettlementIds: new Set(previous?.roadSettlementIds ?? []),
    };
    if (coverageChanged) {
      independentRoadCoverageFailedKey = null;
      independentRoadOwnerFailureRevision.clear();
      trimIndependentRoadResolvedOwners();
      kickIndependentRoadCoverage();
    }
    independentRoadPublicationVersion += 1;
    refreshIndependentRoadLifecyclePlan();
    kickIndependentRoadOwnerLoads();
    requestIndependentRoadPublication();
    return revision;
  };

  const stageIndependentRoadSettlementOwners = ({
    owners,
    settlementIds,
    roadSettlementIds,
    queryRadius,
    roadVisibilityMeters,
    roadQueryRadius,
  }) => {
    const target = independentRoadTarget;
    if (!target) return false;
    const staged = new Map();
    for (const owner of owners) {
      const copy = cloneIndependentRoadOwner(owner);
      staged.set(copy.key, copy);
    }
    independentRoadSettlementOwners = staged;
    rebuildIndependentRoadDesiredOwners();
    target.settlementIds = new Set(settlementIds);
    target.roadSettlementIds = new Set(roadSettlementIds);
    target.queryRadius = queryRadius;
    target.roadVisibilityMeters = roadVisibilityMeters;
    target.roadQueryRadius = roadQueryRadius;
    independentRoadOwnerFailureRevision.clear();
    independentRoadPublicationVersion += 1;
    trimIndependentRoadResolvedOwners();
    refreshIndependentRoadLifecyclePlan();
    kickIndependentRoadOwnerLoads();
    requestIndependentRoadPublication();
    return true;
  };

  const updateIndependentRoadTargetPosition = (
    playerLogicalX,
    playerLogicalZ,
    renderOrigin,
  ) => {
    const target = independentRoadTarget;
    if (!target) return false;
    target.playerLogicalX = playerLogicalX;
    target.playerLogicalZ = playerLogicalZ;
    target.queryCenter = Object.freeze({ x: playerLogicalX, z: playerLogicalZ });
    target.renderOrigin = Object.freeze({ ...renderOrigin });
    const coverageKey = independentRoadCoverageKeyFor(
      playerLogicalX,
      playerLogicalZ,
      target.roadQueryRadius,
      target.renderDistancePreset,
    );
    if (coverageKey === target.coverageKey) return false;
    target.revision = ++independentRoadTargetRevision;
    target.coverageKey = coverageKey;
    independentRoadCoverageFailedKey = null;
    independentRoadOwnerFailureRevision.clear();
    independentRoadPublicationVersion += 1;
    trimIndependentRoadResolvedOwners();
    refreshIndependentRoadLifecyclePlan();
    kickIndependentRoadOwnerLoads();
    kickIndependentRoadCoverage();
    requestIndependentRoadPublication();
    return true;
  };

  const independentRoadFarChunks = target => [...independentRoadResolvedOwners.values()]
    .filter(resolved => !target.activeKeys.has(resolved.key)
      && independentRoadOwnerRetained(resolved, target))
    .map(resolved => ({
      ...cloneIndependentRoadOwner(
        independentRoadDesiredOwners.get(resolved.key) ?? resolved,
      ),
      chunk: resolved.chunk,
    }))
    .sort((left, right) => left.chunkZ - right.chunkZ || left.chunkX - right.chunkX);

  runIndependentRoadPublicationLoop = async () => {
    if (independentRoadPublicationRunning || disposed) return;
    independentRoadPublicationRunning = true;
    try {
      while (independentRoadPublicationDirty && !disposed) {
        if (!activeGeneration || !persistentDistantRoot || !independentRoadTarget) return;
        const target = independentRoadTarget;
        const publicationVersion = independentRoadPublicationVersion;
        if (publicationVersion === independentRoadLastPublishedVersion) {
          independentRoadPublicationDirty = false;
          break;
        }
        const farChunks = independentRoadFarChunks(target);
        independentRoadPublicationDirty = false;
        const presentationBuildOrigin = Object.freeze({
          renderOriginChunkX: activeGeneration.buildOriginChunkX,
          renderOriginChunkZ: activeGeneration.buildOriginChunkZ,
          rebaseCount: committedRenderOrigin?.rebaseCount ?? target.renderOrigin.rebaseCount,
        });
        const baseGeneration = {
          ...activeGeneration,
          epoch: target.lifecycleEpoch,
          quality: target.quality,
          renderDistancePreset: target.renderDistancePreset,
          renderDistancePolicy: resolveW8RenderDistancePolicy(target.renderDistancePreset),
          settlementPresentationPolicy: resolveW8SettlementPresentationPolicy(
            target.quality,
            target.renderDistancePreset,
          ),
          surfacePolicy: surfacePolicyForChunks([
            ...target.activeChunks.values(),
            ...farChunks.map(value => value.chunk),
          ]),
          activeKeys: new Set(target.activeKeys),
          renderedKeys: new Set(target.renderedKeys),
          playerX: target.playerLogicalX,
          playerZ: target.playerLogicalZ,
          buildOriginChunkX: presentationBuildOrigin.renderOriginChunkX,
          buildOriginChunkZ: presentationBuildOrigin.renderOriginChunkZ,
          currentOriginChunkX: committedRenderOrigin?.renderOriginChunkX
            ?? target.renderOrigin.renderOriginChunkX,
          currentOriginChunkZ: committedRenderOrigin?.renderOriginChunkZ
            ?? target.renderOrigin.renderOriginChunkZ,
          transitionContract: target.transitionContract,
        };
        try {
          await buildAndPublishPriorityRoadGeneration({
            baseGeneration,
            activeChunks: target.activeChunks,
            far: {
              settlementIds: new Set(target.settlementIds),
              roadSettlementIds: new Set(target.roadSettlementIds),
              chunks: farChunks,
              queryCenter: target.queryCenter,
              queryRadius: target.queryRadius,
              roadQueryRadius: target.roadQueryRadius,
            },
            presentationBuildOrigin,
            renderOrigin: committedRenderOrigin ?? target.renderOrigin,
            playerLogicalX: target.playerLogicalX,
            playerLogicalZ: target.playerLogicalZ,
            assertCurrent: () => {
              if (disposed) throw SYNC_CANCELLED;
            },
            preserveExistingRoadWhenEmpty: true,
          });
          independentRoadLastPublishedVersion = publicationVersion;
        } catch (error) {
          if (error !== SYNC_CANCELLED) {
            recordDiagnosticEvent('distant-road-independent-publication-failed', {
              targetRevision: target.revision,
              publicationVersion,
              message: error?.message ?? String(error),
            });
          }
        }
        if (publicationVersion !== independentRoadPublicationVersion) {
          independentRoadPublicationDirty = true;
        }
      }
    } finally {
      independentRoadPublicationRunning = false;
      if (independentRoadPublicationDirty && !disposed
        && activeGeneration && persistentDistantRoot) {
        requestIndependentRoadPublication();
      }
    }
  };

  const roadVisibilityDiagnosticMaterial = (sourceMaterial, generation) => {
    if (!roadVisibilityDiagnostic.enabled) return sourceMaterial;
    if (generation.roadVisibilityDiagnosticMaterial) {
      return generation.roadVisibilityDiagnosticMaterial;
    }
    const DiagnosticMaterial = roadVisibilityDiagnostic.unlit
      && typeof THREE.MeshBasicMaterial === 'function'
      ? THREE.MeshBasicMaterial
      : Material;
    const material = new DiagnosticMaterial({
      color: roadVisibilityDiagnostic.colorHex,
      flatShading: true,
      fog: !roadVisibilityDiagnostic.disableFog,
      toneMapped: false,
      transparent: false,
      opacity: 1,
      depthWrite: true,
      depthTest: true,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    if (typeof material.color?.getHex !== 'function') {
      material.color = new Color(roadVisibilityDiagnostic.colorHex);
    }
    material.name = `w8-road-visibility-debug-${roadVisibilityDiagnostic.mode}`;
    material.fog = !roadVisibilityDiagnostic.disableFog;
    material.toneMapped = false;
    material.transparent = false;
    material.opacity = 1;
    material.depthWrite = true;
    material.depthTest = true;
    material.polygonOffset = true;
    material.polygonOffsetFactor = -2;
    material.polygonOffsetUnits = -2;
    material.userData = {
      ...(material.userData ?? {}),
      roadVisibilityDiagnostic: true,
      roadVisibilityDiagnosticMode: roadVisibilityDiagnostic.mode,
      roadVisibilityDiagnosticColorHex: roadVisibilityDiagnostic.colorHex,
      roadVisibilityDiagnosticWidthMultiplier: roadVisibilityDiagnostic.widthMultiplier,
      roadVisibilityDiagnosticUnlit: roadVisibilityDiagnostic.unlit,
      roadVisibilityDiagnosticFogDisabled: roadVisibilityDiagnostic.disableFog,
    };
    material.needsUpdate = true;
    generation.roadVisibilityDiagnosticMaterial = material;
    generation.ownedMaterials.add(material);
    return material;
  };

  const settlementRoadOwnerEntries = items => {
    const itemsByOwner = new Map();
    for (const item of items) {
      const owner = item.object.record.owningChunkCoordinate;
      const key = `${owner.x},${owner.z}`;
      const ownerItems = itemsByOwner.get(key) ?? [];
      ownerItems.push(item);
      itemsByOwner.set(key, ownerItems);
    }
    return [...itemsByOwner.entries()].sort(([left], [right]) => left.localeCompare(right));
  };

  const buildSettlementRoadOwnerPart = (ownerKey, ownerItems, generation) => {
    const [chunkX, chunkZ] = ownerKey.split(',').map(Number);
    const sourceRoads = ownerItems.map(item => item.object.record);
    const roads = roadVisibilityDiagnostic.widthMultiplier === 1
      ? sourceRoads
      : sourceRoads.map(road => ({
        ...road,
        widthMeters: Number(road.widthMeters) * roadVisibilityDiagnostic.widthMultiplier,
      }));
    const elevationByStableId = new Map(ownerItems.map(item => [
      item.object.stableId,
      item.object.renderRoadElevation,
    ]));
    const heightAt = createRoadRibbonHeightSampler(roads, (road, _point, endpoint) => {
      const elevation = elevationByStableId.get(road.stableId);
      return endpoint === 'start' ? elevation?.startY : elevation?.endY;
    });
    return {
      ownerKey,
      meshData: buildSettlementRoadRibbonMeshData({
        roads,
        heightAt,
        originX: generation.buildOriginChunkX * LOGICAL_CHUNK_SIZE_METERS,
        originZ: generation.buildOriginChunkZ * LOGICAL_CHUNK_SIZE_METERS,
        unitsPerMeter: UNITS_PER_METER,
        surfaceOffsetMeters: 0.075,
        clipBounds: {
          minX: chunkX * LOGICAL_CHUNK_SIZE_METERS,
          minZ: chunkZ * LOGICAL_CHUNK_SIZE_METERS,
          maxX: (chunkX + 1) * LOGICAL_CHUNK_SIZE_METERS,
          maxZ: (chunkZ + 1) * LOGICAL_CHUNK_SIZE_METERS,
        },
      }),
    };
  };

  const createSettlementRoadGeometryFromParts = (parts, items, generation) => {
    const BufferGeometry = requireConstructor(THREE, 'BufferGeometry');
    const Float32BufferAttribute = requireConstructor(THREE, 'Float32BufferAttribute');
    const positions = [];
    const normals = [];
    const indices = [];
    let vertexOffset = 0;
    for (const { meshData } of parts) {
      positions.push(...meshData.positions);
      normals.push(...meshData.normals);
      indices.push(...[...meshData.indices].map(index => index + vertexOffset));
      vertexOffset += meshData.stats.vertexCount;
    }
    const meshData = {
      positions: new Float32Array(positions),
      normals: new Float32Array(normals),
      indices: new Uint32Array(indices),
      hash: parts.map(part => `${part.ownerKey}:${part.meshData.hash}`).join('|'),
      stats: Object.freeze({
        roadRecordCount: items.length,
        routeCount: new Set(items.map(item => item.object.record.routeId
          ?? item.object.record.sourceStableId ?? item.object.stableId)).size,
        polylineCount: parts.reduce((total, part) => total + part.meshData.stats.polylineCount, 0),
        nodeCount: parts.reduce((total, part) => total + part.meshData.stats.nodeCount, 0),
        junctionCount: parts.reduce((total, part) => total + part.meshData.stats.junctionCount, 0),
        miterJoinCount: parts.reduce((total, part) => total + part.meshData.stats.miterJoinCount, 0),
        bevelJoinCount: parts.reduce((total, part) => total + part.meshData.stats.bevelJoinCount, 0),
        vertexCount: positions.length / 3,
        indexCount: indices.length,
        triangleCount: indices.length / 3,
        duplicateFaceCount: parts.reduce(
          (total, part) => total + part.meshData.stats.duplicateFaceCount, 0,
        ),
        degenerateTriangleCount: parts.reduce(
          (total, part) => total + part.meshData.stats.degenerateTriangleCount, 0,
        ),
        uploadBytes: positions.length * 4 + normals.length * 4 + indices.length * 4,
      }),
    };
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(meshData.positions, 3));
    geometry.setAttribute('normal', new Float32BufferAttribute(meshData.normals, 3));
    if (typeof geometry.setIndex === 'function') geometry.setIndex([...meshData.indices]);
    else geometry.index = meshData.indices;
    geometry.userData = {
      roadRibbon: meshData.stats,
      roadRibbonHash: meshData.hash,
    };
    if (roadVisibilityDiagnostic.enabled) {
      let minimumSourceWidthMeters = null;
      let maximumSourceWidthMeters = null;
      for (const item of items) {
        const widthMeters = Number(item.object.record.widthMeters);
        if (!Number.isFinite(widthMeters) || widthMeters <= 0) continue;
        minimumSourceWidthMeters = minimumSourceWidthMeters === null
          ? widthMeters : Math.min(minimumSourceWidthMeters, widthMeters);
        maximumSourceWidthMeters = maximumSourceWidthMeters === null
          ? widthMeters : Math.max(maximumSourceWidthMeters, widthMeters);
      }
      geometry.userData.roadVisibilityDiagnostic = Object.freeze({
        ...roadVisibilityDiagnostic,
        minimumSourceWidthMeters,
        maximumSourceWidthMeters,
        minimumRenderedWidthMeters: minimumSourceWidthMeters === null
          ? null : minimumSourceWidthMeters * roadVisibilityDiagnostic.widthMultiplier,
        maximumRenderedWidthMeters: maximumSourceWidthMeters === null
          ? null : maximumSourceWidthMeters * roadVisibilityDiagnostic.widthMultiplier,
      });
    }
    generation.ownedGeometries.add(geometry);
    return geometry;
  };

  const createSettlementRoadBucketGeometry = (items, generation) => {
    const parts = settlementRoadOwnerEntries(items).map(([ownerKey, ownerItems]) => (
      buildSettlementRoadOwnerPart(ownerKey, ownerItems, generation)
    ));
    return createSettlementRoadGeometryFromParts(parts, items, generation);
  };

  const disposeSettlementRoadGeometry = (geometry, generation) => {
    if (!geometry) return false;
    if (disposedRoadGeometries.has(geometry)) {
      roadPresentationDoubleDisposeCount += 1;
      return false;
    }
    disposedRoadGeometries.add(geometry);
    generation.ownedGeometries.delete(geometry);
    geometry.dispose?.();
    return true;
  };

  const replaceSettlementRoadBucketGeometry = (bucket, generation, items) => {
    const signature = items.map(item => item.object.stableId).sort().join('\n');
    if (bucket.roadRibbonSignature === signature && bucket.mesh?.geometry) return false;
    const previous = bucket.roadRibbonGeometry ?? null;
    const geometry = createSettlementRoadBucketGeometry(items, generation);
    bucket.roadRibbonGeometry = geometry;
    bucket.roadRibbonSignature = signature;
    if (bucket.mesh) bucket.mesh.geometry = geometry;
    if (previous && previous !== geometry) {
      disposeSettlementRoadGeometry(previous, generation);
    }
    return true;
  };

  const rotateFarTreeVector = (x, y, z, rotation) => {
    const [rx, ry, rz] = rotation;
    const cosX = Math.cos(rx); const sinX = Math.sin(rx);
    const cosY = Math.cos(ry); const sinY = Math.sin(ry);
    const cosZ = Math.cos(rz); const sinZ = Math.sin(rz);
    const x1 = x;
    const y1 = y * cosX - z * sinX;
    const z1 = y * sinX + z * cosX;
    const x2 = x1 * cosY + z1 * sinY;
    const y2 = y1;
    const z2 = -x1 * sinY + z1 * cosY;
    return [x2 * cosZ - y2 * sinZ, x2 * sinZ + y2 * cosZ, z2];
  };

  const createCanonicalFarTreeGeometry = (bucket, context) => {
    const BufferGeometry = requireConstructor(THREE, 'BufferGeometry');
    const Float32BufferAttribute = requireConstructor(THREE, 'Float32BufferAttribute');
    const geometry = new BufferGeometry();
    const positions = [];
    const normals = [];
    const indices = [];
    let vertexOffset = 0;
    let materialIndex = 0;
    let triangleCount = 0;
    for (const part of bucket.canonicalFarTreeParts ?? []) {
      const source = visualAssets.geometries?.[part.geometry];
      const sourcePositions = source?.attributes?.position?.array
        ?? source?.attributes?.position?.values ?? null;
      const sourceNormals = source?.attributes?.normal?.array
        ?? source?.attributes?.normal?.values ?? null;
      const sourceIndices = source?.index?.array ?? source?.index ?? null;
      const vertexCount = Math.floor((sourcePositions?.length ?? 0) / 3);
      for (let vertex = 0; vertex < vertexCount; vertex += 1) {
        const scaled = rotateFarTreeVector(
          sourcePositions[vertex * 3] * part.scale[0],
          sourcePositions[vertex * 3 + 1] * part.scale[1],
          sourcePositions[vertex * 3 + 2] * part.scale[2],
          part.rotation,
        );
        positions.push(
          scaled[0] + part.position[0],
          scaled[1] + part.position[1],
          scaled[2] + part.position[2],
        );
        if (sourceNormals?.length >= (vertex + 1) * 3) {
          const rotated = rotateFarTreeVector(
            sourceNormals[vertex * 3] / part.scale[0],
            sourceNormals[vertex * 3 + 1] / part.scale[1],
            sourceNormals[vertex * 3 + 2] / part.scale[2],
            part.rotation,
          );
          const length = Math.hypot(...rotated) || 1;
          normals.push(rotated[0] / length, rotated[1] / length, rotated[2] / length);
        }
      }
      const partIndices = sourceIndices
        ? Array.from(sourceIndices)
        : Array.from({ length: vertexCount }, (_, index) => index);
      const groupStart = indices.length;
      indices.push(...partIndices.map(index => index + vertexOffset));
      const groupCount = indices.length - groupStart;
      if (typeof geometry.addGroup === 'function') {
        geometry.addGroup(groupStart, groupCount, materialIndex);
      } else {
        geometry.groups ??= [];
        geometry.groups.push({ start: groupStart, count: groupCount, materialIndex });
      }
      triangleCount += groupCount / 3;
      vertexOffset += vertexCount;
      materialIndex += 1;
    }
    geometry.setAttribute('position', new Float32BufferAttribute(new Float32Array(positions), 3));
    if (normals.length === positions.length) {
      geometry.setAttribute('normal', new Float32BufferAttribute(new Float32Array(normals), 3));
    } else {
      geometry.computeVertexNormals?.();
    }
    if (typeof geometry.setIndex === 'function') geometry.setIndex(indices);
    else geometry.index = indices;
    geometry.computeBoundingBox?.();
    geometry.computeBoundingSphere?.();
    geometry.userData = {
      ...(geometry.userData ?? {}),
      canonicalFarTreeCombined: true,
      canonicalFarTreePartCount: materialIndex,
      canonicalFarTreeTriangleCount: triangleCount,
      canonicalFarTreeSourceGeometries: Object.freeze(
        (bucket.canonicalFarTreeParts ?? []).map(part => part.geometry),
      ),
      canonicalFarTreeSourceMaterials: Object.freeze(
        (bucket.canonicalFarTreeParts ?? []).map(part => part.material),
      ),
    };
    context.generation.ownedGeometries.add(geometry);
    return geometry;
  };

  const prepareCanonicalBucketMesh = (bucket, context) => {
    if (!bucket.items.length) return null;
    const persistentEntryKey = `bucket:${bucket.key
      ?? `${bucket.geometry}:${bucket.material}:${bucket.name}`}`;
    const reusableEntry = context.generation.persistentDistant === true
      && context.generation.allowPersistentDistantMeshReuse !== false
      && persistentDistantRoot
      && isPersistentDistantBucketName(bucket.name)
      ? liveDistantEntries.get(persistentEntryKey) ?? null
      : null;
    if (reusableEntry?.bucket?.mesh
      && bucket.items.length <= (reusableEntry.bucket.capacity ?? reusableEntry.mesh.capacity)) {
      bucket.capacity = reusableEntry.bucket.capacity ?? reusableEntry.mesh.capacity;
      bucket.persistent = true;
      bucket.persistentReuseEntryKey = persistentEntryKey;
      bucket.naturalLod = reusableEntry.bucket.naturalLod ?? parseNaturalLodBucket(bucket);
      return { mesh: null, roadBucketStartedAt: null, persistentReuse: true };
    }
    const roadBucketStartedAt = bucket.geometry === '__road__' ? monotonicNow() : null;
    const canonicalFarTree = Array.isArray(bucket.canonicalFarTreeParts);
    let geometry = canonicalFarTree
      ? createCanonicalFarTreeGeometry(bucket, context)
      : isSettlementRoadBucket(bucket)
      ? createSettlementRoadBucketGeometry(bucket.items, context.generation)
      : bucket.geometry === '__road__' ? roadGeometry : visualAssets.geometries[bucket.geometry];
    const sourceMaterial = canonicalFarTree
      ? null : visualAssets.materials[bucket.material];
    const localHorizon = bucket.name === 'horizon-building'
      || bucket.name === 'horizon-landmark';
    const localBuildingHandoff = bucket.name === 'building'
      || bucket.name === 'horizon-building';
    const remoteHorizon = bucket.name === 'remote-horizon-building'
      || bucket.name === 'remote-horizon-landmark';
    const naturalLod = parseNaturalLodBucket(bucket);
    const generatedMaterial = canonicalFarTree || localHorizon || remoteHorizon || (
      naturalLod && naturalLod.mode !== 'full'
        && naturalLod.kind !== W8_VEGETATION_LOD_KINDS.ROCK
    );
    if (!geometry || (!sourceMaterial && !generatedMaterial)) {
      throw new Error(`canonical finite visual resource is missing: ${bucket.geometry}/${bucket.material}`);
    }
    let material = sourceMaterial;
    if (localHorizon) {
      if (bucket.name === 'horizon-building') {
        material = context.generation.horizonBuildingSilhouetteMaterial
          ?? createHorizonSilhouetteMaterial({ handoff: true });
        context.generation.horizonBuildingSilhouetteMaterial = material;
      } else {
        material = context.generation.horizonSilhouetteMaterial
          ?? createHorizonSilhouetteMaterial();
        context.generation.horizonSilhouetteMaterial = material;
      }
      context.generation.ownedMaterials.add(material);
    } else if (remoteHorizon) {
      material = context.generation.remoteHorizonSilhouetteMaterial;
      if (!material) {
        material = createRemoteHorizonSilhouetteMaterial(
          context.generation.settlementPresentationPolicy.remote,
        );
        context.generation.remoteHorizonSilhouetteMaterial = material;
        context.generation.ownedMaterials.add(material);
      }
      geometry = createRemoteHorizonGeometry(geometry, bucket, context);
    }
    if (naturalLod) {
      material = canonicalFarTree
        ? bucket.canonicalFarTreeParts.map(part => createNaturalLodMaterial({
          ...naturalLod,
          sourceMaterial: visualAssets.materials[part.material],
          materialKey: part.material,
          context,
        }))
        : createNaturalLodMaterial({
          ...naturalLod,
          sourceMaterial,
          materialKey: bucket.material,
          context,
        });
      geometry = createNaturalLodGeometry(geometry, bucket, context);
      bucket.naturalLod = naturalLod;
    }
    if (localBuildingHandoff) {
      if (bucket.name === 'building') {
        material = localFullHandoffMaterial(sourceMaterial, context);
      }
      geometry = createLocalHandoffGeometry(geometry, bucket, context);
    }
    if (isSettlementRoadBucket(bucket)) {
      material = roadVisibilityDiagnosticMaterial(sourceMaterial, context.generation);
    }
    const mesh = isSettlementRoadBucket(bucket)
      ? new Mesh(geometry, material)
      : new InstancedMesh(geometry, material, bucket.capacity ?? bucket.items.length);
    mesh.name = `w8-canonical-lod-${bucket.name}-${bucket.geometry}-${bucket.material}`;
    mesh.count = 0;
    mesh.visible = true;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.userData = {
      presentationOnly: true,
      treePathId: treePathIdForBucket(bucket, context.generation),
      treePathMode: naturalLod?.mode ?? null,
      canonicalStableIds: [],
      canonicalObjects: [],
      canonicalOpacities: [],
      canonicalVisualRevision: 0,
      canonicalCoarseTreeSubmission: canonicalFarTree
        && context.generation.coarseFirstNatural === true,
      remoteSettlementIds: [],
      ...(isSettlementRoadBucket(bucket) ? {
        roadRibbon: geometry.userData?.roadRibbon ?? null,
        roadRibbonHash: geometry.userData?.roadRibbonHash ?? null,
        ...(roadVisibilityDiagnostic.enabled ? {
          roadVisibilityDiagnosticMode: roadVisibilityDiagnostic.mode,
          roadVisibilityDiagnosticColorHex: roadVisibilityDiagnostic.colorHex,
          roadVisibilityDiagnosticWidthMultiplier: roadVisibilityDiagnostic.widthMultiplier,
          roadVisibilityDiagnosticFogDisabled: roadVisibilityDiagnostic.disableFog,
          roadVisibilityDiagnosticUnlit: roadVisibilityDiagnostic.unlit,
        } : {}),
      } : {}),
    };
    if (isSettlementRoadBucket(bucket)) {
      bucket.roadRibbonGeometry = geometry;
      bucket.roadRibbonSignature = bucket.items.map(item => item.object.stableId).sort().join('\n');
      mesh.count = isPersistentCoarseTreeBucket(bucket)
        ? (bucket.coarseTreeSubmittedCount ?? 0) : bucket.items.length;
    }
    return { mesh, roadBucketStartedAt };
  };

  const completeCanonicalBucketMesh = (bucket, context, prepared) => {
    if (prepared.persistentReuse === true) return;
    bucket.mesh = prepared.mesh;
    context.target.add(prepared.mesh);
    if (prepared.roadBucketStartedAt !== null) {
      context.stats.canonicalRoadMeshBucketCount += 1;
      context.stats.canonicalRoadMeshComposeMs += monotonicNow() - prepared.roadBucketStartedAt;
    }
    context.stats.canonicalMeshCount += 1;
    if (prepared.mesh.visible !== false) context.stats.canonicalVisibleMeshCount += 1;
  };

  const finalizeCanonicalMeshesIncrementally = async (context, scheduler) => {
    for (const bucket of context.generation.canonicalBuckets.values()) {
      const prepared = prepareCanonicalBucketMesh(bucket, context);
      if (!prepared) continue;
      for (const item of bucket.items) {
        if (!item.object.instances.some(instance => instance.item === item)) {
          item.object.instances.push({ bucket, item });
        }
        const pendingYield = scheduler.checkpoint();
        if (pendingYield) await pendingYield;
      }
      completeCanonicalBucketMesh(bucket, context, prepared);
      const pendingYield = scheduler.checkpoint();
      if (pendingYield) await pendingYield;
    }
  };

  const positionGenerationForOrigin = (generation, renderOrigin) => {
    if (!generation || !renderOrigin) return;
    generation.currentOriginChunkX = renderOrigin.renderOriginChunkX;
    generation.currentOriginChunkZ = renderOrigin.renderOriginChunkZ;
    generation.root.position.set(
      (generation.buildOriginChunkX - renderOrigin.renderOriginChunkX)
        * LOGICAL_CHUNK_SIZE_METERS * UNITS_PER_METER,
      0,
      (generation.buildOriginChunkZ - renderOrigin.renderOriginChunkZ)
        * LOGICAL_CHUNK_SIZE_METERS * UNITS_PER_METER,
    );
    if (diagnosticsEnabled) {
      generation.lastRenderOriginRevision = Number.isSafeInteger(renderOrigin.rebaseCount)
        ? renderOrigin.rebaseCount : null;
      generation.lastRenderOriginAppliedAtMs = monotonicNow();
      generation.root.userData ??= {};
      generation.root.userData.lastRenderOriginRevision = generation.lastRenderOriginRevision;
      generation.root.userData.lastRenderOriginChunkX = renderOrigin.renderOriginChunkX;
      generation.root.userData.lastRenderOriginChunkZ = renderOrigin.renderOriginChunkZ;
      generation.root.userData.lastRenderOriginAppliedAtMs =
        generation.lastRenderOriginAppliedAtMs;
    }
  };

  const transformVectorSnapshot = value => Object.freeze({
    x: Number(value?.x ?? 0),
    y: Number(value?.y ?? 0),
    z: Number(value?.z ?? 0),
  });

  const matrixWorldTranslationSnapshot = object => {
    const elements = object?.matrixWorld?.elements;
    if (elements?.length >= 16 && [elements[12], elements[13], elements[14]].every(Number.isFinite)) {
      return Object.freeze({ x: elements[12], y: elements[13], z: elements[14] });
    }
    let x = 0;
    let y = 0;
    let z = 0;
    for (let current = object; current; current = current.parent) {
      x += Number(current.position?.x ?? 0);
      y += Number(current.position?.y ?? 0);
      z += Number(current.position?.z ?? 0);
    }
    return Object.freeze({ x, y, z });
  };

  const generationTransformSnapshot = (role, generation, { attachedTo = root } = {}) => {
    if (!generation?.root) return Object.freeze({ role, attached: false, rootIdentity: null });
    const currentOriginChunkX = committedRenderOrigin?.renderOriginChunkX
      ?? generation.currentOriginChunkX;
    const currentOriginChunkZ = committedRenderOrigin?.renderOriginChunkZ
      ?? generation.currentOriginChunkZ;
    const expectedX = (generation.buildOriginChunkX - currentOriginChunkX)
      * LOGICAL_CHUNK_SIZE_METERS * UNITS_PER_METER;
    const expectedZ = (generation.buildOriginChunkZ - currentOriginChunkZ)
      * LOGICAL_CHUNK_SIZE_METERS * UNITS_PER_METER;
    return Object.freeze({
      role,
      rootIdentity: generation.root.name ?? null,
      logicalOwner: Number.isSafeInteger(generation.centerChunkX)
        ? `${generation.centerChunkX},${generation.centerChunkZ}` : null,
      transitionGeneration: generation.transitionContract?.generation ?? null,
      renderOriginRevision: generation.root.userData?.lastRenderOriginRevision
        ?? generation.lastRenderOriginRevision
        ?? committedRenderOrigin?.rebaseCount ?? null,
      rootPosition: transformVectorSnapshot(generation.root.position),
      matrixWorldTranslation: matrixWorldTranslationSnapshot(generation.root),
      buildOrigin: Object.freeze({
        chunkX: generation.buildOriginChunkX,
        chunkZ: generation.buildOriginChunkZ,
      }),
      currentOrigin: Object.freeze({
        chunkX: generation.root.userData?.lastRenderOriginChunkX
          ?? generation.currentOriginChunkX,
        chunkZ: generation.root.userData?.lastRenderOriginChunkZ
          ?? generation.currentOriginChunkZ,
      }),
      generationCurrentOrigin: Object.freeze({
        chunkX: generation.currentOriginChunkX,
        chunkZ: generation.currentOriginChunkZ,
      }),
      rebaseAppliedBy: 'positionGenerationForOrigin',
      rebaseAppliedAtMs: generation.root.userData?.lastRenderOriginAppliedAtMs
        ?? generation.lastRenderOriginAppliedAtMs ?? null,
      staleRevisionGuard: 'acceptCommittedRenderOrigin',
      attached: generation.root.parent === attachedTo,
      visible: generation.root.visible !== false,
      drawnOwnerCount: generation.currentVisibleMidgroundOwnerKeys?.size
        ?? generation.renderedKeys?.size ?? generation.activeKeys?.size ?? 0,
      originAligned: (generation.root.userData?.lastRenderOriginChunkX
          ?? generation.currentOriginChunkX) === currentOriginChunkX
        && (generation.root.userData?.lastRenderOriginChunkZ
          ?? generation.currentOriginChunkZ) === currentOriginChunkZ
        && Math.abs(Number(generation.root.position?.x ?? 0) - expectedX) < 1e-6
        && Math.abs(Number(generation.root.position?.z ?? 0) - expectedZ) < 1e-6,
    });
  };

  const remoteAnchorValues = bucket => (
    bucket.remoteAnchorAttribute?.array ?? bucket.remoteAnchorAttribute?.values ?? null
  );

  const remoteSourceColorValues = bucket => (
    bucket.remoteSourceColorAttribute?.array
      ?? bucket.remoteSourceColorAttribute?.values
      ?? null
  );

  const writeRemoteSourceColor = (bucket, index, item) => {
    const values = remoteSourceColorValues(bucket);
    if (!values) return;
    const color = item.remoteSourceColor;
    if (!color || ![color.r, color.g, color.b].every(Number.isFinite)) {
      throw new Error(`remote Settlement instance source tint is invalid: ${item.object.stableId}`);
    }
    values[index * 3] = color.r;
    values[index * 3 + 1] = color.g;
    values[index * 3 + 2] = color.b;
  };

  const writeRemoteBuildingAnchor = (bucket, index, object, generation) => {
    const values = remoteAnchorValues(bucket);
    if (!values) return;
    values[index * 2] = (
      object.worldX - generation.buildOriginChunkX * LOGICAL_CHUNK_SIZE_METERS
    ) * UNITS_PER_METER;
    values[index * 2 + 1] = (
      object.worldZ - generation.buildOriginChunkZ * LOGICAL_CHUNK_SIZE_METERS
    ) * UNITS_PER_METER;
  };

  const finishRemoteBuildingAnchorWrite = (bucket, mesh, canonicalObjects) => {
    if (!remoteAnchorValues(bucket)) return;
    bucket.remoteAnchorAttribute.needsUpdate = true;
    bucket.remoteSourceColorAttribute.needsUpdate = true;
    // setMatrixAt() does not invalidate InstancedMesh bounds in Three r160.
    // Force the renderer to derive bounds from the newly compacted instances.
    mesh.boundingBox = null;
    mesh.boundingSphere = null;
    mesh.userData.remoteSettlementIds = Object.freeze([...new Set(canonicalObjects
      .map(record => record.settlementId ?? record.parentSettlementId)
      .filter(Boolean))].sort((left, right) => left.localeCompare(right)));
  };

  const naturalAnchorValues = bucket => (
    bucket.naturalAnchorAttribute?.array ?? bucket.naturalAnchorAttribute?.values ?? null
  );

  const writeNaturalAnchor = (bucket, index, object, generation) => {
    const values = naturalAnchorValues(bucket);
    if (!values) return;
    values[index * 2] = (
      object.worldX - generation.buildOriginChunkX * LOGICAL_CHUNK_SIZE_METERS
    ) * UNITS_PER_METER;
    values[index * 2 + 1] = (
      object.worldZ - generation.buildOriginChunkZ * LOGICAL_CHUNK_SIZE_METERS
    ) * UNITS_PER_METER;
  };

  const finishNaturalAnchorWrite = (bucket, mesh) => {
    if (!naturalAnchorValues(bucket)) return;
    bucket.naturalAnchorAttribute.needsUpdate = true;
    mesh.boundingBox = null;
    mesh.boundingSphere = null;
  };

  const naturalInitialRevealValues = bucket => (
    bucket.naturalInitialRevealAttribute?.array
      ?? bucket.naturalInitialRevealAttribute?.values
      ?? null
  );

  const writeNaturalInitialReveal = (bucket, index, _object, generation, _item = null) => {
    const values = naturalInitialRevealValues(bucket);
    if (!values) return false;
    const value = generation.persistentNatural ? 1 : 0;
    if (values[index] !== value) {
      values[index] = value;
      return true;
    }
    return false;
  };

  const finishNaturalInitialRevealWrite = bucket => {
    if (naturalInitialRevealValues(bucket)) {
      bucket.naturalInitialRevealAttribute.needsUpdate = true;
    }
  };

  const localHandoffOpacityValues = bucket => (
    bucket.localHandoffOpacityAttribute?.array
      ?? bucket.localHandoffOpacityAttribute?.values
      ?? null
  );

  const canonicalInstanceOpacity = (object, item) => {
    if (item.visibilityTiers.includes('remote-horizon')) {
      return object.presentationTier === 'remote-horizon'
        ? object.remotePresentationOpacity : 0;
    }
    if (object.localBuildingHandoff) {
      if (item.visibilityTiers.includes('horizon')) {
        return object.horizonPresentationOpacity;
      }
      if (item.visibilityTiers.includes('full')) return object.fullPresentationOpacity;
    }
    if (object.naturalKind && item.visibilityTiers.includes('natural-lod')) {
      return object.presentationTier === 'natural-lod' ? 1 : 0;
    }
    return object.presentationTier && item.visibilityTiers.includes(object.presentationTier)
      ? 1 : 0;
  };

  const hiddenCanonicalMatrix = () => {
    transform.position.set(0, 0, 0);
    transform.rotation.set(0, 0, 0);
    transform.scale.set(0, 0, 0);
    transform.updateMatrix();
    return transform.matrix.clone?.() ?? structuredClone(transform.matrix);
  };

  const writeLocalHandoffOpacity = (bucket, index, opacity) => {
    const values = localHandoffOpacityValues(bucket);
    if (values) values[index] = opacity;
  };

  const finishLocalHandoffOpacityWrite = bucket => {
    if (!localHandoffOpacityValues(bucket)) return;
    bucket.localHandoffOpacityAttribute.needsUpdate = true;
  };

  const finishCanonicalCompose = (generation, composed, matrixUpdates) => {
    const nearStableIds = generation.nearVisibleStableIds ?? new Set();
    generation.stats.canonicalComposeCount += 1;
    generation.stats.canonicalDirtyBucketCount += composed;
    generation.stats.canonicalMatrixUpdateCount += matrixUpdates;
    generation.stats.canonicalNeedsUpdateCount += composed;
    generation.stats.remoteHorizonSuppressedByNearCount = [...generation.canonicalObjects.values()]
      .filter(object => object.remoteHorizon && nearStableIds.has(object.stableId)).length;
    const distantVisibleStableIds = new Set();
    for (const bucket of generation.canonicalBuckets.values()) {
      for (const stableId of bucket.mesh?.userData?.canonicalStableIds ?? []) {
        distantVisibleStableIds.add(stableId);
      }
    }
    const nearVisibleStableIds = generation.nearVisibleStableIds ?? new Set();
    const duplicates = [...distantVisibleStableIds]
      .filter(stableId => nearVisibleStableIds.has(stableId))
      .sort((left, right) => left.localeCompare(right));
    generation.stats.duplicateVisibleStableIds = Object.freeze(duplicates);
    generation.stats.duplicateVisibleStableIdCount = duplicates.length;
    generation.distantVisibleStableIds = distantVisibleStableIds;
    return Object.freeze({ buckets: composed, matrices: matrixUpdates });
  };

  const composeCanonicalBucket = (generation, bucket) => {
    const nearStableIds = generation.nearVisibleStableIds ?? new Set();
    const mesh = bucket.mesh;
    if (!mesh) return Object.freeze({ composed: 0, matrices: 0, attributes: 0 });
    if (isSettlementRoadBucket(bucket)) {
      const startedAt = monotonicNow();
      const activeItems = bucket.items.filter(item => {
        const opacity = canonicalInstanceOpacity(item.object, item);
        return ['mid', 'far'].includes(item.object.visibleLod)
          && !(item.object.remoteHorizon && nearStableIds.has(item.object.stableId))
          && opacity > 0;
      });
      replaceSettlementRoadBucketGeometry(
        bucket,
        bucket.resourceOwnerGeneration ?? generation,
        activeItems,
      );
      mesh.count = activeItems.length;
      mesh.userData.visibleInstanceCount = activeItems.length;
      mesh.userData.canonicalStableIds = activeItems.map(item => item.object.stableId);
      mesh.userData.canonicalObjects = activeItems.map(item => item.object.record);
      mesh.userData.canonicalOpacities = activeItems.map(item => (
        canonicalInstanceOpacity(item.object, item)
      ));
      mesh.userData.roadRibbon = mesh.geometry.userData?.roadRibbon ?? null;
      mesh.userData.roadRibbonHash = mesh.geometry.userData?.roadRibbonHash ?? null;
      mesh.userData.roadVisibilityDiagnostic =
        mesh.geometry.userData?.roadVisibilityDiagnostic ?? null;
      generation.stats.canonicalRoadMatrixComposeMs += monotonicNow() - startedAt;
      return Object.freeze({ composed: 1, matrices: 0, attributes: 2 });
    }
    if (generation.persistentDistant === true && bucket.persistent === true) {
      const hidden = hiddenCanonicalMatrix();
      const stableIds = [];
      const canonicalObjects = [];
      const canonicalOpacities = [];
      let visibleCount = 0;
      for (let slot = 0; slot < bucket.items.length; slot += 1) {
        const item = bucket.items[slot];
        if (!item) continue;
        item.slot = slot;
        const opacity = canonicalInstanceOpacity(item.object, item);
        const visible = ['mid', 'far'].includes(item.object.visibleLod)
          && !(item.object.remoteHorizon && nearStableIds.has(item.object.stableId))
          && opacity > 0;
        mesh.setMatrixAt(slot, visible ? item.matrix : hidden);
        writeRemoteBuildingAnchor(bucket, slot, item.object, generation);
        writeRemoteSourceColor(bucket, slot, item);
        writeNaturalAnchor(bucket, slot, item.object, generation);
        writeNaturalInitialReveal(bucket, slot, item.object, generation, item);
        writeLocalHandoffOpacity(bucket, slot, visible ? opacity : 0);
        stableIds[slot] = visible ? item.object.stableId : null;
        canonicalObjects[slot] = visible ? item.object.record : null;
        canonicalOpacities[slot] = visible ? opacity : 0;
        visibleCount += Number(visible);
      }
      mesh.count = isPersistentCoarseTreeBucket(bucket)
        ? (bucket.coarseTreeSubmittedCount ?? 0) : bucket.items.length;
      mesh.userData.canonicalStableIds = stableIds;
      mesh.userData.canonicalObjects = canonicalObjects;
      mesh.userData.canonicalOpacities = canonicalOpacities;
      mesh.userData.visibleInstanceCount = visibleCount;
      bucket.dirtySlots?.clear?.();
      finishRemoteBuildingAnchorWrite(bucket, mesh, canonicalObjects.filter(Boolean));
      finishNaturalAnchorWrite(bucket, mesh);
      finishNaturalInitialRevealWrite(bucket);
      finishLocalHandoffOpacityWrite(bucket);
      mesh.instanceMatrix.needsUpdate = true;
      return Object.freeze({
        composed: 1,
        matrices: bucket.items.length,
        attributes: Number(Boolean(mesh.instanceMatrix))
          + Number(Boolean(bucket.remoteAnchorAttribute))
          + Number(Boolean(bucket.remoteSourceColorAttribute))
          + Number(Boolean(bucket.naturalAnchorAttribute))
          + Number(Boolean(bucket.naturalInitialRevealAttribute))
          + Number(Boolean(bucket.localHandoffOpacityAttribute)),
      });
    }
    const roadBucketStartedAt = bucket.geometry === '__road__' ? monotonicNow() : null;
    let count = 0;
    const stableIds = [];
    const canonicalObjects = [];
    const canonicalOpacities = [];
    for (const item of bucket.items) {
      const opacity = canonicalInstanceOpacity(item.object, item);
      if (!['mid', 'far'].includes(item.object.visibleLod)
        || (item.object.remoteHorizon && nearStableIds.has(item.object.stableId))
        || !(opacity > 0)) continue;
      mesh.setMatrixAt(count, item.matrix);
      writeRemoteBuildingAnchor(bucket, count, item.object, generation);
      writeRemoteSourceColor(bucket, count, item);
      writeNaturalAnchor(bucket, count, item.object, generation);
      writeNaturalInitialReveal(bucket, count, item.object, generation, item);
      writeLocalHandoffOpacity(bucket, count, opacity);
      stableIds.push(item.object.stableId);
      canonicalObjects.push(item.object.record);
      canonicalOpacities.push(opacity);
      count += 1;
    }
    mesh.count = count;
    mesh.userData.canonicalStableIds = stableIds;
    mesh.userData.canonicalObjects = canonicalObjects;
    mesh.userData.canonicalOpacities = canonicalOpacities;
    finishRemoteBuildingAnchorWrite(bucket, mesh, canonicalObjects);
    finishNaturalAnchorWrite(bucket, mesh);
    finishNaturalInitialRevealWrite(bucket);
    finishLocalHandoffOpacityWrite(bucket);
    mesh.instanceMatrix.needsUpdate = true;
    if (roadBucketStartedAt !== null) {
      generation.stats.canonicalRoadMatrixComposeMs += monotonicNow() - roadBucketStartedAt;
    }
    return Object.freeze({
      composed: 1,
      matrices: count,
      attributes: Number(Boolean(mesh.instanceMatrix))
        + Number(Boolean(bucket.remoteAnchorAttribute))
        + Number(Boolean(bucket.remoteSourceColorAttribute))
        + Number(Boolean(bucket.naturalAnchorAttribute))
        + Number(Boolean(bucket.naturalInitialRevealAttribute))
        + Number(Boolean(bucket.localHandoffOpacityAttribute)),
    });
  };

  const activeSettlementRoadItems = (generation, bucket) => {
    const nearStableIds = generation.nearVisibleStableIds ?? new Set();
    return bucket.items.filter(item => {
      const opacity = canonicalInstanceOpacity(item.object, item);
      return ['mid', 'far'].includes(item.object.visibleLod)
        && !(item.object.remoteHorizon && nearStableIds.has(item.object.stableId))
        && opacity > 0;
    });
  };

  const settlementRoadWorkRemaining = work => {
    if (!work || work.done || work.cancelled) return 0;
    if (work.stage === 'initialize') return 2;
    if (work.stage === 'owners') {
      return Math.max(0, work.ownerEntries.length - work.ownerIndex) + 1;
    }
    return Number(work.stage === 'publish');
  };

  const discardSettlementRoadComposeWork = work => {
    if (!work || work.done || work.cancelled) return 0;
    const discarded = settlementRoadWorkRemaining(work);
    work.cancelled = true;
    roadPresentationSupersededDiscardCount += discarded;
    if (work.bucket?.pendingRoadComposeSequence === work.sequence) {
      work.bucket.pendingRoadComposeSequence = null;
    }
    return discarded;
  };

  const createSettlementRoadComposeWork = (generation, bucket) => {
    const work = {
      sequence: ++roadPresentationWorkSequence,
      generation,
      generationEpoch: generation?.epoch ?? null,
      bucket,
      bucketRevision: bucket.roadComposeRevision ?? 0,
      stage: 'initialize',
      activeItems: null,
      signature: null,
      ownerEntries: [],
      ownerIndex: 0,
      parts: [],
      createdFrame: roadPresentationFrameSequence,
      accumulatedMs: 0,
      statsCommitted: false,
      done: false,
      cancelled: false,
    };
    bucket.pendingRoadComposeSequence = work.sequence;
    roadPresentationMaximumQueueLength = Math.max(
      roadPresentationMaximumQueueLength,
      settlementRoadWorkRemaining(work),
    );
    return work;
  };

  const settlementRoadComposeWorkCurrent = work => (
    !work.cancelled
      && work.bucket?.pendingRoadComposeSequence === work.sequence
      && (work.bucket.roadComposeRevision ?? 0) === work.bucketRevision
      && (work.generation?.epoch ?? null) === work.generationEpoch
  );

  const initializeSettlementRoadComposeWork = work => {
    work.activeItems = activeSettlementRoadItems(work.generation, work.bucket);
    work.signature = work.activeItems.map(item => item.object.stableId).sort().join('\n');
    work.ownerEntries = settlementRoadOwnerEntries(work.activeItems);
    work.ownerIndex = 0;
    work.parts = [];
    work.stage = work.bucket.roadRibbonSignature === work.signature
      && work.bucket.mesh?.geometry ? 'publish' : 'owners';
    roadPresentationMaximumQueueLength = Math.max(
      roadPresentationMaximumQueueLength,
      settlementRoadWorkRemaining(work),
    );
  };

  const publishSettlementRoadComposeWork = work => {
    if (!settlementRoadComposeWorkCurrent(work)) return false;
    const { bucket, generation } = work;
    const previous = bucket.roadRibbonGeometry ?? null;
    let geometry = bucket.mesh?.geometry ?? previous;
    if (bucket.roadRibbonSignature !== work.signature || !geometry) {
      geometry = createSettlementRoadGeometryFromParts(
        work.parts,
        work.activeItems,
        generation,
      );
      if (!settlementRoadComposeWorkCurrent(work)) {
        roadPresentationOrphanGeometryCount += 1;
        disposeSettlementRoadGeometry(geometry, generation);
        return false;
      }
      bucket.roadRibbonGeometry = geometry;
      bucket.roadRibbonSignature = work.signature;
      if (bucket.mesh) bucket.mesh.geometry = geometry;
      if (previous && previous !== geometry) {
        disposeSettlementRoadGeometry(previous, generation);
      }
    }
    const mesh = bucket.mesh;
    mesh.count = work.activeItems.length;
    mesh.userData.visibleInstanceCount = work.activeItems.length;
    mesh.userData.canonicalStableIds = work.activeItems.map(item => item.object.stableId);
    mesh.userData.canonicalObjects = work.activeItems.map(item => item.object.record);
    mesh.userData.canonicalOpacities = work.activeItems.map(item => (
      canonicalInstanceOpacity(item.object, item)
    ));
    mesh.userData.roadRibbon = mesh.geometry.userData?.roadRibbon ?? null;
    mesh.userData.roadRibbonHash = mesh.geometry.userData?.roadRibbonHash ?? null;
    mesh.userData.roadVisibilityDiagnostic =
      mesh.geometry.userData?.roadVisibilityDiagnostic ?? null;
    work.done = true;
    work.stage = 'done';
    if (bucket.pendingRoadComposeSequence === work.sequence) {
      bucket.pendingRoadComposeSequence = null;
    }
    const waitFrames = Math.max(0, roadPresentationFrameSequence - work.createdFrame);
    roadPresentationMaximumWaitFrames = Math.max(
      roadPresentationMaximumWaitFrames,
      waitFrames,
    );
    if (waitFrames > ROAD_PRESENTATION_STARVATION_FRAMES) {
      roadPresentationStarvationCount += 1;
    }
    roadPresentationBucketComposeCount += 1;
    roadPresentationRecordComposeCount += work.activeItems.length;
    return true;
  };

  const advanceSettlementRoadComposeWork = (
    work,
    {
      budgetStartedAtMs = monotonicNow(),
      budgetMs = ROAD_PRESENTATION_FRAME_BUDGET_MS,
    } = {},
  ) => {
    presentationSchedulerRoadSlices += 1;
    const sliceStartedAt = monotonicNow();
    let units = 0;
    let published = false;
    if (!settlementRoadComposeWorkCurrent(work)) {
      discardSettlementRoadComposeWork(work);
      return Object.freeze({
        done: true,
        stale: true,
        matrices: 0,
        attributes: 0,
        bytes: 0,
      });
    }
    while (!work.done && !work.cancelled
      && (units === 0 || monotonicNow() - budgetStartedAtMs < budgetMs)) {
      const unitStartedAt = monotonicNow();
      if (work.stage === 'initialize') {
        initializeSettlementRoadComposeWork(work);
      } else if (work.stage === 'owners') {
        const entry = work.ownerEntries[work.ownerIndex];
        if (entry) {
          work.parts.push(buildSettlementRoadOwnerPart(entry[0], entry[1], work.generation));
          work.ownerIndex += 1;
          roadPresentationOwnerWorkCount += 1;
        }
        if (work.ownerIndex >= work.ownerEntries.length) work.stage = 'publish';
      } else if (work.stage === 'publish') {
        published = publishSettlementRoadComposeWork(work);
        if (!published) discardSettlementRoadComposeWork(work);
      }
      const unitMs = monotonicNow() - unitStartedAt;
      work.accumulatedMs += unitMs;
      if (work.done && !work.statsCommitted) {
        work.generation.stats.canonicalRoadMatrixComposeMs += work.accumulatedMs;
        work.statsCommitted = true;
      }
      roadPresentationMaximumUnitMs = Math.max(roadPresentationMaximumUnitMs, unitMs);
      units += 1;
    }
    const durationMs = monotonicNow() - sliceStartedAt;
    roadPresentationMaximumSliceMs = Math.max(roadPresentationMaximumSliceMs, durationMs);
    roadPresentationMaximumQueueLength = Math.max(
      roadPresentationMaximumQueueLength,
      settlementRoadWorkRemaining(work),
    );
    return Object.freeze({
      done: work.done || work.cancelled,
      stale: work.cancelled && !work.done,
      matrices: 0,
      attributes: published ? 2 : 0,
      bytes: published ? Number(work.bucket.mesh?.geometry?.userData
        ?.roadRibbon?.uploadBytes ?? 0) : 0,
    });
  };

  const createCanonicalBucketComposeWork = (generation, bucket) => ({
    generation,
    bucket,
    roadWork: isSettlementRoadBucket(bucket)
      ? createSettlementRoadComposeWork(generation, bucket) : null,
    slots: generation.persistentDistant === true && bucket.persistent === true
      ? [...(bucket.dirtySlots ?? [])].sort((left, right) => left - right)
      : null,
    index: 0,
    count: 0,
    stableIds: [],
    canonicalObjects: [],
    canonicalOpacities: [],
    matrices: 0,
    startedAtMs: monotonicNow(),
  });

  const advanceCanonicalBucketComposeWork = (
    work,
    {
      budgetStartedAtMs,
      budgetMs = RUNTIME_PRESENTATION_FRAME_BUDGET_MS,
      unitLimit = PRESENTATION_SLICE_UNIT_LIMIT,
    } = {},
  ) => {
    const { generation, bucket } = work;
    const mesh = bucket.mesh;
    if (!mesh) return Object.freeze({ done: true, matrices: 0, attributes: 0 });
    if (work.roadWork) {
      return advanceSettlementRoadComposeWork(work.roadWork, {
        budgetStartedAtMs,
        budgetMs: Math.min(budgetMs, ROAD_PRESENTATION_FRAME_BUDGET_MS),
      });
    }
    const nearStableIds = generation.nearVisibleStableIds ?? new Set();
    let frameMatrices = 0;
    let units = 0;
    if (work.slots) {
      const hidden = hiddenCanonicalMatrix();
      const processedSlots = [];
      while (work.index < work.slots.length
        && units < unitLimit
        && (units === 0 || monotonicNow() - budgetStartedAtMs < budgetMs)) {
        const slot = work.slots[work.index];
        const item = bucket.items[slot] ?? null;
        const opacity = item ? canonicalInstanceOpacity(item.object, item) : 0;
        const visible = item && ['mid', 'far'].includes(item.object.visibleLod)
          && !(item.object.remoteHorizon && nearStableIds.has(item.object.stableId))
          && opacity > 0;
        mesh.setMatrixAt(slot, visible ? item.matrix : hidden);
        if (item) {
          writeRemoteBuildingAnchor(bucket, slot, item.object, generation);
          writeRemoteSourceColor(bucket, slot, item);
          writeNaturalAnchor(bucket, slot, item.object, generation);
          writeNaturalInitialReveal(bucket, slot, item.object, generation, item);
          writeLocalHandoffOpacity(bucket, slot, visible ? opacity : 0);
        }
        mesh.userData.canonicalStableIds[slot] = visible ? item.object.stableId : null;
        mesh.userData.canonicalObjects[slot] = visible ? item.object.record : null;
        mesh.userData.canonicalOpacities[slot] = visible ? opacity : 0;
        bucket.dirtySlots.delete(slot);
        processedSlots.push(slot);
        work.index += 1;
        work.matrices += 1;
        frameMatrices += 1;
        units += 1;
      }
      mesh.count = isPersistentCoarseTreeBucket(bucket)
        ? (bucket.coarseTreeSubmittedCount ?? 0) : bucket.items.length;
      const matrixUpload = markAttributeRanges(mesh.instanceMatrix, processedSlots, 16);
      const remoteUpload = markAttributeRanges(bucket.remoteAnchorAttribute, processedSlots, 2);
      const remoteColorUpload = markAttributeRanges(
        bucket.remoteSourceColorAttribute,
        processedSlots,
        3,
      );
      const anchorUpload = markAttributeRanges(bucket.naturalAnchorAttribute, processedSlots, 2);
      const revealUpload = markAttributeRanges(
        bucket.naturalInitialRevealAttribute,
        processedSlots,
        1,
      );
      const localHandoffUpload = markAttributeRanges(
        bucket.localHandoffOpacityAttribute,
        processedSlots,
        1,
      );
      const bufferUploads = [
        matrixUpload,
        remoteUpload,
        remoteColorUpload,
        anchorUpload,
        revealUpload,
        localHandoffUpload,
      ]
        .filter(Boolean);
      const bytes = bufferUploads.reduce((sum, upload) => sum + upload.byteCount, 0);
      if (bytes > DISTANT_PERSISTENT_UPLOAD_BUDGET_BYTES) {
        distantPersistentOverBudgetUploadCount += 1;
        throw new RangeError('persistent Distant visibility upload exceeds frame budget');
      }
      if (processedSlots.length) {
        mesh.boundingBox = null;
        mesh.boundingSphere = null;
        distantPersistentBoundsRecalculationCount += 1;
        if (typeof mesh.computeBoundingSphere === 'function') {
          mesh.computeBoundingSphere();
        }
        distantPersistentUploadByteCount += bytes;
        distantPersistentMaximumUploadBytesPerFrame = Math.max(
          distantPersistentMaximumUploadBytesPerFrame,
          bytes,
        );
      }
      return Object.freeze({
        done: work.index >= work.slots.length,
        matrices: frameMatrices,
        attributes: bufferUploads.length,
        bytes,
      });
    }
    while (work.index < bucket.items.length
      && units < unitLimit
      && (units === 0 || monotonicNow() - budgetStartedAtMs < budgetMs)) {
      const item = bucket.items[work.index];
      const opacity = canonicalInstanceOpacity(item.object, item);
      if (['mid', 'far'].includes(item.object.visibleLod)
        && !(item.object.remoteHorizon && nearStableIds.has(item.object.stableId))
        && opacity > 0) {
        mesh.setMatrixAt(work.count, item.matrix);
        writeRemoteBuildingAnchor(bucket, work.count, item.object, generation);
        writeRemoteSourceColor(bucket, work.count, item);
        writeNaturalAnchor(bucket, work.count, item.object, generation);
        writeNaturalInitialReveal(bucket, work.count, item.object, generation, item);
        writeLocalHandoffOpacity(bucket, work.count, opacity);
        work.stableIds.push(item.object.stableId);
        work.canonicalObjects.push(item.object.record);
        work.canonicalOpacities.push(opacity);
        work.count += 1;
        work.matrices += 1;
        frameMatrices += 1;
      }
      work.index += 1;
      units += 1;
    }
    if (work.index < bucket.items.length) {
      return Object.freeze({ done: false, matrices: frameMatrices, attributes: 0 });
    }
    mesh.count = work.count;
    mesh.userData.canonicalStableIds = work.stableIds;
    mesh.userData.canonicalObjects = work.canonicalObjects;
    mesh.userData.canonicalOpacities = work.canonicalOpacities;
    finishRemoteBuildingAnchorWrite(bucket, mesh, work.canonicalObjects);
    finishNaturalAnchorWrite(bucket, mesh);
    finishNaturalInitialRevealWrite(bucket);
    finishLocalHandoffOpacityWrite(bucket);
    mesh.instanceMatrix.needsUpdate = true;
    if (bucket.geometry === '__road__') {
      generation.stats.canonicalRoadMatrixComposeMs += monotonicNow() - work.startedAtMs;
    }
    return Object.freeze({
      done: true,
      matrices: frameMatrices,
      attributes: Number(Boolean(mesh.instanceMatrix))
        + Number(Boolean(bucket.remoteAnchorAttribute))
        + Number(Boolean(bucket.remoteSourceColorAttribute))
        + Number(Boolean(bucket.naturalAnchorAttribute))
        + Number(Boolean(bucket.naturalInitialRevealAttribute))
        + Number(Boolean(bucket.localHandoffOpacityAttribute)),
    });
  };

  const composeCanonicalMeshes = (generation, dirtyBuckets = generation.canonicalBuckets) => {
    let composed = 0;
    let matrixUpdates = 0;
    for (const bucket of dirtyBuckets.values()) {
      const result = composeCanonicalBucket(generation, bucket);
      composed += result.composed;
      matrixUpdates += result.matrices;
    }
    return finishCanonicalCompose(generation, composed, matrixUpdates);
  };

  const processPersistentDistantVisibility = (generation, budgetMs) => {
    if (!generation?.persistentDistant || !(budgetMs > 0)) return null;
    const bucket = [...generation.canonicalBuckets.values()].find(candidate => (
      candidate.persistent === true && candidate.mesh && candidate.dirtySlots?.size > 0
    ));
    if (!bucket) return null;
    const startedAt = monotonicNow();
    const work = createCanonicalBucketComposeWork(generation, bucket);
    const result = advanceCanonicalBucketComposeWork(work, {
      budgetStartedAtMs: startedAt,
      budgetMs,
      unitLimit: PRESENTATION_SLICE_UNIT_LIMIT,
    });
    finishCanonicalCompose(generation, Number(result.matrices > 0), result.matrices);
    distantPersistentMaximumSliceMs = Math.max(
      distantPersistentMaximumSliceMs,
      monotonicNow() - startedAt,
    );
    return result;
  };

  const composeCanonicalMeshesIncrementally = async (
    generation,
    dirtyBuckets,
    scheduler,
  ) => {
    let composed = 0;
    let matrixUpdates = 0;
    const nearStableIds = generation.nearVisibleStableIds ?? new Set();
    for (const bucket of dirtyBuckets.values()) {
      const mesh = bucket.mesh;
      if (!mesh) continue;
      if (isSettlementRoadBucket(bucket)) {
        const startedAt = monotonicNow();
        const activeItems = bucket.items.filter(item => {
          const opacity = canonicalInstanceOpacity(item.object, item);
          return ['mid', 'far'].includes(item.object.visibleLod)
            && !(item.object.remoteHorizon && nearStableIds.has(item.object.stableId))
            && opacity > 0;
        });
        replaceSettlementRoadBucketGeometry(
          bucket,
          bucket.resourceOwnerGeneration ?? generation,
          activeItems,
        );
        mesh.count = activeItems.length;
        mesh.userData.visibleInstanceCount = activeItems.length;
        mesh.userData.canonicalStableIds = activeItems.map(item => item.object.stableId);
        mesh.userData.canonicalObjects = activeItems.map(item => item.object.record);
        mesh.userData.canonicalOpacities = activeItems.map(item => (
          canonicalInstanceOpacity(item.object, item)
        ));
        mesh.userData.roadRibbon = mesh.geometry.userData?.roadRibbon ?? null;
        mesh.userData.roadRibbonHash = mesh.geometry.userData?.roadRibbonHash ?? null;
        mesh.userData.roadVisibilityDiagnostic =
          mesh.geometry.userData?.roadVisibilityDiagnostic ?? null;
        generation.stats.canonicalRoadMatrixComposeMs += monotonicNow() - startedAt;
        composed += 1;
        const pendingYield = scheduler.checkpoint();
        if (pendingYield) await pendingYield;
        continue;
      }
      if (generation.persistentDistant === true && bucket.persistent === true) {
        const hidden = hiddenCanonicalMatrix();
        const stableIds = [];
        const canonicalObjects = [];
        const canonicalOpacities = [];
        let visibleCount = 0;
        for (let slot = 0; slot < bucket.items.length; slot += 1) {
          const item = bucket.items[slot];
          if (!item) continue;
          item.slot = slot;
          const opacity = canonicalInstanceOpacity(item.object, item);
          const visible = ['mid', 'far'].includes(item.object.visibleLod)
            && !(item.object.remoteHorizon && nearStableIds.has(item.object.stableId))
            && opacity > 0;
          mesh.setMatrixAt(slot, visible ? item.matrix : hidden);
          writeRemoteBuildingAnchor(bucket, slot, item.object, generation);
          writeRemoteSourceColor(bucket, slot, item);
          writeNaturalAnchor(bucket, slot, item.object, generation);
          writeNaturalInitialReveal(bucket, slot, item.object, generation, item);
          writeLocalHandoffOpacity(bucket, slot, visible ? opacity : 0);
          stableIds[slot] = visible ? item.object.stableId : null;
          canonicalObjects[slot] = visible ? item.object.record : null;
          canonicalOpacities[slot] = visible ? opacity : 0;
          visibleCount += Number(visible);
          matrixUpdates += 1;
          const pendingYield = scheduler.checkpoint();
          if (pendingYield) await pendingYield;
        }
        mesh.count = isPersistentCoarseTreeBucket(bucket)
          ? (bucket.coarseTreeSubmittedCount ?? 0) : bucket.items.length;
        mesh.userData.canonicalStableIds = stableIds;
        mesh.userData.canonicalObjects = canonicalObjects;
        mesh.userData.canonicalOpacities = canonicalOpacities;
        mesh.userData.visibleInstanceCount = visibleCount;
        bucket.dirtySlots?.clear?.();
        finishRemoteBuildingAnchorWrite(bucket, mesh, canonicalObjects.filter(Boolean));
        finishNaturalAnchorWrite(bucket, mesh);
        finishNaturalInitialRevealWrite(bucket);
        finishLocalHandoffOpacityWrite(bucket);
        mesh.instanceMatrix.needsUpdate = true;
        composed += 1;
        const pendingYield = scheduler.checkpoint();
        if (pendingYield) await pendingYield;
        continue;
      }
      const roadBucketStartedAt = bucket.geometry === '__road__' ? monotonicNow() : null;
      let count = 0;
      const stableIds = [];
      const canonicalObjects = [];
      const canonicalOpacities = [];
      for (const item of bucket.items) {
        const opacity = canonicalInstanceOpacity(item.object, item);
        if (['mid', 'far'].includes(item.object.visibleLod)
          && !(item.object.remoteHorizon && nearStableIds.has(item.object.stableId))
          && opacity > 0) {
          mesh.setMatrixAt(count, item.matrix);
          writeRemoteBuildingAnchor(bucket, count, item.object, generation);
          writeRemoteSourceColor(bucket, count, item);
          writeNaturalAnchor(bucket, count, item.object, generation);
          writeNaturalInitialReveal(bucket, count, item.object, generation, item);
          writeLocalHandoffOpacity(bucket, count, opacity);
          matrixUpdates += 1;
          stableIds.push(item.object.stableId);
          canonicalObjects.push(item.object.record);
          canonicalOpacities.push(opacity);
          count += 1;
        }
        const pendingYield = scheduler.checkpoint();
        if (pendingYield) await pendingYield;
      }
      mesh.count = count;
      mesh.userData.canonicalStableIds = stableIds;
      mesh.userData.canonicalObjects = canonicalObjects;
      mesh.userData.canonicalOpacities = canonicalOpacities;
      finishRemoteBuildingAnchorWrite(bucket, mesh, canonicalObjects);
      finishNaturalAnchorWrite(bucket, mesh);
      finishNaturalInitialRevealWrite(bucket);
      finishLocalHandoffOpacityWrite(bucket);
      mesh.instanceMatrix.needsUpdate = true;
      if (roadBucketStartedAt !== null) {
        generation.stats.canonicalRoadMatrixComposeMs += monotonicNow() - roadBucketStartedAt;
      }
      composed += 1;
      const pendingYield = scheduler.checkpoint();
      if (pendingYield) await pendingYield;
    }
    return finishCanonicalCompose(generation, composed, matrixUpdates);
  };

  const sortedKeyList = values => [...values].sort((left, right) => left.localeCompare(right));
  const equalKeySets = (left, right) => left.size === right.size
    && [...left].every(key => right.has(key));

  const updateTreeLodDiagnosticRing = generation => {
    const diagnostic = generation.treeLodDiagnostics;
    if (!diagnostic?.ringGeometry) return;
    const originX = generation.buildOriginChunkX * LOGICAL_CHUNK_SIZE_METERS;
    const originZ = generation.buildOriginChunkZ * LOGICAL_CHUNK_SIZE_METERS;
    const positions = [];
    const segmentCount = 64;
    for (let index = 0; index < segmentCount; index += 1) {
      const firstAngle = index / segmentCount * Math.PI * 2;
      const secondAngle = (index + 1) / segmentCount * Math.PI * 2;
      for (const angle of [firstAngle, secondAngle]) {
        const ringMeters = resolveW8VegetationLodPolicy(
          W8_VEGETATION_LOD_KINDS.TREE,
          generation.renderDistancePreset,
        ).atmosphericFade.maximum;
        const worldX = generation.playerX + Math.cos(angle) * ringMeters;
        const worldZ = generation.playerZ + Math.sin(angle) * ringMeters;
        positions.push(
          (worldX - originX) * UNITS_PER_METER,
          (baseClipmapSample(worldX, worldZ, generation.surfacePolicy).height + 0.18)
            * UNITS_PER_METER,
          (worldZ - originZ) * UNITS_PER_METER,
        );
      }
    }
    diagnostic.ringGeometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(positions, 3),
    );
    const position = diagnostic.ringGeometry.getAttribute?.('position')
      ?? diagnostic.ringGeometry.attributes?.position;
    if (position) position.needsUpdate = true;
  };

  const updateTreeLodDiagnostics = generation => {
    const diagnostic = generation.treeLodDiagnostics;
    if (!diagnostic) return;
    diagnostic.root.visible = treeLodDiagnosticsEnabled;
    if (!treeLodDiagnosticsEnabled) return;
    for (const entry of diagnostic.entries) {
      const counts = new Map(entry.overlays.map(overlay => [overlay.tier, 0]));
      for (const item of entry.bucket.items) {
        if (!['mid', 'far'].includes(item.object.visibleLod)
          || item.object.presentationTier !== 'natural-lod') continue;
        const tier = item.object.naturalBlend?.dominantTier;
        const overlay = entry.overlays.find(value => value.tier === tier);
        if (!overlay) continue;
        const count = counts.get(tier);
        overlay.mesh.setMatrixAt(count, item.matrix);
        counts.set(tier, count + 1);
      }
      for (const overlay of entry.overlays) {
        overlay.mesh.count = counts.get(overlay.tier);
        overlay.mesh.instanceMatrix.needsUpdate = true;
      }
    }
    updateTreeLodDiagnosticRing(generation);
  };

  const createTreeLodDiagnostics = generation => {
    if (generation.treeLodDiagnostics || !treeLodDiagnosticsEnabled) return;
    if (typeof THREE.LineSegments !== 'function' || typeof THREE.LineBasicMaterial !== 'function') return;
    const BufferGeometry = requireConstructor(THREE, 'BufferGeometry');
    const LineSegments = requireConstructor(THREE, 'LineSegments');
    const DiagnosticMaterial = typeof THREE.MeshBasicMaterial === 'function'
      ? THREE.MeshBasicMaterial : Material;
    const rootDiagnostic = new Group();
    rootDiagnostic.name = 'w8-tree-lod-diagnostics';
    rootDiagnostic.userData = { presentationOnly: true, debugOnly: true };
    const entries = [];
    for (const bucket of generation.canonicalBuckets.values()) {
      if (bucket.name !== 'natural-forest-tree' || !bucket.mesh) continue;
      const overlays = [
        Object.freeze({ tier: 'full', color: 0xffe600, renderOrder: 10_000 }),
        Object.freeze({ tier: 'forest', color: 0x168bff, renderOrder: 10_001 }),
        Object.freeze({ tier: 'atmospheric', color: 0xb269ff, renderOrder: 10_002 }),
      ].map(({ tier, color, renderOrder }) => {
        const material = new DiagnosticMaterial({
          color, transparent: true, opacity: 0.94, depthTest: false, depthWrite: false,
        });
        const mesh = new InstancedMesh(bucket.mesh.geometry, material, bucket.items.length);
        mesh.name = `w8-tree-lod-debug-${tier}-${bucket.geometry}`;
        mesh.userData = { presentationOnly: true, debugOnly: true, treeLodTier: tier };
        mesh.renderOrder = renderOrder;
        mesh.frustumCulled = false;
        rootDiagnostic.add(mesh);
        generation.ownedMaterials.add(material);
        return { tier, mesh };
      });
      entries.push({ bucket, overlays });
    }
    const ringGeometry = new BufferGeometry();
    const ringMaterial = new THREE.LineBasicMaterial({
      color: 0x28d7ff, transparent: true, opacity: 1, depthTest: false, depthWrite: false,
    });
    const ring = new LineSegments(ringGeometry, ringMaterial);
    const ringMeters = resolveW8VegetationLodPolicy(
      W8_VEGETATION_LOD_KINDS.TREE,
      generation.renderDistancePreset,
    ).atmosphericFade.maximum;
    ring.name = 'w8-tree-lod-debug-atmospheric-fade-ring';
    ring.userData = {
      presentationOnly: true,
      debugOnly: true,
      radiusMeters: ringMeters,
    };
    ring.renderOrder = 10_003;
    ring.frustumCulled = false;
    rootDiagnostic.add(ring);
    generation.ownedGeometries.add(ringGeometry);
    generation.ownedMaterials.add(ringMaterial);
    generation.root.add(rootDiagnostic);
    generation.treeLodDiagnostics = { root: rootDiagnostic, entries, ringGeometry };
    updateTreeLodDiagnostics(generation);
  };

  const disposeTreeLodDiagnostics = generation => {
    const diagnostic = generation?.treeLodDiagnostics;
    if (!diagnostic) return;
    generation.root.remove(diagnostic.root);
    for (const entry of diagnostic.entries) {
      for (const overlay of entry.overlays) {
        overlay.mesh.material?.dispose?.();
        generation.ownedMaterials.delete(overlay.mesh.material);
      }
    }
    const ring = diagnostic.root.children?.find?.(child => (
      child.name === 'w8-tree-lod-debug-atmospheric-fade-ring'
    ));
    ring?.material?.dispose?.();
    generation.ownedMaterials.delete(ring?.material);
    diagnostic.ringGeometry.dispose?.();
    generation.ownedGeometries.delete(diagnostic.ringGeometry);
    diagnostic.root.clear?.();
    generation.treeLodDiagnostics = null;
  };

  const canonicalSettlementPresentationTier = (
    object,
    distanceMeters,
    quality,
    visible,
    localSettlementIds,
    settlementLod,
  ) => {
    if (!visible) return null;
    if (!isHorizonRecord(object.record)) return 'full';
    if (!localSettlementIds?.has(object.settlementId)) return 'full';
    if (distanceMeters >= settlementLod.visibilityMeters) return null;
    if (distanceMeters >= settlementLod.fadeStartMeters) {
      const fade = 1 - smoothstep((distanceMeters - settlementLod.fadeStartMeters)
        / (settlementLod.visibilityMeters - settlementLod.fadeStartMeters));
      const ditherRank = textHash(`${object.stableId}:w8-high-building-horizon-fade`) / 0x1_0000_0000;
      if (!(ditherRank < fade)) return null;
    }
    const horizonOpacity = resolveW8SettlementHandoffProgress(distanceMeters, settlementLod);
    object.localBuildingHandoff = object.record.featureType === 'settlement-building';
    object.fullPresentationOpacity = Math.round((1 - horizonOpacity) * 1e6) / 1e6;
    object.horizonPresentationOpacity = horizonOpacity;
    if (horizonOpacity <= 0) return 'full';
    if (object.fullPresentationOpacity <= 0) return 'horizon';
    return 'full-horizon-handoff';
  };

  const remoteSettlementPresentationTier = (
    object,
    buildingDistanceMeters,
    policy,
    visible,
  ) => {
    if (!visible || !object.remoteHorizon) {
      object.remotePresentationOpacity = 0;
      return null;
    }
    object.remotePresentationOpacity = resolveW8RemoteSettlementOpacityAtDistance(
      buildingDistanceMeters,
      policy,
    );
    if (object.remotePresentationOpacity <= 0) {
      return null;
    }
    return 'remote-horizon';
  };

  const canonicalBucketVisibilityKey = bucket => (
    `${bucket.name}:${bucket.geometry}:${bucket.material}`
  );

  const updateRemoteHorizonPlayerUniform = (generation, playerX, playerZ) => {
    const playerUniform = generation.remoteHorizonSilhouetteMaterial
      ?.userData?.remoteAtmosphereUniforms?.w8RemotePlayerLocalXZ?.value;
    if (!playerUniform) return;
    playerUniform.x = (
      playerX - generation.buildOriginChunkX * LOGICAL_CHUNK_SIZE_METERS
    ) * UNITS_PER_METER;
    playerUniform.y = (
      playerZ - generation.buildOriginChunkZ * LOGICAL_CHUNK_SIZE_METERS
    ) * UNITS_PER_METER;
  };

  const updateNaturalLodPlayerUniforms = (generation, playerX, playerZ) => {
    const localX = (
      playerX - generation.buildOriginChunkX * LOGICAL_CHUNK_SIZE_METERS
    ) * UNITS_PER_METER;
    const localZ = (
      playerZ - generation.buildOriginChunkZ * LOGICAL_CHUNK_SIZE_METERS
    ) * UNITS_PER_METER;
    if (generation.naturalReveal < 1 && generation.naturalRevealStartedAt !== null) {
      generation.naturalReveal = smoothstep(
        (monotonicNow() - generation.naturalRevealStartedAt) / NATURAL_STREAM_REVEAL_MS,
      );
    }
    for (const material of new Set(generation.naturalLodMaterials?.values?.() ?? [])) {
      const playerUniform = material.userData?.naturalLodUniforms
        ?.w8NaturalPlayerLocalXZ?.value;
      if (!playerUniform) continue;
      playerUniform.x = localX;
      playerUniform.y = localZ;
      material.userData.naturalLodUniforms.w8NaturalReveal.value = generation.naturalReveal;
      material.userData.naturalLodUniforms.w8NaturalTimeMs.value = monotonicNow();
    }
  };

  const naturalLodPolicyFor = (generation, kind) => {
    const cached = generation.naturalLodPolicies.get(kind);
    if (cached) return cached;
    const policy = resolveW8VegetationLodPolicy(kind, generation.renderDistancePreset);
    generation.naturalLodPolicies.set(kind, policy);
    return policy;
  };

  const applyCanonicalFarTreeDensity = (object, policy, distanceMeters, blend) => {
    if (object.naturalKind !== W8_VEGETATION_LOD_KINDS.TREE || !policy.farDensity) {
      return blend;
    }
    const densityRank = object.canonicalCoarseTreeDensityRank
      ?? object.canonicalFarTreeDensityRank;
    if (object.canonicalCoarseTree === true) {
      const outerFade = {
        minimum: PRESENTATION_OWNER_COARSE_VISIBILITY_METERS
          - PRESENTATION_OWNER_COARSE_FADE_METERS,
        maximum: PRESENTATION_OWNER_COARSE_VISIBILITY_METERS,
      };
      const distanceOpacity = distanceMeters <= outerFade.minimum
        ? 1
        : distanceMeters >= outerFade.maximum
          ? 0
          : 1 - smoothstep(
            (distanceMeters - outerFade.minimum)
              / Math.max(0.0001, outerFade.maximum - outerFade.minimum),
          );
      blend.full = 0;
      blend.forest = Math.round(distanceOpacity * 1e6) / 1e6;
      blend.atmospheric = 0;
      blend.far = 0;
    }
    blend.totalOpacity = Math.round((
      blend.full + blend.forest + blend.atmospheric + blend.far
    ) * 1e6) / 1e6;
    blend.dominantTier = null;
    if (blend.totalOpacity > 0) {
      if (blend.far > blend.atmospheric
        && blend.far >= blend.forest && blend.far >= blend.full) {
        blend.dominantTier = 'far';
      } else if (blend.atmospheric >= blend.forest && blend.atmospheric >= blend.full) {
        blend.dominantTier = 'atmospheric';
      } else if (blend.forest >= blend.full) {
        blend.dominantTier = 'forest';
      } else {
        blend.dominantTier = 'full';
      }
    }
    blend.crossFade = Number(blend.full > 0) + Number(blend.forest > 0)
      + Number(blend.atmospheric > 0) + Number(blend.far > 0) > 1;
    blend.visible = blend.totalOpacity > 0 && distanceMeters <= policy.visibilityMeters;
    blend.canonicalFarDensityRank = densityRank;
    blend.canonicalFarDensityThreshold = W8_CANONICAL_TREE_WORLD_DENSITY_THRESHOLD;
    blend.canonicalFarDensityOpacity = 1;
    blend.canonicalFarDensitySelected = Number.isFinite(densityRank)
      && densityRank < W8_CANONICAL_TREE_WORLD_DENSITY_THRESHOLD;
    return blend;
  };

  const evaluatePersistentNaturalVisibility = (
    generation,
    object,
    playerX,
    playerZ,
    nearVisibleStableIds,
  ) => {
    const distanceMeters = Math.hypot(object.worldX - playerX, object.worldZ - playerZ);
    const naturalKind = object.naturalKind;
    const natural = naturalKind !== null;
    const tree = naturalKind === W8_VEGETATION_LOD_KINDS.TREE;
    const bush = naturalKind === W8_VEGETATION_LOD_KINDS.BUSH;
    const grass = naturalKind === W8_VEGETATION_LOD_KINDS.GRASS;
    const rock = naturalKind === W8_VEGETATION_LOD_KINDS.ROCK;
    if (!natural) {
      const road = object.record.featureType === 'settlement-road';
      const structure = object.record.featureType === 'settlement-building' || road;
      const nearStableIdDrawable = nearVisibleStableIds.has(object.stableId);
      const visibilityMeters = road
        ? (generation.renderDistancePolicy
          ?? resolveW8RenderDistancePolicy(generation.renderDistancePreset))
          .worldPresentationDistanceMeters
        : structure
          ? PRESENTATION_OWNER_COARSE_VISIBILITY_METERS
        : object.record.lodPolicy
          ? resolveW8ObjectVisibilityMeters(object.record, generation.renderDistancePreset)
          : generation.renderDistancePolicy.generalDetailDistanceMeters;
      let nextLod = 'hidden';
      if (object.destructible && isFeatureDestroyed(object.stableId)) {
        nextLod = 'destroyed';
      } else if (nearStableIdDrawable) {
        nextLod = 'near';
      } else if (structure && distanceMeters <= visibilityMeters) {
        if (generation.activeKeys.has(object.ownerKey)) nextLod = 'mid';
        else if (object.farEligible) nextLod = 'far';
      }
      const distantVisible = nextLod === 'far' || nextLod === 'mid';
      return {
        nextLod,
        presentationTier: distantVisible ? 'full' : null,
        natural: false,
        naturalBlend: null,
        naturalLodPolicy: null,
        distanceMeters,
        distantVisible,
        tree: false,
        bush: false,
        grass: false,
        rock: false,
      };
    }
    const naturalLodPolicy = object.persistentNaturalLodPolicy
      ?? (object.persistentNaturalLodPolicy = naturalLodPolicyFor(generation, naturalKind));
    const exactNaturalVisibility = Number.isFinite(
      object.persistentNaturalExactVisibilityMeters,
    ) ? object.persistentNaturalExactVisibilityMeters : (
        object.persistentNaturalExactVisibilityMeters = Math.min(
          object.record.lodPolicy
            ? resolveW8ObjectVisibilityMeters(
              object.record,
              generation.renderDistancePreset,
            )
            : (generation.renderDistancePolicy
              ?? resolveW8RenderDistancePolicy(generation.renderDistancePreset))
              .naturalDetailDistanceMeters,
          naturalLodPolicy.visibilityMeters,
        )
      );
    const objectNaturalVisibility = Number.isFinite(
      object.persistentNaturalVisibilityMeters,
    ) ? object.persistentNaturalVisibilityMeters : (
        object.persistentNaturalVisibilityMeters = naturalLodPolicy.visibilityMeters
      );
    const hasLocalPresentation = object.persistentNaturalHasLocalPresentation
      ?? object.instances.some(instance => (
        instance.item.visibilityTiers.includes('full')
          || instance.item.visibilityTiers.includes('natural-lod')
      ));
    const nearStableIdDrawable = nearVisibleStableIds.has(object.stableId);
    const ownerIsNear = hasLocalPresentation && generation.renderedKeys.has(object.ownerKey);
    let nextLod = 'hidden';
    if (object.destructible && isFeatureDestroyed(object.stableId)) {
      nextLod = 'destroyed';
    } else if (nearStableIdDrawable
      || (!tree && ownerIsNear && object.canonicalCoarseNatural !== true)) {
      nextLod = 'near';
    } else if (hasLocalPresentation && generation.activeKeys.has(object.ownerKey)
      && object.record.lodPolicy?.outer !== null) {
      nextLod = 'mid';
    } else if (hasLocalPresentation && object.farEligible
      && object.record.lodPolicy?.far !== null) {
      nextLod = 'far';
    }
    const distantVisible = nextLod === 'far' || nextLod === 'mid';
    const naturalBlend = applyCanonicalFarTreeDensity(
      object,
      naturalLodPolicy,
      distanceMeters,
      evaluateW8VegetationLodBlend(
        naturalLodPolicy,
        distanceMeters,
        object.naturalBlend ?? {},
      ),
    );
    // Distance LOD and visibility are continuous GPU policy. CPU visibility is
    // now changed only by owner/Near/destruction events, so exact player X/Z
    // motion cannot restart an all-object scan or blank an entering instance.
    let presentationTier = distantVisible ? 'natural-lod' : null;
    if (nextLod === 'near') {
      presentationTier = nearStableIdDrawable || object.record.lodPolicy?.outer === null
        ? null : 'full';
    }
    return {
      nextLod,
      presentationTier,
      natural: true,
      naturalBlend,
      naturalLodPolicy,
      distanceMeters,
      distantVisible: nextLod === 'far' || nextLod === 'mid',
      tree,
      bush,
      grass,
      rock,
    };
  };

  const assignPersistentNaturalVisibilityState = (object, state, sequence) => {
    const changed = object.visibleLod !== state.nextLod
      || object.presentationTier !== state.presentationTier;
    object.localBuildingHandoff = false;
    if (state.nextLod === 'near') {
      object.fullPresentationOpacity = state.presentationTier ? 1 : 0;
      object.horizonPresentationOpacity = 0;
      object.remotePresentationOpacity = 0;
    } else {
      object.remotePresentationOpacity = 0;
    }
    object.naturalBlend = state.naturalBlend;
    object.visibleLod = state.nextLod;
    object.presentationTier = state.presentationTier;
    object.visibilitySequence = sequence;
    return changed;
  };

  const applyPersistentNaturalVisibility = (generation, object, state, sequence) => {
    const changed = assignPersistentNaturalVisibilityState(object, state, sequence);
    if (!changed) return false;
    if (state.tree && generation.coarseFirstNatural === true) {
      for (const instance of object.instances) {
        if (!isPersistentCoarseTreeBucket(instance.bucket)) continue;
        setPersistentCoarseTreeItemSubmitted(
          instance.bucket,
          instance.item,
          persistentCoarseTreeItemShouldSubmit(
            generation,
            instance.item,
            generation.playerX,
            generation.playerZ,
          ),
        );
      }
    }
    for (const instance of object.instances) {
      if (instance.bucket.persistent === true && Number.isSafeInteger(instance.item.slot)) {
        instance.bucket.dirtySlots ??= new Set();
        instance.bucket.dirtySlots.add(instance.item.slot);
      }
    }
    if (state.tree) {
      generation.treeVisibilityChangeCount = (generation.treeVisibilityChangeCount ?? 0) + 1;
    }
    return true;
  };

  const isPersistentCoarseTreeBucket = bucket => {
    const naturalLod = bucket?.naturalLod ?? parseNaturalLodBucket(bucket);
    return ['forest', 'far'].includes(naturalLod?.mode)
      && naturalLod.kind === W8_VEGETATION_LOD_KINDS.TREE
      && bucket?.items?.some?.(item => item.object?.canonicalCoarseTree === true) === true;
  };

  const swapPersistentCoarseTreeItems = (bucket, leftSlot, rightSlot) => {
    if (leftSlot === rightSlot) return false;
    const left = bucket.items[leftSlot];
    const right = bucket.items[rightSlot];
    if (!left || !right) return false;
    bucket.items[leftSlot] = right;
    bucket.items[rightSlot] = left;
    right.slot = leftSlot;
    left.slot = rightSlot;
    bucket.dirtySlots ??= new Set();
    bucket.dirtySlots.add(leftSlot);
    bucket.dirtySlots.add(rightSlot);
    persistentTreeCompactionMoveCount += 1;
    return true;
  };

  // InstancedMesh submits the contiguous [0,count) range. Keep visible,
  // nondestroyed canonical Trees in that prefix and move a toggled item at most
  // once across the boundary. World-density admission happened once in the
  // shared canonical preparer; observer distance never changes existence here.
  const setPersistentCoarseTreeItemSubmitted = (bucket, item, submitted) => {
    if (!isPersistentCoarseTreeBucket(bucket)
      || !Number.isSafeInteger(item?.slot)
      || bucket.items[item.slot] !== item) return false;
    bucket.coarseTreeSubmittedCount ??= bucket.items.reduce(
      (count, candidate) => count + Number(candidate.coarseTreeSubmitted === true),
      0,
    );
    const current = item.coarseTreeSubmitted === true;
    if (current === submitted) return false;
    const movedItems = new Set([item]);
    if (submitted) {
      const boundary = bucket.coarseTreeSubmittedCount;
      const displaced = bucket.items[boundary];
      swapPersistentCoarseTreeItems(bucket, item.slot, boundary);
      if (displaced) movedItems.add(displaced);
      item.coarseTreeSubmitted = true;
      bucket.coarseTreeSubmittedCount += 1;
    } else {
      const lastSubmittedSlot = bucket.coarseTreeSubmittedCount - 1;
      const displaced = bucket.items[lastSubmittedSlot];
      swapPersistentCoarseTreeItems(bucket, item.slot, lastSubmittedSlot);
      if (displaced) movedItems.add(displaced);
      item.coarseTreeSubmitted = false;
      bucket.coarseTreeSubmittedCount = Math.max(0, lastSubmittedSlot);
    }
    bucket.dirtySlots ??= new Set();
    bucket.dirtySlots.add(item.slot);
    if (bucket.mesh?.userData) {
      bucket.mesh.userData.canonicalVisualRevision =
        (bucket.mesh.userData.canonicalVisualRevision ?? 0) + 1;
    }
    persistentCoarseTreeSubmissionToggleCount += 1;
    return true;
  };

  const persistentCoarseTreeItemShouldSubmit = (
    _generation,
    item,
    _playerX,
    _playerZ,
  ) => {
    const object = item?.object;
    return !(object?.canonicalCoarseTree !== true
      || !['mid', 'far'].includes(object.visibleLod)
      || object.presentationTier !== 'natural-lod'
      || isFeatureDestroyed(object.stableId));
  };

  const reconcilePersistentCoarseTreeSubmission = (
    generation,
    playerX,
    playerZ,
    { force = false, stableIds = null } = {},
  ) => {
    if (!generation?.coarseFirstNatural) return Object.freeze({ scanned: 0, toggled: 0 });
    const objectRevision = persistentNaturalVisibilityObjectRevision;
    if (!force && stableIds === null
      && generation.coarseTreeSubmissionObjectRevision === objectRevision) {
      persistentCoarseTreeSubmissionEarlyOutCount += 1;
      return Object.freeze({ scanned: 0, toggled: 0 });
    }
    const candidateStableIds = stableIds === null
      ? [...persistentTreePages.values()].flatMap(page => page.stableIds)
      : [...stableIds];
    let scanned = 0;
    let toggled = 0;
    for (const stableId of candidateStableIds) {
      const object = generation.canonicalObjects.get(stableId);
      if (object?.canonicalCoarseTree !== true) continue;
      for (const instance of object.instances) {
        if (!isPersistentCoarseTreeBucket(instance.bucket)) continue;
        scanned += 1;
        toggled += Number(setPersistentCoarseTreeItemSubmitted(
          instance.bucket,
          instance.item,
          persistentCoarseTreeItemShouldSubmit(
            generation,
            instance.item,
            playerX,
            playerZ,
          ),
        ));
      }
    }
    generation.coarseTreeSubmissionPlayerX = playerX;
    generation.coarseTreeSubmissionPlayerZ = playerZ;
    generation.coarseTreeSubmissionObjectRevision = objectRevision;
    persistentCoarseTreeSubmissionScanCount += 1;
    persistentCoarseTreeSubmissionObjectScanCount += scanned;
    return Object.freeze({ scanned, toggled });
  };

  const createPersistentNaturalVisibilityStats = () => ({
    farCount: 0,
    midCount: 0,
    nearCount: 0,
    hiddenCount: 0,
    destroyedCount: 0,
    visibleCount: 0,
    visibleVegetationCount: 0,
    visibleTreeCount: 0,
    visibleShrubCount: 0,
    visibleGrassCount: 0,
    visibleRockCount: 0,
    visibleFullTreeCount: 0,
    visibleSilhouetteTreeCount: 0,
    visibleUltraTreeCount: 0,
    visibleTreePartInstanceCount: 0,
    visibleTreeMidBandCount: 0,
    visibleTreeOuterBandCount: 0,
    visibleTreeUltraInnerBandCount: 0,
    visibleTreeUltraOuterBandCount: 0,
    visibleNaturalCrossFadeCount: 0,
    visibleForestInstanceCount: 0,
    visibleAtmosphericInstanceCount: 0,
    visibleFarTreeInstanceCount: 0,
    activeOwners: new Set(),
    renderedOwners: new Set(),
  });

  const accumulatePersistentNaturalVisibilityStats = (stats, generation, object, state) => {
    stats[`${state.nextLod}Count`] += 1;
    if (generation.activeKeys.has(object.ownerKey)) stats.activeOwners.add(object.ownerKey);
    if (generation.renderedKeys.has(object.ownerKey)) stats.renderedOwners.add(object.ownerKey);
    if (state.distantVisible) stats.visibleCount += 1;
    if (!state.natural) return;
    if (!['far', 'mid', 'near'].includes(state.nextLod)) return;
    if (!state.rock) stats.visibleVegetationCount += 1;
    if (state.tree) stats.visibleTreeCount += 1;
    else if (state.bush) stats.visibleShrubCount += 1;
    else if (state.grass) stats.visibleGrassCount += 1;
    else if (state.rock) stats.visibleRockCount += 1;
    if (state.distantVisible && state.naturalBlend.crossFade) {
      stats.visibleNaturalCrossFadeCount += 1;
    }
    if (state.distantVisible && state.naturalBlend.forest > 0) {
      stats.visibleForestInstanceCount += 1;
    }
    if (state.distantVisible && state.naturalBlend.atmospheric > 0) {
      stats.visibleAtmosphericInstanceCount += 1;
    }
    if (state.distantVisible && state.naturalBlend.far > 0) {
      stats.visibleFarTreeInstanceCount += 1;
    }
    if (!state.tree) return;
    if (state.distantVisible
      && state.distanceMeters >= state.naturalLodPolicy.fullToForest.maximum
      && state.distanceMeters < state.naturalLodPolicy.forestToAtmospheric.minimum) {
      stats.visibleTreeMidBandCount += 1;
    } else if (state.distantVisible
      && state.distanceMeters >= state.naturalLodPolicy.forestToAtmospheric.minimum
      && state.distanceMeters < state.naturalLodPolicy.forestToAtmospheric.maximum) {
      stats.visibleTreeOuterBandCount += 1;
    } else if (state.distantVisible
      && state.distanceMeters >= state.naturalLodPolicy.forestToAtmospheric.maximum
      && state.distanceMeters < state.naturalLodPolicy.atmosphericFade.minimum) {
      stats.visibleTreeUltraInnerBandCount += 1;
    } else if (state.distantVisible
      && state.distanceMeters >= state.naturalLodPolicy.atmosphericFade.minimum
      && state.distanceMeters < state.naturalLodPolicy.visibilityMeters) {
      stats.visibleTreeUltraOuterBandCount += 1;
    }
    const dominantTier = state.nextLod === 'near' ? 'full' : state.naturalBlend.dominantTier;
    if (dominantTier === 'forest') stats.visibleSilhouetteTreeCount += 1;
    else if (dominantTier === 'atmospheric' || dominantTier === 'far') {
      stats.visibleUltraTreeCount += 1;
    } else stats.visibleFullTreeCount += 1;
    stats.visibleTreePartInstanceCount += state.nextLod === 'near'
      ? object.instances.filter(instance => instance.bucket.name === 'natural-full-tree').length
      : object.instances.length;
  };

  const commitPersistentNaturalVisibilityStats = (generation, counters) => {
    generation.stats.canonicalFarObjectCount = counters.farCount;
    generation.stats.canonicalMidObjectCount = counters.midCount;
    generation.stats.canonicalNearObjectCount = counters.nearCount;
    generation.stats.canonicalHiddenObjectCount = counters.hiddenCount;
    generation.stats.canonicalDestroyedObjectCount = counters.destroyedCount;
    generation.stats.canonicalActiveOwnerCount = counters.activeOwners.size;
    generation.stats.canonicalRenderedOwnerCount = counters.renderedOwners.size;
    generation.stats.visibleCanonicalObjectCount = counters.visibleCount;
    generation.stats.visibleCanonicalVegetationCount = counters.visibleVegetationCount;
    generation.stats.visibleCanonicalTreeCount = counters.visibleTreeCount;
    generation.stats.visibleCanonicalShrubCount = counters.visibleShrubCount;
    generation.stats.visibleCanonicalGrassCount = counters.visibleGrassCount;
    generation.stats.visibleCanonicalRockCount = counters.visibleRockCount;
    generation.stats.visibleCanonicalFullTreeCount = counters.visibleFullTreeCount;
    generation.stats.visibleCanonicalSilhouetteTreeCount = counters.visibleSilhouetteTreeCount;
    generation.stats.visibleCanonicalUltraTreeCount = counters.visibleUltraTreeCount;
    generation.stats.visibleCanonicalTreePartInstanceCount = counters.visibleTreePartInstanceCount;
    generation.stats.visibleCanonicalTreeMidBandCount = counters.visibleTreeMidBandCount;
    generation.stats.visibleCanonicalTreeOuterBandCount = counters.visibleTreeOuterBandCount;
    generation.stats.visibleCanonicalTreeUltraInnerBandCount = counters.visibleTreeUltraInnerBandCount;
    generation.stats.visibleCanonicalTreeUltraOuterBandCount = counters.visibleTreeUltraOuterBandCount;
    generation.stats.visibleCanonicalNaturalCrossFadeCount = counters.visibleNaturalCrossFadeCount;
    generation.stats.visibleCanonicalForestInstanceCount = counters.visibleForestInstanceCount;
    generation.stats.visibleCanonicalAtmosphericInstanceCount = counters.visibleAtmosphericInstanceCount;
    generation.stats.visibleCanonicalFarTreeInstanceCount = counters.visibleFarTreeInstanceCount;
  };

  const updateCanonicalVisibility = (
    generation,
    playerX,
    playerZ,
    {
      compose = true,
      objectStableIds = null,
      updateStats = objectStableIds === null,
      ignoreNearStableIds = null,
    } = {},
  ) => {
    if (!generation) return;
    const diagnosticStartedAt = diagnosticsEnabled ? monotonicNow() : 0;
    const renderDistancePolicy = generation.renderDistancePolicy
      ?? resolveW8RenderDistancePolicy(generation.renderDistancePreset);
    const settlementPresentationPolicy = generation.settlementPresentationPolicy
      ?? resolveW8SettlementPresentationPolicy(
        generation.quality,
        generation.renderDistancePreset,
      );
    const remoteSettlementPolicy = settlementPresentationPolicy.remote;
    updateRemoteHorizonPlayerUniform(generation, playerX, playerZ);
    updateNaturalLodPlayerUniforms(generation, playerX, playerZ);
    const visibility = renderDistancePolicy.generalDetailDistanceMeters;
    const naturalVisibility = renderDistancePolicy.naturalDetailDistanceMeters;
    let farCount = 0;
    let midCount = 0;
    let nearCount = 0;
    let hiddenCount = 0;
    let destroyedCount = 0;
    let visibleCount = 0;
    let visibleVegetationCount = 0;
    let visibleTreeCount = 0;
    let visibleShrubCount = 0;
    let visibleGrassCount = 0;
    let visibleRockCount = 0;
    let visibleFullTreeCount = 0;
    let visibleSilhouetteTreeCount = 0;
    let visibleUltraTreeCount = 0;
    let visibleTreePartInstanceCount = 0;
    let visibleTreeMidBandCount = 0;
    let visibleTreeOuterBandCount = 0;
    let visibleTreeUltraInnerBandCount = 0;
    let visibleTreeUltraOuterBandCount = 0;
    let visibleNaturalCrossFadeCount = 0;
    let visibleForestInstanceCount = 0;
    let visibleAtmosphericInstanceCount = 0;
    let visibleFarTreeInstanceCount = 0;
    let visibleHorizonBuildingCount = 0;
    let visibleHorizonLandmarkCount = 0;
    let visibleBuildingPartInstanceCount = 0;
    let visibleHorizonPartInstanceCount = 0;
    let destroyedHorizonBuildingCount = 0;
    const visibleRemoteSettlementIds = new Set();
    const activeOwners = new Set();
    const renderedOwners = new Set();
    const dirtyBuckets = new Map();
    const immediatePersistentRoadReplacementBuckets = new Set();
    const markObjectDirty = object => {
      for (const instance of object.instances) {
        dirtyBuckets.set(canonicalBucketVisibilityKey(instance.bucket), instance.bucket);
        if (isSettlementRoadBucket(instance.bucket)) {
          instance.bucket.roadComposeRevision =
            (instance.bucket.roadComposeRevision ?? 0) + 1;
        }
        if (instance.bucket.persistent === true && Number.isSafeInteger(instance.item.slot)) {
          instance.bucket.dirtySlots ??= new Set();
          instance.bucket.dirtySlots.add(instance.item.slot);
        }
      }
    };
    const nearVisibleState = readNearVisibleSnapshotState();
    const nearVisibleStableIds = ignoreNearStableIds === null
      ? nearVisibleState.stableIds
      : new Set([...nearVisibleState.stableIds]
        .filter(stableId => !ignoreNearStableIds.has(stableId)));
    const selectedObjects = objectStableIds === null
      ? [...generation.canonicalObjects.values()]
      : objectStableIds.map(stableId => generation.canonicalObjects.get(stableId)).filter(Boolean);
    const nearVisibleSettlementIds = generation.persistentTree === true
      ? new Set()
      : new Set([...generation.canonicalObjects.values()]
        .filter(object => nearVisibleStableIds.has(object.stableId))
        .map(object => object.settlementId)
        .filter(Boolean));
    const nearStableSignature = ignoreNearStableIds === null
      ? nearVisibleState.signature
      : [...nearVisibleStableIds].sort((left, right) => left.localeCompare(right)).join('\n');
    if (nearStableSignature !== generation.nearVisibleStableSignature) {
      if (generation.persistentTree === true) {
        const previousNear = generation.nearVisibleStableIds ?? new Set();
        for (const stableId of new Set([...previousNear, ...nearVisibleStableIds])) {
          if (previousNear.has(stableId) === nearVisibleStableIds.has(stableId)) continue;
          const object = generation.canonicalObjects.get(stableId);
          if (object) markObjectDirty(object);
        }
      } else {
        for (const object of generation.canonicalObjects.values()) {
          if (!object.remoteHorizon && !object.naturalKind) continue;
          markObjectDirty(object);
        }
      }
      generation.nearVisibleStableSignature = nearStableSignature;
    }
    generation.nearVisibleStableIds = nearVisibleStableIds;
    generation.nearVisibleSettlementIds = nearVisibleSettlementIds;
    for (const object of selectedObjects) {
      const previousFullOpacity = object.fullPresentationOpacity;
      const previousHorizonOpacity = object.horizonPresentationOpacity;
      const previousRemoteOpacity = object.remotePresentationOpacity;
      object.localBuildingHandoff = false;
      object.fullPresentationOpacity = 0;
      object.horizonPresentationOpacity = 0;
      object.remotePresentationOpacity = 0;
      let nextLod = 'hidden';
      const distanceMeters = Math.hypot(object.worldX - playerX, object.worldZ - playerZ);
      const naturalKind = object.naturalKind;
      const tree = naturalKind === W8_VEGETATION_LOD_KINDS.TREE;
      const bush = naturalKind === W8_VEGETATION_LOD_KINDS.BUSH;
      const grass = naturalKind === W8_VEGETATION_LOD_KINDS.GRASS;
      const rock = naturalKind === W8_VEGETATION_LOD_KINDS.ROCK;
      const natural = naturalKind !== null;
      const naturalLodPolicy = natural
        ? naturalLodPolicyFor(generation, naturalKind)
        : null;
      const policyVisibility = object.record.lodPolicy
        ? resolveW8ObjectVisibilityMeters(object.record, generation.renderDistancePreset)
        : null;
      const exactNaturalVisibility = natural
        ? Math.min(policyVisibility ?? naturalVisibility, naturalLodPolicy.visibilityMeters)
        : naturalVisibility;
      const objectNaturalVisibility = tree
        ? naturalLodPolicy.visibilityMeters : exactNaturalVisibility;
      const objectVisibility = object.record.featureType === 'settlement-road'
        ? renderDistancePolicy.worldPresentationDistanceMeters
        : policyVisibility ?? visibility;
      const insideNaturalVisibility = distanceMeters <= objectNaturalVisibility;
      const remoteTier = remoteSettlementPresentationTier(
        object,
        distanceMeters,
        remoteSettlementPolicy,
        !nearVisibleStableIds.has(object.stableId),
      );
      const hasLocalPresentation = object.instances.some(instance => (
        instance.item.visibilityTiers.includes('full')
          || instance.item.visibilityTiers.includes('horizon')
          || instance.item.visibilityTiers.includes('natural-lod')
      ));
      const replacedByPersistentCoarseStructure = generation !== persistentTreeGeneration
        && persistentTreeGeneration?.distantVisibleStableIds?.has(object.stableId) === true
        && (object.record.featureType === 'settlement-building'
          || object.record.featureType === 'settlement-road');
      if (object.destructible && isFeatureDestroyed(object.stableId)) {
        nextLod = 'destroyed';
        if (isHorizonRecord(object.record)
          && distanceMeters >= renderDistancePolicy.settlementLod.fullDistanceMeters
          && distanceMeters < renderDistancePolicy.settlementLod.visibilityMeters) {
          destroyedHorizonBuildingCount += 1;
        }
      } else if (replacedByPersistentCoarseStructure) {
        nextLod = 'hidden';
      } else if (nearVisibleStableIds.has(object.stableId)
        || (!tree && hasLocalPresentation && generation.renderedKeys.has(object.ownerKey))) {
        nextLod = 'near';
      } else if (hasLocalPresentation && generation.activeKeys.has(object.ownerKey)
        && (object.record.lodPolicy?.outer !== null)
        && (!natural || insideNaturalVisibility)) {
        nextLod = 'mid';
      } else if (hasLocalPresentation
        && object.farEligible && object.record.lodPolicy?.far !== null) {
        const insideVisibility = natural
          ? insideNaturalVisibility
          : distanceMeters <= objectVisibility;
        if (insideVisibility) nextLod = 'far';
      }
      if (nextLod === 'hidden' && remoteTier) nextLod = 'far';
      const distantVisible = nextLod === 'far' || nextLod === 'mid';
      object.naturalBlend = natural
        ? applyCanonicalFarTreeDensity(
          object,
          naturalLodPolicy,
          distanceMeters,
          evaluateW8VegetationLodBlend(
            naturalLodPolicy,
            distanceMeters,
            object.naturalBlend ?? {},
          ),
        )
        : null;
      let presentationTier = natural
        ? (distantVisible && object.naturalBlend.visible ? 'natural-lod' : null)
        : canonicalSettlementPresentationTier(
          object,
          distanceMeters,
          generation.quality,
          distantVisible,
          generation.localSettlementIds,
          renderDistancePolicy.settlementLod,
        );
      if (distantVisible && object.remoteHorizon && !hasLocalPresentation) {
        presentationTier = remoteTier;
      }
      if (distantVisible && !presentationTier && remoteTier) {
        nextLod = 'far';
        presentationTier = remoteTier;
      }
      if (nextLod === 'near') {
        presentationTier = object.record.lodPolicy?.outer === null ? null : 'full';
        object.fullPresentationOpacity = presentationTier ? 1 : 0;
        object.horizonPresentationOpacity = 0;
        object.remotePresentationOpacity = 0;
      } else if (presentationTier !== 'remote-horizon') {
        object.remotePresentationOpacity = 0;
      }
      if ((natural || isHorizonRecord(object.record) || object.remoteHorizon)
        && distantVisible && !presentationTier) {
        nextLod = 'hidden';
        presentationTier = null;
      }
      if (nextLod === 'far') farCount += 1;
      if (nextLod === 'mid') midCount += 1;
      if (nextLod === 'near') nearCount += 1;
      if (nextLod === 'hidden') hiddenCount += 1;
      if (nextLod === 'destroyed') destroyedCount += 1;
      if (generation.activeKeys.has(object.ownerKey)) activeOwners.add(object.ownerKey);
      if (generation.renderedKeys.has(object.ownerKey)) renderedOwners.add(object.ownerKey);
      if (nextLod === 'far' || nextLod === 'mid') visibleCount += 1;
      if (object.remoteHorizon && nextLod === 'far'
        && presentationTier === 'remote-horizon') {
        visibleRemoteSettlementIds.add(object.settlementId);
      }
      if ((nextLod === 'far' || nextLod === 'mid' || nextLod === 'near') && natural) {
        if (!rock) visibleVegetationCount += 1;
        if (tree) visibleTreeCount += 1;
        else if (bush) visibleShrubCount += 1;
        else if (grass) visibleGrassCount += 1;
        else if (rock) visibleRockCount += 1;
        if (distantVisible && object.naturalBlend.crossFade) {
          visibleNaturalCrossFadeCount += 1;
        }
        if (distantVisible && object.naturalBlend.forest > 0) {
          visibleForestInstanceCount += 1;
        }
        if (distantVisible && object.naturalBlend.atmospheric > 0) {
          visibleAtmosphericInstanceCount += 1;
        }
        if (distantVisible && object.naturalBlend.far > 0) {
          visibleFarTreeInstanceCount += 1;
        }
        if (tree) {
          if (distantVisible
            && distanceMeters >= naturalLodPolicy.fullToForest.maximum
            && distanceMeters < naturalLodPolicy.forestToAtmospheric.minimum) {
            visibleTreeMidBandCount += 1;
          } else if (distantVisible
            && distanceMeters >= naturalLodPolicy.forestToAtmospheric.minimum
            && distanceMeters < naturalLodPolicy.forestToAtmospheric.maximum) {
            visibleTreeOuterBandCount += 1;
          } else if (distantVisible
            && distanceMeters >= naturalLodPolicy.forestToAtmospheric.maximum
            && distanceMeters < naturalLodPolicy.atmosphericFade.minimum) {
            visibleTreeUltraInnerBandCount += 1;
          } else if (distantVisible
            && distanceMeters >= naturalLodPolicy.atmosphericFade.minimum
            && distanceMeters < naturalLodPolicy.visibilityMeters) {
            visibleTreeUltraOuterBandCount += 1;
          }
          const dominantTier = nextLod === 'near'
            ? 'full' : object.naturalBlend.dominantTier;
          if (dominantTier === 'forest') visibleSilhouetteTreeCount += 1;
          else if (dominantTier === 'atmospheric' || dominantTier === 'far') {
            visibleUltraTreeCount += 1;
          }
          else visibleFullTreeCount += 1;
          visibleTreePartInstanceCount += nextLod === 'near'
            ? object.instances.filter(instance => instance.bucket.name === 'natural-full-tree').length
            : object.instances.length;
        }
      } else if ((isHorizonRecord(object.record) || object.remoteHorizon)
        && (nextLod === 'far' || nextLod === 'mid' || nextLod === 'near')) {
        if (presentationTier === 'full-horizon-handoff') {
          if (object.record.featureType === 'settlement-building') {
            visibleHorizonBuildingCount += 1;
          }
          visibleBuildingPartInstanceCount += object.instances.filter(instance => (
            instance.item.visibilityTiers.includes('full')
          )).length;
          visibleHorizonPartInstanceCount += object.instances.filter(instance => (
            instance.item.visibilityTiers.includes('horizon')
          )).length;
        } else if (presentationTier === 'horizon' || presentationTier === 'remote-horizon') {
          if (object.record.featureType === 'settlement-building') visibleHorizonBuildingCount += 1;
          else if (!object.remoteHorizon) visibleHorizonLandmarkCount += 1;
          visibleHorizonPartInstanceCount += object.instances.filter(instance => (
            instance.item.visibilityTiers.includes(presentationTier)
          )).length;
        } else {
          visibleBuildingPartInstanceCount += object.instances.filter(instance => (
            instance.item.visibilityTiers.includes('full')
          )).length;
        }
      }
      const opacityChanged = previousFullOpacity !== object.fullPresentationOpacity
        || previousHorizonOpacity !== object.horizonPresentationOpacity
        || previousRemoteOpacity !== object.remotePresentationOpacity;
      if (object.visibleLod === nextLod && object.presentationTier === presentationTier
        && !opacityChanged) continue;
      markObjectDirty(object);
      if (replacedByPersistentCoarseStructure) {
        for (const instance of object.instances) {
          if (isSettlementRoadBucket(instance.bucket)) {
            immediatePersistentRoadReplacementBuckets.add(instance.bucket);
          }
        }
      }
      if (tree) {
        generation.treeVisibilityChangeCount =
          (generation.treeVisibilityChangeCount ?? 0) + 1;
      }
      object.visibleLod = nextLod;
      object.presentationTier = presentationTier;
    }
    generation.playerX = playerX;
    generation.playerZ = playerZ;
    if (updateStats) {
      generation.stats.remoteHorizonPartInstanceCount = 0;
      for (const object of generation.canonicalObjects.values()) {
        if (object.remoteHorizon && object.visibleLod === 'far'
          && object.presentationTier === 'remote-horizon') {
          generation.stats.remoteHorizonPartInstanceCount += object.instances.filter(instance => (
            instance.item.visibilityTiers.includes('remote-horizon')
          )).length;
        }
      }
    }
    if (compose && dirtyBuckets.size && generation.persistentTree !== true
      && generation.persistentDistant !== true) {
      composeCanonicalMeshes(generation, dirtyBuckets);
    }
    if (generation.persistentDistant === true) {
      for (const bucket of immediatePersistentRoadReplacementBuckets) {
        composeCanonicalBucket(generation, bucket);
      }
    }
    if (updateStats) {
    generation.stats.canonicalFarObjectCount = farCount;
    generation.stats.canonicalMidObjectCount = midCount;
    generation.stats.canonicalNearObjectCount = nearCount;
    generation.stats.canonicalHiddenObjectCount = hiddenCount;
    generation.stats.canonicalDestroyedObjectCount = destroyedCount;
    generation.stats.canonicalActiveOwnerCount = activeOwners.size;
    generation.stats.canonicalRenderedOwnerCount = renderedOwners.size;
    generation.stats.visibleCanonicalObjectCount = visibleCount;
    generation.stats.visibleCanonicalVegetationCount = visibleVegetationCount;
    generation.stats.visibleCanonicalTreeCount = visibleTreeCount;
    generation.stats.visibleCanonicalShrubCount = visibleShrubCount;
    generation.stats.visibleCanonicalGrassCount = visibleGrassCount;
    generation.stats.visibleCanonicalRockCount = visibleRockCount;
    generation.stats.visibleCanonicalFullTreeCount = visibleFullTreeCount;
    generation.stats.visibleCanonicalSilhouetteTreeCount = visibleSilhouetteTreeCount;
    generation.stats.visibleCanonicalUltraTreeCount = visibleUltraTreeCount;
    generation.stats.visibleCanonicalTreePartInstanceCount = visibleTreePartInstanceCount;
    generation.stats.visibleCanonicalTreeMidBandCount = visibleTreeMidBandCount;
    generation.stats.visibleCanonicalTreeOuterBandCount = visibleTreeOuterBandCount;
    generation.stats.visibleCanonicalTreeUltraInnerBandCount = visibleTreeUltraInnerBandCount;
    generation.stats.visibleCanonicalTreeUltraOuterBandCount = visibleTreeUltraOuterBandCount;
    generation.stats.visibleCanonicalNaturalCrossFadeCount = visibleNaturalCrossFadeCount;
    generation.stats.visibleCanonicalForestInstanceCount = visibleForestInstanceCount;
    generation.stats.visibleCanonicalAtmosphericInstanceCount = visibleAtmosphericInstanceCount;
    generation.stats.visibleCanonicalFarTreeInstanceCount = visibleFarTreeInstanceCount;
    generation.stats.visibleCanonicalHorizonBuildingCount = visibleHorizonBuildingCount;
    generation.stats.visibleCanonicalHorizonLandmarkCount = visibleHorizonLandmarkCount;
    generation.stats.visibleCanonicalBuildingPartInstanceCount = visibleBuildingPartInstanceCount;
    generation.stats.visibleCanonicalHorizonPartInstanceCount = visibleHorizonPartInstanceCount;
    generation.stats.destroyedHorizonBuildingCount = destroyedHorizonBuildingCount;
    generation.stats.visibleRemoteHorizonSettlementCount = visibleRemoteSettlementIds.size;
    }
    generation.treeLastUpdateAtMs = monotonicNow();
    if (treeLodDiagnosticsEnabled && !generation.treeLodDiagnostics) {
      createTreeLodDiagnostics(generation);
    } else if (generation.treeLodDiagnostics) {
      updateTreeLodDiagnostics(generation);
    }
    if (diagnosticsEnabled) recordDiagnosticWork(
      generation.persistentNatural === true
        ? 'persistent-natural-visibility'
        : 'legacy-distant-visibility',
      {
        calls: 1,
        canonicalObjectsScanned: selectedObjects.length,
        nearIdentityObjectsScanned: objectStableIds === null
          && generation.persistentTree !== true ? generation.canonicalObjects.size : 0,
        dirtyBuckets: dirtyBuckets.size,
        visibleObjects: visibleCount,
        maximumSynchronousSliceMs: monotonicNow() - diagnosticStartedAt,
      },
    );
    return dirtyBuckets;
  };

  let persistentTreeGeneration = null;
  let persistentNaturalVisibilityRetainedGeneration = null;
  let stagedPersistentNaturalRenderDistancePreset = null;
  const persistentTreePages = new Map();
  const pendingPersistentTreePages = new Map();
  const pendingPersistentTreePublications = new Map();
  const persistentNaturalDetailAvailableOwners = new Set();
  const persistentTreePublishedOwners = new Set();
  const directCanonicalTreeCells = new Map();
  const directCanonicalTreeOwnerKeys = new Set();
  const isDirectCanonicalTreePage = (ownerKey, page = null) => (
    page?.resourceKind === DIRECT_CANONICAL_TREE_RESOURCE_KIND
      || (typeof ownerKey === 'string' && ownerKey.startsWith(DIRECT_CANONICAL_TREE_PAGE_PREFIX))
  );
  const isPersistentTreePageRetained = (ownerKey, page, retainedOwnerKeys) => (
    isDirectCanonicalTreePage(ownerKey, page)
      ? directCanonicalTreeCells.has(page?.macroCellKey
        ?? ownerKey.slice(DIRECT_CANONICAL_TREE_PAGE_PREFIX.length))
      : retainedOwnerKeys.has(ownerKey)
  );
  const persistentTreeDisposeOwners = [];
  const persistentTreeDesiredResourceKinds = new Map();
  let persistentTreeRetainedOwnerKeys = new Set();
  let persistentTreeBuildActiveCount = 0;
  let persistentTreeBuildQueuedCount = 0;
  let persistentTreeCoverageGeneration = 0;
  let persistentTreePlanRevision = 0;
  let persistentTreePlanId = null;
  let persistentTreeStateRevision = null;
  let persistentTreeVisibilityDirty = true;
  let persistentTreePublishedOwnerCount = 0;
  let persistentTreeMatrixUpdateCount = 0;
  let persistentTreeAttributeUpdateCount = 0;
  let persistentTreeMaximumSliceMs = 0;
  let persistentTreeLastPublicationWaitMs = 0;
  let persistentTreeMaximumPublicationWaitMs = 0;
  const persistentTreeFrameSampleCapacity = 512;
  const persistentTreeFrameSamples = [];
  let persistentTreeFrameSequence = 0;
  let persistentTreeOwnerBuildCount = 0;
  let persistentTreeOwnerReuseCount = 0;
  let persistentTreeOwnerRebuildCount = 0;
  let persistentTreeExactOwnerBuildCount = 0;
  let persistentTreeLightweightOwnerPublicationCount = 0;
  let persistentTreeSmallFarOwnerPublicationCount = 0;
  let persistentTreeOwnerDisposeCount = 0;
  let persistentTreeDuplicatePageQueueCount = 0;
  let persistentTreeStalePageDiscardCount = 0;
  let persistentTreeOlderCoveragePageCount = 0;
  let persistentTreeRootResetCount = 0;
  let persistentTreeMaximumVisibilitySliceMs = 0;
  let persistentTreeMaximumDisposeSliceMs = 0;
  let persistentTreeAllocatedObjectCount = 0;
  let persistentTreeAllocatedInstanceCount = 0;
  let persistentTreeAllocatedBucketCount = 0;
  let persistentTreeBufferRangeUpdateCount = 0;
  let persistentTreeBufferUploadByteCount = 0;
  let persistentTreeAdmissionsSinceFrame = 0;
  let persistentTreeLastBuildQueueTarget = 0;
  let persistentTreeMaximumBuildQueueTarget = 0;
  let persistentTreeMaximumAdmissionsPerFrame = 0;
  let persistentTreeAdmissionLimitViolationCount = 0;
  let persistentTreeCompactionMoveCount = 0;
  let persistentTreeVisibilityMatrixInvalidationCount = 0;
  let persistentCoarseTreeSubmissionScanCount = 0;
  let persistentCoarseTreeSubmissionObjectScanCount = 0;
  let persistentCoarseTreeSubmissionToggleCount = 0;
  let persistentCoarseTreeSubmissionEarlyOutCount = 0;
  let markFirstDrawCanonicalObjectScanCount = 0;
  let markFirstDrawReceiptEarlyOutCount = 0;
  let persistentNaturalCoverageApplyCount = 0;
  let persistentNaturalFrameAdvanceCount = 0;
  let persistentNaturalVisibilityJob = null;
  const persistentNaturalVisibilityDirtyStableIds = new Set();
  let persistentNaturalVisibilityFullScanPending = true;
  let persistentNaturalVisibilitySequence = 0;
  let persistentNaturalVisibilityObjectRevision = 0;
  let persistentNaturalVisibilityFrameSequence = 0;
  let persistentNaturalVisibilityMaximumQueueLength = 0;
  let persistentNaturalVisibilityMaximumSliceMs = 0;
  let persistentNaturalVisibilityMaximumUnitMs = 0;
  let persistentNaturalVisibilityMaximumCoverageWaitFrames = 0;
  let persistentNaturalVisibilityMaximumEnteringWaitFrames = 0;
  let persistentNaturalVisibilityMaximumLeavingWaitFrames = 0;
  let persistentNaturalVisibilitySupersededDiscardCount = 0;
  let persistentNaturalVisibilityStaleDiscardCount = 0;
  let persistentNaturalVisibilityStaleApplicationCount = 0;
  let persistentNaturalVisibilityStarvationCount = 0;
  let persistentNaturalVisibilityCoverageGapCount = 0;
  let persistentNaturalVisibilityCompletedSequence = 0;
  let persistentNaturalVisibilityCompletedInputKey = null;
  let persistentNaturalVisibilityBaselineStartedCount = 0;
  let persistentNaturalVisibilityBaselineCompletedCount = 0;
  let persistentNaturalVisibilityBaselineSynchronousScanCount = 0;
  let persistentNaturalVisibilityRetainedGenerationReleaseCount = 0;
  let persistentNaturalVisibilityCoverageBarrier = null;
  let persistentNaturalVisibilityCoverageBarrierReleasedCount = 0;
  let persistentNaturalVisibilityCoverageBarrierSupersededCount = 0;
  let persistentNaturalVisibilityCoverageBarrierSupersededDiscardCount = 0;
  let persistentNaturalVisibilityCoverageBarrierMaximumLength = 0;
  let persistentNaturalVisibilityCoverageBarrierMaximumHeldFrames = 0;
  let pendingRuntimePresentationHandoff = null;
  let runtimePresentationHandoffSequence = 0;
  let runtimePresentationHandoffRequestedCount = 0;
  let runtimePresentationHandoffCompletedCount = 0;
  let runtimePresentationHandoffSupersededCount = 0;
  let runtimePresentationHandoffLocalTerrainCount = 0;
  let runtimePresentationHandoffMatrixUpdateCount = 0;
  let runtimePresentationHandoffBufferUpdateCount = 0;
  let runtimePresentationHandoffDisposeCount = 0;
  let runtimePresentationHandoffMaximumSliceMs = 0;
  let runtimePresentationHandoffMaximumMatrixUpdatesPerFrame = 0;
  let runtimePresentationHandoffMaximumBufferUpdatesPerFrame = 0;
  let runtimePresentationHandoffMaximumDisposePerFrame = 0;
  let runtimePresentationCommittedRenderedKeys = null;
  let runtimePresentationCommittedNearStableIds = null;
  let runtimePresentationCoverageBarrierRequestedCount = 0;
  let runtimePresentationCoverageBarrierReleasedCount = 0;
  let runtimePresentationCoverageBarrierSupersededCount = 0;
  let runtimePresentationCoverageBarrierRetryCount = 0;
  let runtimePresentationCoverageBarrierMaximumHeldMs = 0;
  let runtimePresentationCoverageBarrierBlankFrameCount = 0;
  let runtimePresentationCoverageBarrierDuplicateFrameCount = 0;
  let runtimePresentationCoverageBarrierLastRelease = null;
  let roadPresentationWorkSequence = 0;
  let roadPresentationFrameSequence = 0;
  let roadPresentationMaximumQueueLength = 0;
  let roadPresentationMaximumWaitFrames = 0;
  let roadPresentationMaximumSliceMs = 0;
  let roadPresentationMaximumUnitMs = 0;
  let roadPresentationOwnerWorkCount = 0;
  let roadPresentationBucketComposeCount = 0;
  let roadPresentationRecordComposeCount = 0;
  let roadPresentationSupersededDiscardCount = 0;
  let roadPresentationStalePublishCount = 0;
  let roadPresentationStarvationCount = 0;
  let roadPresentationOrphanGeometryCount = 0;
  let roadPresentationDoubleDisposeCount = 0;
  const disposedRoadGeometries = new WeakSet();

  const recordPersistentTreeFrameSample = sample => {
    if (!streamingTelemetry) return;
    persistentTreeFrameSamples.push(sample);
    while (persistentTreeFrameSamples.length > persistentTreeFrameSampleCapacity) {
      persistentTreeFrameSamples.shift();
    }
  };

  const createPersistentNaturalGeneration = ({
    quality,
    renderDistancePreset,
    renderOrigin,
    attach = true,
  }) => {
    const naturalRoot = new Group();
    naturalRoot.name = 'w8-persistent-static-natural-pages';
    naturalRoot.userData = {
      presentationOnly: true,
      persistentStaticPages: true,
      treePathId: TREE_RENDER_PATH.STATIC,
    };
    if (attach) scene.add(naturalRoot);
    return {
      epoch: 0,
      root: naturalRoot,
      persistentNatural: true,
      coarseFirstNatural: true,
      // Compatibility flag used by existing visibility and path-audit code.
      persistentTree: true,
      treeOnly: false,
      naturalOnly: false,
      excludeNatural: false,
      excludeTreeNatural: false,
      ownedGeometries: new Set(),
      ownedMaterials: new Set(),
      stats: createStats(),
      canonicalBuckets: new Map(),
      canonicalObjects: new Map(),
      activeKeys: new Set(),
      renderedKeys: new Set(),
      activeDataKeysIdentity: null,
      renderedKeysIdentity: null,
      quality,
      renderDistancePreset,
      renderDistancePolicy: resolveW8RenderDistancePolicy(renderDistancePreset),
      settlementPresentationPolicy: resolveW8SettlementPresentationPolicy(
        quality,
        renderDistancePreset,
      ),
      localFullHandoffMaterials: new Map(),
      naturalLodMaterials: new Map(),
      naturalLodPolicies: new Map(),
      naturalReveal: 1,
      naturalRevealInnerMeters: 0,
      naturalRevealStartedAt: null,
      horizonBuildingSilhouetteMaterial: null,
      remoteHorizonSilhouetteMaterial: null,
      buildOriginChunkX: renderOrigin.renderOriginChunkX,
      buildOriginChunkZ: renderOrigin.renderOriginChunkZ,
      currentOriginChunkX: renderOrigin.renderOriginChunkX,
      currentOriginChunkZ: renderOrigin.renderOriginChunkZ,
      playerX: 0,
      playerZ: 0,
      coarseTreeSubmissionPlayerX: null,
      coarseTreeSubmissionPlayerZ: null,
      coarseTreeSubmissionObjectRevision: -1,
      localSettlementIds: new Set(),
      nearVisibleStableIds: new Set(),
      nearVisibleStableSignature: '',
      nearVisibleSettlementIds: new Set(),
      nearVisibleSettlementSignature: '',
      naturalKindsByOwner: new Map(),
      naturalCapacityByKind: new Map((resolveStaticNaturalCapacity?.(
        renderDistancePreset,
      ) ?? []).map(entry => [entry.naturalKind, Object.freeze({
        maximumCanonicalOwnerCount: entry.maximumCanonicalOwnerCount,
        maximumManifestOwnerCount: entry.maximumManifestOwnerCount,
      })])),
      naturalPolicyCoverageProvided: false,
      surfacePolicy: currentCanonicalSurfacePolicy,
      visibilityDesiredInput: null,
      visibilityBaselineComplete: false,
      visibilityBaselineOwnerKeys: new Set(),
      visibilityPlanApplied: false,
    };
  };

  const persistentNaturalVisibilityInputKey = (generation, nearSignature) => [
    generation.renderDistancePreset,
    persistentTreeStateRevision ?? '',
    nearSignature,
    sortedKeyList(generation.activeKeys).join('|'),
    sortedKeyList(generation.renderedKeys).join('|'),
  ].join('::');

  const persistentNaturalStableIdsForOwners = ownerKeys => {
    const stableIds = [];
    for (const ownerKey of sortedKeyList(ownerKeys)) {
      stableIds.push(...(persistentTreePages.get(ownerKey)?.stableIds ?? []));
    }
    return stableIds;
  };

  const persistentNaturalVisibilityQueueLength = job => {
    if (!job) return 0;
    return Math.max(0, job.coverageIds.length - job.coverageIndex)
      + Math.max(0, job.enteringIds.length - job.enteringIndex)
      + Math.max(0, job.leavingIds.length - job.leavingIndex)
      + Math.max(0, job.scanRemaining);
  };

  const persistentNaturalCoverageBlocksStableIds = stableIds => (
    persistentNaturalVisibilityCoverageBarrier?.generation === persistentTreeGeneration
      && stableIds.some(stableId => (
        persistentNaturalVisibilityCoverageBarrier.stableIds.has(stableId)
      ))
  );

  const persistentNaturalBaselineBlocksStableIds = stableIds => {
    const job = persistentNaturalVisibilityJob;
    return job?.baseline === true && job.generation === persistentTreeGeneration
      && stableIds.some(stableId => (
        (persistentTreeGeneration.canonicalObjects.get(stableId)?.visibilitySequence ?? 0)
          < job.sequence
      ));
  };

  const startPersistentNaturalVisibilityJob = (
    generation,
    nearState = readNearVisibleSnapshotState(),
    {
      reason = 'dirty',
      force = false,
      baseline = false,
      fullScan = persistentNaturalVisibilityFullScanPending,
    } = {},
  ) => {
    if (!generation || generation !== persistentTreeGeneration) return null;
    if (persistentNaturalVisibilityJob) return persistentNaturalVisibilityJob;
    const inputKey = persistentNaturalVisibilityInputKey(generation, nearState.signature);
    if (!force && !fullScan && persistentNaturalVisibilityDirtyStableIds.size === 0
      && persistentNaturalVisibilityCompletedInputKey === inputKey) {
      persistentTreeVisibilityDirty = false;
      return null;
    }
    const previousInput = generation.visibilityDesiredInput ?? {
      nearVisibleStableIds: generation.nearVisibleStableIds ?? new Set(),
      activeKeys: new Set(),
      renderedKeys: new Set(),
    };
    const nearVisibleStableIds = new Set(nearState.stableIds);
    const activeKeys = new Set(generation.activeKeys);
    const renderedKeys = new Set(generation.renderedKeys);
    const unique = values => [...new Set(values)].filter(stableId => (
      generation.canonicalObjects.has(stableId)
    ));
    const carriedCoverageIds = persistentNaturalVisibilityCoverageBarrier?.generation === generation
      ? [...persistentNaturalVisibilityCoverageBarrier.stableIds]
        .filter(stableId => !nearVisibleStableIds.has(stableId))
      : [];
    const nearEnteringDistant = baseline ? [] : [...previousInput.nearVisibleStableIds]
      .filter(stableId => !nearVisibleStableIds.has(stableId));
    const nearEnteringNear = baseline ? [] : [...nearVisibleStableIds]
      .filter(stableId => !previousInput.nearVisibleStableIds.has(stableId));
    const activeEnteringOwners = baseline ? new Set() : new Set([...activeKeys]
      .filter(ownerKey => !previousInput.activeKeys.has(ownerKey) && !renderedKeys.has(ownerKey)));
    const renderedEnteringOwners = baseline ? new Set() : new Set([...renderedKeys]
      .filter(ownerKey => !previousInput.renderedKeys.has(ownerKey)));
    const leavingOwners = baseline ? new Set() : new Set([
      ...[...previousInput.activeKeys].filter(ownerKey => !activeKeys.has(ownerKey)),
      ...[...previousInput.renderedKeys].filter(ownerKey => !renderedKeys.has(ownerKey)),
    ]);
    const coverageIds = unique([...carriedCoverageIds, ...nearEnteringDistant]);
    const coverageSet = new Set(coverageIds);
    const dirtyIds = unique([...persistentNaturalVisibilityDirtyStableIds]);
    const enteringIds = unique([
      ...dirtyIds,
      ...persistentNaturalStableIdsForOwners(activeEnteringOwners),
    ])
      .filter(stableId => !coverageSet.has(stableId));
    const enteringSet = new Set(enteringIds);
    const leavingIds = unique([
      ...nearEnteringNear,
      ...persistentNaturalStableIdsForOwners(renderedEnteringOwners),
      ...persistentNaturalStableIdsForOwners(leavingOwners),
    ]).filter(stableId => !coverageSet.has(stableId) && !enteringSet.has(stableId));
    const sequence = ++persistentNaturalVisibilitySequence;
    if (persistentNaturalVisibilityCoverageBarrier?.generation === generation) {
      for (const stableId of persistentNaturalVisibilityCoverageBarrier.stableIds) {
        if (nearVisibleStableIds.has(stableId) || !generation.canonicalObjects.has(stableId)) {
          persistentNaturalVisibilityCoverageBarrier.stableIds.delete(stableId);
        }
      }
      if (persistentNaturalVisibilityCoverageBarrier.stableIds.size === 0) {
        persistentNaturalVisibilityCoverageBarrierReleasedCount += 1;
        persistentNaturalVisibilityCoverageBarrier = null;
      }
    }
    if (coverageIds.length > 0) {
      if (persistentNaturalVisibilityCoverageBarrier) {
        persistentNaturalVisibilityCoverageBarrierSupersededCount += 1;
      }
      persistentNaturalVisibilityCoverageBarrier = {
        generation,
        sequence,
        stableIds: new Set(coverageIds),
        createdFrame: persistentNaturalVisibilityFrameSequence,
        allowHiddenRelease: false,
      };
      persistentNaturalVisibilityCoverageBarrierMaximumLength = Math.max(
        persistentNaturalVisibilityCoverageBarrierMaximumLength,
        coverageIds.length,
      );
    } else if (persistentNaturalVisibilityCoverageBarrier?.generation !== generation) {
      persistentNaturalVisibilityCoverageBarrier = null;
    }
    const job = {
      sequence,
      generation,
      inputKey,
      reason,
      baseline,
      playerX: generation.playerX,
      playerZ: generation.playerZ,
      nearVisibleStableIds,
      nearSignature: nearState.signature,
      activeKeys,
      renderedKeys,
      coverageIds,
      coverageIndex: 0,
      enteringIds,
      enteringIndex: 0,
      leavingIds,
      leavingIndex: 0,
      leavingSet: new Set(leavingIds),
      scanRemaining: baseline || fullScan ? generation.canonicalObjects.size : 0,
      scanIterator: generation.canonicalObjects.keys(),
      agedLeavingServedFrame: -1,
      processedIds: new Set(),
      stats: createPersistentNaturalVisibilityStats(),
      createdFrame: persistentNaturalVisibilityFrameSequence,
      commitStats: baseline || fullScan,
    };
    for (const stableId of dirtyIds) persistentNaturalVisibilityDirtyStableIds.delete(stableId);
    if (baseline || fullScan) persistentNaturalVisibilityFullScanPending = false;
    generation.visibilityDesiredInput = {
      nearVisibleStableIds,
      activeKeys,
      renderedKeys,
    };
    generation.nearVisibleStableIds = nearVisibleStableIds;
    generation.nearVisibleStableSignature = nearState.signature;
    persistentNaturalVisibilityJob = job;
    if (baseline) {
      generation.visibilityBaselineComplete = false;
      persistentNaturalVisibilityBaselineStartedCount += 1;
    }
    persistentTreeVisibilityDirty = false;
    persistentNaturalVisibilityMaximumQueueLength = Math.max(
      persistentNaturalVisibilityMaximumQueueLength,
      persistentNaturalVisibilityQueueLength(job),
    );
    return job;
  };

  const nextPersistentNaturalVisibilityCandidate = job => {
    const nextFrom = (values, indexName, source) => {
      while (job[indexName] < values.length) {
        const stableId = values[job[indexName]++];
        if (!job.processedIds.has(stableId)) return { stableId, source };
      }
      return null;
    };
    const coverage = nextFrom(job.coverageIds, 'coverageIndex', 'coverage');
    if (coverage) return coverage;
    const entering = nextFrom(job.enteringIds, 'enteringIndex', 'entering');
    if (entering) return entering;
    const ageFrames = persistentNaturalVisibilityFrameSequence - job.createdFrame;
    if (ageFrames >= NATURAL_VISIBILITY_LEAVING_AGE_FRAMES
      && job.agedLeavingServedFrame !== persistentNaturalVisibilityFrameSequence) {
      const agedLeaving = nextFrom(job.leavingIds, 'leavingIndex', 'leaving');
      if (agedLeaving) {
        job.agedLeavingServedFrame = persistentNaturalVisibilityFrameSequence;
        return agedLeaving;
      }
    }
    while (job.scanRemaining > 0) {
      let next = job.scanIterator.next();
      if (next.done) {
        job.scanIterator = job.generation.canonicalObjects.keys();
        next = job.scanIterator.next();
        if (next.done) {
          job.scanRemaining = 0;
          break;
        }
      }
      job.scanRemaining -= 1;
      const stableId = next.value;
      return {
        stableId,
        source: 'scan',
        skipped: job.processedIds.has(stableId) || job.leavingSet.has(stableId),
      };
    }
    return nextFrom(job.leavingIds, 'leavingIndex', 'leaving');
  };

  const processPersistentNaturalVisibility = (generation, budgetMs) => {
    if (!generation || generation !== persistentTreeGeneration || !(budgetMs > 0)) {
      return Object.freeze({ processed: 0, remaining: persistentNaturalVisibilityQueueLength(
        persistentNaturalVisibilityJob,
      ), durationMs: 0 });
    }
    const startedAt = monotonicNow();
    persistentNaturalVisibilityFrameSequence += 1;
    updateNaturalLodPlayerUniforms(generation, generation.playerX, generation.playerZ);
    if (persistentTreeVisibilityDirty && !persistentNaturalVisibilityJob) {
      startPersistentNaturalVisibilityJob(generation, readNearVisibleSnapshotState(), {
        reason: 'owner-or-identity-dirty',
      });
    } else if (!persistentNaturalVisibilityJob) {
      const nearState = readNearVisibleSnapshotState();
      if (persistentNaturalVisibilityCompletedInputKey
        !== persistentNaturalVisibilityInputKey(generation, nearState.signature)) {
        startPersistentNaturalVisibilityJob(generation, nearState, { reason: 'coverage' });
      }
    }
    const job = persistentNaturalVisibilityJob;
    if (!job) return Object.freeze({ processed: 0, remaining: 0, durationMs: 0 });
    if (job.generation !== generation) {
      persistentNaturalVisibilityStaleDiscardCount += persistentNaturalVisibilityQueueLength(job);
      persistentNaturalVisibilityJob = null;
      return Object.freeze({
        processed: 0,
        remaining: 0,
        durationMs: monotonicNow() - startedAt,
      });
    }
    let processed = 0;
    let attempted = 0;
    while (attempted === 0 || monotonicNow() - startedAt < budgetMs) {
      if (persistentNaturalVisibilityJob !== job || job.generation !== persistentTreeGeneration) {
        persistentNaturalVisibilityStaleDiscardCount += 1;
        break;
      }
      const unitStartedAt = monotonicNow();
      const finishUnit = () => {
        persistentNaturalVisibilityMaximumUnitMs = Math.max(
          persistentNaturalVisibilityMaximumUnitMs,
          monotonicNow() - unitStartedAt,
        );
      };
      const candidate = nextPersistentNaturalVisibilityCandidate(job);
      if (!candidate) break;
      attempted += 1;
      if (candidate.skipped) {
        finishUnit();
        continue;
      }
      const object = generation.canonicalObjects.get(candidate.stableId);
      if (!object) {
        finishUnit();
        continue;
      }
      if ((object.visibilitySequence ?? 0) > job.sequence) {
        persistentNaturalVisibilityStaleApplicationCount += 1;
        finishUnit();
        continue;
      }
      job.processedIds.add(candidate.stableId);
      const state = evaluatePersistentNaturalVisibility(
        generation,
        object,
        job.playerX,
        job.playerZ,
        job.nearVisibleStableIds,
      );
      applyPersistentNaturalVisibility(generation, object, state, job.sequence);
      if (job.commitStats) {
        accumulatePersistentNaturalVisibilityStats(job.stats, generation, object, state);
      }
      const waitFrames = persistentNaturalVisibilityFrameSequence - job.createdFrame;
      if (candidate.source === 'coverage') {
        persistentNaturalVisibilityMaximumCoverageWaitFrames = Math.max(
          persistentNaturalVisibilityMaximumCoverageWaitFrames,
          waitFrames,
        );
      } else if (candidate.source === 'entering') {
        persistentNaturalVisibilityMaximumEnteringWaitFrames = Math.max(
          persistentNaturalVisibilityMaximumEnteringWaitFrames,
          waitFrames,
        );
      } else if (candidate.source === 'leaving') {
        persistentNaturalVisibilityMaximumLeavingWaitFrames = Math.max(
          persistentNaturalVisibilityMaximumLeavingWaitFrames,
          waitFrames,
        );
        if (waitFrames > NATURAL_VISIBILITY_STARVATION_FRAMES) {
          persistentNaturalVisibilityStarvationCount += 1;
        }
      }
      processed += 1;
      finishUnit();
    }
    const remaining = persistentNaturalVisibilityQueueLength(job);
    persistentNaturalVisibilityMaximumQueueLength = Math.max(
      persistentNaturalVisibilityMaximumQueueLength,
      remaining,
    );
    if (remaining === 0 && persistentNaturalVisibilityJob === job) {
      if (job.commitStats) commitPersistentNaturalVisibilityStats(generation, job.stats);
      persistentNaturalVisibilityCompletedSequence = job.sequence;
      persistentNaturalVisibilityCompletedInputKey = job.inputKey;
      if (job.baseline) {
        generation.visibilityBaselineComplete = true;
        persistentNaturalVisibilityBaselineCompletedCount += 1;
      }
      persistentNaturalVisibilityJob = null;
    }
    if (processed > 0) {
      generation.treeLastUpdateAtMs = monotonicNow();
      if (treeLodDiagnosticsEnabled && !generation.treeLodDiagnostics) {
        createTreeLodDiagnostics(generation);
      } else if (generation.treeLodDiagnostics) {
        updateTreeLodDiagnostics(generation);
      }
    }
    const durationMs = monotonicNow() - startedAt;
    persistentNaturalVisibilityMaximumSliceMs = Math.max(
      persistentNaturalVisibilityMaximumSliceMs,
      durationMs,
    );
    return Object.freeze({ processed, remaining, durationMs });
  };

  const releaseComposedPersistentNaturalCoverage = generation => {
    const barrier = persistentNaturalVisibilityCoverageBarrier;
    if (!barrier || barrier.generation !== generation) return 0;
    const nearVisibleStableIds = readNearVisibleSnapshotState().stableIds;
    let released = 0;
    for (const stableId of barrier.stableIds) {
      if (nearVisibleStableIds.has(stableId)) {
        barrier.stableIds.delete(stableId);
        released += 1;
        continue;
      }
      const object = generation.canonicalObjects.get(stableId);
      if (!object || (object.visibilitySequence ?? 0) < barrier.sequence) continue;
      const stillDirty = object.instances.some(instance => (
        instance.bucket.dirtySlots?.has(instance.item.slot)
      ));
      if (stillDirty) continue;
      const distantVisible = (object.visibleLod === 'far' || object.visibleLod === 'mid')
        && object.presentationTier !== null
        && object.instances.some(instance => canonicalInstanceOpacity(object, instance.item) > 0);
      if (!distantVisible) {
        if (barrier.allowHiddenRelease) {
          barrier.stableIds.delete(stableId);
          persistentNaturalVisibilityCoverageBarrierSupersededDiscardCount += 1;
          released += 1;
          continue;
        }
        persistentNaturalVisibilityCoverageGapCount += 1;
        continue;
      }
      barrier.stableIds.delete(stableId);
      released += 1;
    }
    if (barrier.stableIds.size === 0) {
      persistentNaturalVisibilityCoverageBarrierReleasedCount += 1;
      persistentNaturalVisibilityCoverageBarrierMaximumHeldFrames = Math.max(
        persistentNaturalVisibilityCoverageBarrierMaximumHeldFrames,
        persistentNaturalVisibilityFrameSequence - barrier.createdFrame,
      );
      persistentNaturalVisibilityCoverageBarrier = null;
    }
    return released;
  };

  const releasePersistentNaturalBaselineCoverage = generation => {
    if (!persistentNaturalVisibilityRetainedGeneration
      || generation !== persistentTreeGeneration
      || generation?.visibilityBaselineComplete !== true
      || generation?.visibilityPlanApplied !== true
      || persistentNaturalVisibilityCoverageBarrier) return false;
    const ownersReady = [...generation.visibilityBaselineOwnerKeys].every(ownerKey => (
      persistentTreePublishedOwners.has(ownerKey)
        || !persistentTreeRetainedOwnerKeys.has(ownerKey)
    ));
    if (!ownersReady) return false;
    if (generation.root.parent !== scene) scene.add(generation.root);
    deferGenerationDispose(persistentNaturalVisibilityRetainedGeneration);
    persistentNaturalVisibilityRetainedGeneration = null;
    persistentNaturalVisibilityRetainedGenerationReleaseCount += 1;
    return true;
  };

  const applyPersistentNaturalRenderDistancePreset = renderDistancePreset => {
    if (!persistentTreeGeneration) return false;
    const preset = normalizeW8RenderDistancePreset(renderDistancePreset);
    persistentTreeGeneration.renderDistancePreset = preset;
    persistentTreeGeneration.renderDistancePolicy = resolveW8RenderDistancePolicy(preset);
    persistentTreeGeneration.settlementPresentationPolicy =
      resolveW8SettlementPresentationPolicy(persistentTreeGeneration.quality, preset);
    persistentTreeGeneration.naturalLodPolicies.clear();
    for (const material of new Set(persistentTreeGeneration.naturalLodMaterials.values())) {
      const mode = material.userData?.naturalLodMode;
      const kind = material.userData?.naturalLodKind;
      const uniforms = material.userData?.naturalLodUniforms;
      if (!mode || !kind || !uniforms) continue;
      const policy = resolveW8VegetationLodPolicy(kind, preset);
      const coarseTree = material.userData?.canonicalCoarseTree === true;
      const coarseNaturalPresence =
        material.userData?.canonicalCoarseNaturalPresence === true;
      const enter = coarseTree
        ? null
        : coarseNaturalPresence
          ? policy.coarsePresenceEntry
          : mode === 'far'
          ? policy.farEntry
          : mode === 'forest'
            ? policy.fullToForest
            : mode === 'atmospheric'
              ? (policy.forestToAtmospheric ?? policy.fullToForest)
              : null;
      const exit = coarseTree
        ? Object.freeze({
          minimum: PRESENTATION_OWNER_COARSE_VISIBILITY_METERS
            - PRESENTATION_OWNER_COARSE_FADE_METERS,
          maximum: PRESENTATION_OWNER_COARSE_VISIBILITY_METERS,
        })
        : coarseNaturalPresence
          ? policy.coarsePresenceFade
          : mode === 'far'
          ? policy.farFade
          : mode === 'full'
            ? policy.fullToForest
            : mode === 'forest' ? policy.forestToAtmospheric : policy.atmosphericFade;
      if (!exit) continue;
      uniforms.w8NaturalEnterStart.value = enter?.minimum ?? -1;
      uniforms.w8NaturalEnterEnd.value = enter?.maximum ?? 0;
      uniforms.w8NaturalExitStart.value = exit.minimum;
      uniforms.w8NaturalExitEnd.value = exit.maximum;
      uniforms.w8NaturalFogBlendStart.value = coarseNaturalPresence
        ? policy.coarsePresenceFogStartMeters
        : coarseTree || mode === 'far'
          ? policy.farEntry.minimum
          : policy.forestToAtmospheric?.minimum ?? policy.fullToForest.minimum;
      uniforms.w8NaturalVisibility.value = coarseTree
        ? PRESENTATION_OWNER_COARSE_VISIBILITY_METERS : policy.visibilityMeters;
    }
    persistentTreeVisibilityDirty = true;
    stagedPersistentNaturalRenderDistancePreset = null;
    return true;
  };

  const applyPersistentNaturalPolicyCoverage = (generation, coverageEntries) => {
    generation.naturalKindsByOwner.clear();
    generation.naturalPolicyCoverageProvided = Array.isArray(coverageEntries)
      && coverageEntries.length > 0;
    if (!generation.naturalPolicyCoverageProvided) return;
    generation.naturalCapacityByKind.clear();
    for (const entry of coverageEntries) {
      if (entry?.schemaVersion !== 'static-natural-policy-coverage-1'
        || !Object.values(W8_VEGETATION_LOD_KINDS).includes(entry.naturalKind)
        || !Number.isSafeInteger(entry.maximumCanonicalOwnerCount)
        || entry.maximumCanonicalOwnerCount < 1
        || !Number.isSafeInteger(entry.maximumManifestOwnerCount)
        || entry.maximumManifestOwnerCount < 0
        || !Array.isArray(entry.resourceKindEntries)) {
        throw new TypeError('invalid Static Natural policy coverage');
      }
      generation.naturalCapacityByKind.set(entry.naturalKind, Object.freeze({
        maximumCanonicalOwnerCount: entry.maximumCanonicalOwnerCount,
        maximumManifestOwnerCount: entry.maximumManifestOwnerCount,
      }));
      for (const resourceEntry of entry.resourceKindEntries) {
        if (!Array.isArray(resourceEntry) || resourceEntry.length !== 2) {
          throw new TypeError('invalid Static Natural owner resource coverage');
        }
        const [ownerKey, resourceKind] = resourceEntry;
        if (!isCanonicalNaturalResourceKind(resourceKind)) continue;
        if (!generation.naturalKindsByOwner.has(ownerKey)) {
          generation.naturalKindsByOwner.set(ownerKey, new Set());
        }
        generation.naturalKindsByOwner.get(ownerKey).add(entry.naturalKind);
      }
    }
  };

  const advancePersistentNaturalFrame = ({
    coverageGeneration,
    planRevision,
    planId,
    destructionRevision = null,
    playerLogicalX,
    playerLogicalZ,
    activeDataKeys = [],
    renderedKeys = [],
    readyPages = [],
  } = {}) => {
    if (!persistentTreeGeneration || disposed
      || coverageGeneration !== persistentTreeCoverageGeneration
      || planRevision !== persistentTreePlanRevision
      || planId !== persistentTreePlanId) return false;
    if (persistentTreeStateRevision !== destructionRevision) {
      if (persistentNaturalVisibilityJob?.generation === persistentTreeGeneration) {
        persistentNaturalVisibilitySupersededDiscardCount +=
          persistentNaturalVisibilityQueueLength(persistentNaturalVisibilityJob);
        persistentNaturalVisibilityJob = null;
      }
      persistentTreeVisibilityDirty = true;
      persistentNaturalVisibilityFullScanPending = true;
    }
    persistentTreeStateRevision = destructionRevision;
    persistentTreeGeneration.playerX = playerLogicalX;
    persistentTreeGeneration.playerZ = playerLogicalZ;
    // Distance/density selection is evaluated by the renderer from this
    // uniform. Keep it aligned with the frame's canonical Player position even
    // when the bounded Natural work slice is consumed by publication/build
    // work. Deferring this tiny material update to the visibility job can make
    // a prewarmed coarse silhouette appear several receipts after its owner
    // crosses firstPossibleVisibleAt.
    updateNaturalLodPlayerUniforms(
      persistentTreeGeneration,
      playerLogicalX,
      playerLogicalZ,
    );
    if (persistentTreeGeneration.activeDataKeysIdentity !== activeDataKeys) {
      persistentTreeGeneration.activeDataKeysIdentity = activeDataKeys;
      persistentTreeGeneration.activeKeys = new Set(activeDataKeys);
      persistentTreeVisibilityDirty = true;
    }
    if (persistentTreeGeneration.renderedKeysIdentity !== renderedKeys) {
      persistentTreeGeneration.renderedKeysIdentity = renderedKeys;
      persistentTreeGeneration.renderedKeys = new Set(renderedKeys);
      persistentTreeVisibilityDirty = true;
    }
    const retained = persistentTreeRetainedOwnerKeys;
    for (const page of readyPages) {
      // Direct 64 m canonical batches remain the exclusive coarse Tree authority.
      // Their 16 m owner views now also carry bounded canonical Rock presence,
      // so Presentation pages must still reach the persistent Natural builder;
      // naturalKindFilterForPage removes Tree from those pages below.
      if (!retained.has(page.ownerKey)) continue;
      if (!isCanonicalNaturalResourceKind(page.resourceKind)) {
        persistentTreeStalePageDiscardCount += 1;
        continue;
      }
      if (page.resourceKind === 'canonical') {
        // Full ChunkData is gameplay/detail availability only. It does not own
        // or rebuild the Presentation-derived Natural page.
        persistentNaturalDetailAvailableOwners.add(page.ownerKey);
        continue;
      }
      const desiredResourceKind = persistentTreeDesiredResourceKinds.get(page.ownerKey);
      if (desiredResourceKind && desiredResourceKind !== page.resourceKind) {
        persistentTreeStalePageDiscardCount += 1;
        continue;
      }
      persistentTreeAdmissionsSinceFrame += 1;
      if (Number.isSafeInteger(page.coverageGeneration)
        && page.coverageGeneration < coverageGeneration) {
        persistentTreeOlderCoveragePageCount += 1;
      }
      const existing = persistentTreePages.get(page.ownerKey);
      if (existing?.resourceKind === page.resourceKind
        && existing.contentHash === (page.value?.contentHash ?? null)) {
        persistentTreeOwnerReuseCount += 1;
        if (existing.coarseFillBand !== page.coarseFillBand) {
          persistentTreePages.set(page.ownerKey, Object.freeze({
            ...existing,
            coarseFillBand: page.coarseFillBand ?? 4,
          }));
        }
        const deadlineVisualEntry = page.schedulerRequired === true
          || Number.isFinite(page.deadlineAtMs);
        if (deadlineVisualEntry) {
          // A Resource-margin page can already be resident while its owner is
          // outside Visual Expected. When that immutable page is replayed on
          // visual entry, its last distance state may still be `hidden`.
          // Re-admit those identities to the one bounded visibility job so
          // the current player position is evaluated before the deadline.
          for (const stableId of existing.stableIds) {
            persistentNaturalVisibilityDirtyStableIds.add(stableId);
          }
          if (persistentNaturalVisibilityJob?.generation === persistentTreeGeneration) {
            persistentNaturalVisibilitySupersededDiscardCount +=
              persistentNaturalVisibilityQueueLength(persistentNaturalVisibilityJob);
            persistentNaturalVisibilityJob = null;
          }
          persistentTreeVisibilityDirty = true;
        }
        if (!deadlineVisualEntry && persistentTreePublishedOwners.has(page.ownerKey)
          && !persistentNaturalCoverageBlocksStableIds(existing.stableIds)
          && !persistentNaturalBaselineBlocksStableIds(existing.stableIds)) {
          publishStaticOwnerTickets?.({
            ownerKeys: Object.freeze([page.ownerKey]),
            publicationGroup: 'natural-static',
            coverageGeneration,
            planRevision,
          });
        } else {
          pendingPersistentTreePublications.set(page.ownerKey, {
            page: Object.freeze({ ...page, planId, coverageGeneration, planRevision }),
            stableIds: existing.stableIds,
            lightweight: existing.stableIds.length === 0,
            small: existing.stableIds.length > 0
              && existing.stableIds.length <= STATIC_NATURAL_SMALL_PAGE_SLOT_LIMIT,
          });
        }
        continue;
      }
      if (existing) persistentTreeOwnerRebuildCount += 1;
      if (pendingPersistentTreePages.has(page.ownerKey)) {
        persistentTreeDuplicatePageQueueCount += 1;
      }
      pendingPersistentTreePages.set(page.ownerKey, Object.freeze({
        ...page,
        planId,
        coverageGeneration,
        planRevision,
      }));
    }
    persistentNaturalFrameAdvanceCount += 1;
    return true;
  };

  const naturalKindFilterForPage = (generation, page) => {
    if (page?.resourceKind === DIRECT_CANONICAL_TREE_RESOURCE_KIND) {
      return new Set([W8_VEGETATION_LOD_KINDS.TREE]);
    }
    if (!generation.naturalPolicyCoverageProvided) {
      return directCanonicalTreeSupply && page?.resourceKind === 'presentation'
        ? new Set([
          W8_VEGETATION_LOD_KINDS.BUSH,
          W8_VEGETATION_LOD_KINDS.GRASS,
          W8_VEGETATION_LOD_KINDS.ROCK,
        ])
        : null;
    }
    const kinds = new Set(generation.naturalKindsByOwner.get(page.ownerKey) ?? []);
    if (directCanonicalTreeSupply && page?.resourceKind === 'presentation') {
      kinds.delete(W8_VEGETATION_LOD_KINDS.TREE);
    }
    return kinds;
  };

  const markAttributeRanges = (
    attribute,
    slots,
    itemSize,
    maximumRanges = Number.POSITIVE_INFINITY,
  ) => {
    if (!attribute || slots.length === 0) {
      return null;
    }
    const ordered = [...new Set(slots)].sort((left, right) => left - right);
    let rangeCount = 0;
    let componentCount = 0;
    if (typeof attribute.clearUpdateRanges === 'function'
      && typeof attribute.addUpdateRange === 'function') {
      // More than one bounded composer can touch the same attribute before a
      // render (notably receipt-backed Near reconciliation followed by the
      // ordinary dirty-page slice). Three consumes the union at render time;
      // replacing the first pending ranges here leaves CPU slot metadata ahead
      // of GPU matrix/anchor/rank state and invalidates the whole coarse mesh.
      const componentRanges = [];
      for (const range of attribute.updateRanges ?? []) {
        const start = Number(range?.start ?? range?.offset);
        const count = Number(range?.count);
        if (!Number.isSafeInteger(start) || start < 0
          || !Number.isSafeInteger(count) || count <= 0) continue;
        componentRanges.push({ start, end: start + count });
      }
      for (const slot of ordered) {
        componentRanges.push({
          start: slot * itemSize,
          end: (slot + 1) * itemSize,
        });
      }
      componentRanges.sort((left, right) => left.start - right.start || left.end - right.end);
      const merged = [];
      for (const range of componentRanges) {
        const previous = merged.at(-1);
        if (previous && range.start <= previous.end) {
          previous.end = Math.max(previous.end, range.end);
        } else merged.push({ ...range });
      }
      attribute.clearUpdateRanges();
      if (merged.length > maximumRanges) {
        const start = merged[0].start;
        const end = merged.at(-1).end;
        attribute.addUpdateRange(start, end - start);
        rangeCount = 1;
        componentCount = end - start;
      } else {
        for (const range of merged) {
          attribute.addUpdateRange(range.start, range.end - range.start);
          componentCount += range.end - range.start;
        }
        rangeCount = merged.length;
      }
    } else if (attribute.updateRange) {
      const nextStart = ordered[0] * itemSize;
      const nextEnd = (ordered.at(-1) + 1) * itemSize;
      const previousStart = Number(attribute.updateRange.offset);
      const previousCount = Number(attribute.updateRange.count);
      const start = Number.isSafeInteger(previousStart) && previousStart >= 0
        && Number.isSafeInteger(previousCount) && previousCount > 0
        ? Math.min(previousStart, nextStart) : nextStart;
      const end = Number.isSafeInteger(previousStart) && previousStart >= 0
        && Number.isSafeInteger(previousCount) && previousCount > 0
        ? Math.max(previousStart + previousCount, nextEnd) : nextEnd;
      attribute.updateRange.offset = start;
      attribute.updateRange.count = end - start;
      rangeCount = 1;
      componentCount = end - start;
    } else {
      rangeCount = 1;
      componentCount = ordered.length * itemSize;
    }
    attribute.needsUpdate = true;
    return Object.freeze({
      rangeCount,
      componentCount,
      byteCount: componentCount * Float32Array.BYTES_PER_ELEMENT,
    });
  };

  const suppressPublishedNearDistantBuildings = () => {
    const generation = persistentDistantPublishedGeneration ?? activeGeneration;
    if (!generation?.persistentDistant) return 0;
    const nearStableIds = readNearVisibleSnapshotState().stableIds;
    if (!nearStableIds.size) return 0;
    const slotsByBucket = new Map();
    const hidden = hiddenCanonicalMatrix();
    for (const stableId of nearStableIds) {
      const object = generation.canonicalObjects.get(stableId);
      if (object?.record?.featureType !== 'settlement-building') continue;
      for (const instance of object.instances) {
        const { bucket, item } = instance;
        const slot = item.slot;
        if (!bucket?.persistent || !bucket.mesh || !Number.isSafeInteger(slot)
          || bucket.mesh.userData?.canonicalStableIds?.[slot] !== stableId) continue;
        bucket.mesh.setMatrixAt(slot, hidden);
        bucket.mesh.userData.canonicalStableIds[slot] = null;
        if (bucket.mesh.userData.canonicalObjects) {
          bucket.mesh.userData.canonicalObjects[slot] = null;
        }
        if (bucket.mesh.userData.canonicalOpacities) {
          bucket.mesh.userData.canonicalOpacities[slot] = 0;
        }
        writeLocalHandoffOpacity(bucket, slot, 0);
        if (!slotsByBucket.has(bucket)) slotsByBucket.set(bucket, []);
        slotsByBucket.get(bucket).push(slot);
      }
      generation.distantVisibleStableIds?.delete?.(stableId);
    }
    let suppressed = 0;
    for (const [bucket, slots] of slotsByBucket) {
      const matrixUpload = markAttributeRanges(bucket.mesh.instanceMatrix, slots, 16);
      const opacityUpload = markAttributeRanges(bucket.localHandoffOpacityAttribute, slots, 1);
      const uploadBytes = (matrixUpload?.byteCount ?? 0) + (opacityUpload?.byteCount ?? 0);
      suppressed += slots.length;
      bucket.mesh.userData.visibleInstanceCount = (
        bucket.mesh.userData.canonicalStableIds?.filter(Boolean).length ?? 0
      );
      bucket.mesh.boundingBox = null;
      bucket.mesh.boundingSphere = null;
      if (typeof bucket.mesh.computeBoundingSphere === 'function') {
        bucket.mesh.computeBoundingSphere();
      }
      distantPersistentMatrixUpdateCount += slots.length;
      distantPersistentBufferUpdateCount += Number(Boolean(matrixUpload))
        + Number(Boolean(opacityUpload));
      distantPersistentUploadByteCount += uploadBytes;
      distantPersistentMaximumMatrixUpdatesPerFrame = Math.max(
        distantPersistentMaximumMatrixUpdatesPerFrame,
        slots.length,
      );
      distantPersistentMaximumBufferUpdatesPerFrame = Math.max(
        distantPersistentMaximumBufferUpdatesPerFrame,
        Number(Boolean(matrixUpload)) + Number(Boolean(opacityUpload)),
      );
      distantPersistentMaximumUploadBytesPerFrame = Math.max(
        distantPersistentMaximumUploadBytesPerFrame,
        uploadBytes,
      );
      distantPersistentBoundsRecalculationCount += 1;
    }
    return suppressed;
  };

  const composePersistentTreeDirtyRanges = (
    generation,
    budgetMs = STATIC_TREE_PAGE_FRAME_BUDGET_MS,
    unitLimit = STATIC_TREE_PAGE_UNIT_LIMIT,
    targetSlotsByBucket = null,
  ) => {
    if (!generation) return Object.freeze({ matrices: 0, attributes: 0, buckets: 0 });
    const startedAt = monotonicNow();
    let matrixUpdates = 0;
    let attributeUpdates = 0;
    let bufferRangeUpdates = 0;
    let bufferUploadBytes = 0;
    let bucketUpdates = 0;
    transform.scale.set(0, 0, 0);
    transform.updateMatrix();
    const hidden = transform.matrix.clone?.() ?? structuredClone(transform.matrix);
    const bucketEntries = targetSlotsByBucket instanceof Map
      ? targetSlotsByBucket.entries()
      : [...generation.canonicalBuckets.values()].map(bucket => [bucket, bucket.dirtySlots]);
    for (const [bucket, requestedSlots] of bucketEntries) {
      for (const slot of bucket.dirtySlots ?? []) {
        if (slot < 0 || slot >= bucket.items.length) bucket.dirtySlots.delete(slot);
      }
      const slots = [...(requestedSlots ?? [])]
        .filter(slot => (bucket.dirtySlots?.has(slot) ?? false)
          && slot >= 0 && slot < bucket.items.length);
      if (!(targetSlotsByBucket instanceof Map)) {
        slots.sort((left, right) => left - right);
      }
      if (!bucket.mesh || slots.length === 0) continue;
      const processedSlots = [];
      for (const slot of slots) {
        if (matrixUpdates >= unitLimit
          || monotonicNow() - startedAt >= budgetMs) break;
        const item = bucket.items[slot];
        const coarseTreeSubmitted = item.object?.canonicalCoarseTree !== true
          || item.coarseTreeSubmitted === true;
        const opacity = coarseTreeSubmitted
          ? canonicalInstanceOpacity(item.object, item) : 0;
        if (isSettlementRoadBucket(bucket)) {
          bucket.dirtySlots.delete(slot);
          processedSlots.push(slot);
          matrixUpdates += 1;
          continue;
        }
        bucket.mesh.setMatrixAt(slot, opacity > 0 ? item.matrix : hidden);
        writeNaturalAnchor(bucket, slot, item.object, generation);
        writeNaturalInitialReveal(bucket, slot, item.object, generation, item);
        writeLocalHandoffOpacity(bucket, slot, opacity);
        bucket.mesh.userData.canonicalStableIds[slot] = opacity > 0
          ? item.object.stableId : null;
        bucket.mesh.userData.canonicalObjects[slot] = opacity > 0
          ? item.object.record : null;
        bucket.mesh.userData.canonicalOpacities[slot] = opacity;
        bucket.dirtySlots.delete(slot);
        processedSlots.push(slot);
        matrixUpdates += 1;
      }
      if (processedSlots.length === 0) break;
      if (isSettlementRoadBucket(bucket)) {
        composeCanonicalBucket(generation, bucket);
        bucket.dirtySlots.clear();
        bucketUpdates += 1;
        if (matrixUpdates >= unitLimit || monotonicNow() - startedAt >= budgetMs) break;
        continue;
      }
      bucket.mesh.count = isPersistentCoarseTreeBucket(bucket)
        ? (bucket.coarseTreeSubmittedCount ?? 0) : bucket.items.length;
      bucket.mesh.userData.canonicalVisualRevision =
        (bucket.mesh.userData.canonicalVisualRevision ?? 0) + 1;
      const matrixUpload = markAttributeRanges(bucket.mesh.instanceMatrix, processedSlots, 16);
      const anchorUpload = markAttributeRanges(
        bucket.naturalAnchorAttribute,
        processedSlots,
        2,
      );
      const revealUpload = markAttributeRanges(
        bucket.naturalInitialRevealAttribute,
        processedSlots,
        1,
      );
      const handoffUpload = markAttributeRanges(
        bucket.localHandoffOpacityAttribute,
        processedSlots,
        1,
      );
      bucket.mesh.boundingBox = null;
      bucket.mesh.boundingSphere = null;
      attributeUpdates += Number(Boolean(bucket.mesh.instanceMatrix))
        + Number(Boolean(bucket.naturalAnchorAttribute))
        + Number(Boolean(bucket.naturalInitialRevealAttribute))
        + Number(Boolean(bucket.localHandoffOpacityAttribute));
      bufferRangeUpdates += (matrixUpload?.rangeCount ?? 0)
        + (anchorUpload?.rangeCount ?? 0)
        + (revealUpload?.rangeCount ?? 0)
        + (handoffUpload?.rangeCount ?? 0);
      bufferUploadBytes += (matrixUpload?.byteCount ?? 0)
        + (anchorUpload?.byteCount ?? 0)
        + (revealUpload?.byteCount ?? 0)
        + (handoffUpload?.byteCount ?? 0);
      bucketUpdates += 1;
      if (matrixUpdates >= unitLimit || monotonicNow() - startedAt >= budgetMs) break;
    }
    transform.scale.set(1, 1, 1);
    transform.updateMatrix();
    generation.stats.canonicalComposeCount += Number(bucketUpdates > 0);
    generation.stats.canonicalDirtyBucketCount += bucketUpdates;
    generation.stats.canonicalMatrixUpdateCount += matrixUpdates;
    generation.stats.canonicalNeedsUpdateCount += bucketUpdates;
    if (!(targetSlotsByBucket instanceof Map)) {
      generation.distantVisibleStableIds = new Set(
        [...generation.canonicalBuckets.values()].flatMap(bucket => (
          (bucket.mesh?.userData?.canonicalStableIds ?? []).filter((stableId, slot) => (
            stableId && (bucket.mesh?.userData?.canonicalOpacities?.[slot] ?? 0) > 0
          ))
        )),
      );
    }
    persistentTreeMatrixUpdateCount += matrixUpdates;
    persistentTreeAttributeUpdateCount += attributeUpdates;
    persistentTreeBufferRangeUpdateCount += bufferRangeUpdates;
    persistentTreeBufferUploadByteCount += bufferUploadBytes;
    persistentTreeMaximumSliceMs = Math.max(
      persistentTreeMaximumSliceMs,
      monotonicNow() - startedAt,
    );
    return Object.freeze({
      matrices: matrixUpdates,
      attributes: attributeUpdates,
      buckets: bucketUpdates,
      bufferRangeUpdates,
      bufferUploadBytes,
      durationMs: monotonicNow() - startedAt,
    });
  };

  const composePersistentNaturalStableIdsImmediately = (
    generation,
    stableIds,
    targetSlotsByBucket,
  ) => {
    if (!(targetSlotsByBucket instanceof Map) || targetSlotsByBucket.size === 0) return 0;
    const result = composePersistentTreeDirtyRanges(
      generation,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER,
      targetSlotsByBucket,
    );
    for (const stableId of stableIds) {
      const object = generation.canonicalObjects.get(stableId);
      const visible = object?.instances?.some?.(({ bucket, item }) => (
        Number.isSafeInteger(item.slot)
          && item.slot >= 0
          && item.slot < (bucket.mesh?.count ?? 0)
          && bucket.mesh?.userData?.canonicalStableIds?.[item.slot] === stableId
          && (bucket.mesh?.userData?.canonicalOpacities?.[item.slot] ?? 0) > 0
      )) === true;
      if (visible) generation.distantVisibleStableIds.add(stableId);
      else generation.distantVisibleStableIds.delete(stableId);
    }
    return result.matrices;
  };

  // Reconcile the renderer-confirmed Near set synchronously before the next
  // draw. An arriving Stable ID suppresses coarse only after it appears in this
  // receipt-backed snapshot; a departing ID restores its resident coarse slot
  // in the same update. This is the two sides of the existing receipt barrier,
  // not another handoff state or queue.
  const reconcileNearPublicationsImmediately = generation => {
    const nearState = readNearVisibleSnapshotState();
    const previousNear = generation.nearVisibleStableIds ?? new Set();
    const departed = [...previousNear].filter(stableId => (
      !nearState.stableIds.has(stableId) && generation.canonicalObjects.has(stableId)
    ));
    const arrived = [...nearState.stableIds].filter(stableId => (
      !previousNear.has(stableId) && generation.canonicalObjects.has(stableId)
    ));
    const changedStableIds = [...new Set([...arrived, ...departed])];
    if (changedStableIds.length === 0) return 0;
    if (persistentNaturalVisibilityJob?.generation === generation) {
      persistentNaturalVisibilitySupersededDiscardCount +=
        persistentNaturalVisibilityQueueLength(persistentNaturalVisibilityJob);
      persistentNaturalVisibilityJob = null;
    }
    const sequence = ++persistentNaturalVisibilitySequence;
    const immediateSlotsByBucket = new Map();
    const rememberImmediateSlots = object => {
      for (const { bucket, item } of object?.instances ?? []) {
        if (!Number.isSafeInteger(item.slot)) continue;
        if (!immediateSlotsByBucket.has(bucket)) immediateSlotsByBucket.set(bucket, new Set());
        immediateSlotsByBucket.get(bucket).add(item.slot);
      }
    };
    for (const stableId of changedStableIds) {
      const object = generation.canonicalObjects.get(stableId);
      // A dense-prefix toggle swaps at most one counterpart. Capturing the
      // changed object's slot before and after the visibility decision gives
      // the exact two GPU ranges without draining unrelated dirty work.
      rememberImmediateSlots(object);
      const state = evaluatePersistentNaturalVisibility(
        generation,
        object,
        generation.playerX,
        generation.playerZ,
        nearState.stableIds,
      );
      applyPersistentNaturalVisibility(generation, object, state, sequence);
      rememberImmediateSlots(object);
    }
    generation.nearVisibleStableIds = new Set(nearState.stableIds);
    generation.nearVisibleStableSignature = nearState.signature;
    generation.visibilityDesiredInput = {
      nearVisibleStableIds: new Set(nearState.stableIds),
      activeKeys: new Set(generation.activeKeys),
      renderedKeys: new Set(generation.renderedKeys),
    };
    persistentNaturalVisibilityCompletedInputKey = null;
    persistentTreeVisibilityDirty = true;
    const composed = composePersistentNaturalStableIdsImmediately(
      generation,
      changedStableIds,
      immediateSlotsByBucket,
    );
    releaseComposedPersistentNaturalCoverage(generation);
    return composed;
  };

  const removePersistentNaturalInstance = instance => {
    const { bucket, item } = instance;
    if (item?.object?.canonicalCoarseTree === true
      && item.coarseTreeSubmitted === true) {
      setPersistentCoarseTreeItemSubmitted(bucket, item, false);
    }
    const slot = item.slot;
    if (!Number.isSafeInteger(slot) || bucket.items[slot] !== item) return false;
    const last = bucket.items.pop();
    if (last && last !== item) {
      bucket.items[slot] = last;
      last.slot = slot;
      bucket.dirtySlots ??= new Set();
      bucket.dirtySlots.add(slot);
      persistentTreeCompactionMoveCount += 1;
    }
    item.slot = -1;
    if (bucket.mesh?.userData) {
      bucket.mesh.userData.canonicalVisualRevision =
        (bucket.mesh.userData.canonicalVisualRevision ?? 0) + 1;
    }
    if (bucket.mesh) {
      bucket.mesh.count = isPersistentCoarseTreeBucket(bucket)
        ? Math.min(bucket.coarseTreeSubmittedCount ?? 0, bucket.items.length)
        : bucket.items.length;
    }
    return true;
  };

  const markPersistentNaturalInstanceDirty = instance => {
    if (!Number.isSafeInteger(instance?.item?.slot)) return;
    instance.bucket.dirtySlots ??= new Set();
    instance.bucket.dirtySlots.add(instance.item.slot);
  };

  const removePersistentNaturalOwner = ownerKey => {
    const page = persistentTreePages.get(ownerKey);
    if (!page || !persistentTreeGeneration) return false;
    const roadBuckets = new Set();
    for (const stableId of page.stableIds) {
      persistentNaturalVisibilityDirtyStableIds.delete(stableId);
      const object = persistentTreeGeneration.canonicalObjects.get(stableId);
      if (!object) continue;
      for (const instance of [...object.instances]) {
        if (isSettlementRoadBucket(instance.bucket)) roadBuckets.add(instance.bucket);
        removePersistentNaturalInstance(instance);
      }
      persistentTreeGeneration.canonicalObjects.delete(stableId);
    }
    for (const bucket of roadBuckets) {
      composeCanonicalBucket(persistentTreeGeneration, bucket);
      bucket.dirtySlots?.clear?.();
    }
    persistentTreeGeneration.distantVisibleStableIds = new Set(
      [...persistentTreeGeneration.canonicalBuckets.values()].flatMap(bucket => (
        (bucket.mesh?.userData?.canonicalStableIds ?? []).filter((stableId, slot) => (
          stableId && (bucket.mesh?.userData?.canonicalOpacities?.[slot] ?? 0) > 0
        ))
      )),
    );
    persistentTreePages.delete(ownerKey);
    pendingPersistentTreePublications.delete(ownerKey);
    for (const publishedOwnerKey of page.ownerKeys ?? [ownerKey]) {
      persistentNaturalDetailAvailableOwners.delete(publishedOwnerKey);
      persistentTreePublishedOwners.delete(publishedOwnerKey);
    }
    persistentTreeOwnerDisposeCount += 1;
    persistentNaturalVisibilityObjectRevision += 1;
    persistentTreeGeneration.coarseTreeSubmissionObjectRevision =
      persistentNaturalVisibilityObjectRevision;
    persistentTreeVisibilityDirty = true;
    return true;
  };

  const directCanonicalTreePage = batch => {
    if (batch?.schemaVersion !== W8_CANONICAL_TREE_CELL_SCHEMA
      || typeof batch.key !== 'string'
      || !Array.isArray(batch.ownerKeys)
      || batch.ownerKeys.length !== MACRO_OWNERS_PER_AXIS ** 2
      || !Array.isArray(batch.trees)) {
      throw new TypeError('canonical Tree cell batch is required');
    }
    const ownerKeySet = new Set(batch.ownerKeys);
    const vegetation = Object.freeze(batch.trees.map(record => {
      if (record?.objectType !== 'tree' || !ownerKeySet.has(record.owner)) {
        throw new Error(`canonical Tree cell contains an invalid record: ${record?.stableId}`);
      }
      return expandPresentationNaturalRecord(record);
    }));
    const ownerKey = `${DIRECT_CANONICAL_TREE_PAGE_PREFIX}${batch.key}`;
    const value = Object.freeze({
      schemaVersion: 'w8-direct-canonical-tree-page-1',
      chunkId: `direct-tree:${batch.contentHash}`,
      contentHash: batch.contentHash,
      generatorVersion: Object.freeze({ major: 800, minor: 0, patch: 0 }),
      presentationLayers: Object.freeze({
        natural: Object.freeze({ vegetation, rocks: Object.freeze([]) }),
      }),
    });
    return Object.freeze({
      ownerKey,
      ownerKeys: Object.freeze([...batch.ownerKeys]),
      macroCellKey: batch.key,
      resourceKind: DIRECT_CANONICAL_TREE_RESOURCE_KIND,
      contentHash: batch.contentHash,
      value,
      readyAtMs: monotonicNow(),
      required: true,
      schedulerRequired: true,
      coarseFillBand: 0,
      coverageGeneration: persistentTreeCoverageGeneration,
      planRevision: persistentTreePlanRevision,
      planId: persistentTreePlanId,
    });
  };

  const enqueueDirectCanonicalTreeBatch = batch => {
    if (!persistentTreeGeneration || !batch) return false;
    const page = directCanonicalTreePage(batch);
    const resident = persistentTreePages.get(page.ownerKey);
    if (resident?.contentHash === page.contentHash) return true;
    pendingPersistentTreePages.set(page.ownerKey, page);
    persistentTreeAdmissionsSinceFrame += 1;
    return true;
  };

  const enqueueNextRetainedDirectCanonicalTreeBatch = () => {
    if (!persistentTreeGeneration || !directCanonicalTreeSupply) return false;
    for (const batch of directCanonicalTreeCells.values()) {
      const pageKey = `${DIRECT_CANONICAL_TREE_PAGE_PREFIX}${batch.key}`;
      if (persistentTreePages.has(pageKey)
        || pendingPersistentTreePages.has(pageKey)
        || pendingPersistentTreePublications.has(pageKey)) continue;
      return enqueueDirectCanonicalTreeBatch(batch);
    }
    return false;
  };

  stageDirectCanonicalTreeCell = batch => {
    if (!directCanonicalTreeSupply || batch?.schemaVersion !== W8_CANONICAL_TREE_CELL_SCHEMA) {
      return false;
    }
    directCanonicalTreeCells.set(batch.key, batch);
    for (const ownerKey of batch.ownerKeys) directCanonicalTreeOwnerKeys.add(ownerKey);
    return !persistentTreeGeneration || enqueueDirectCanonicalTreeBatch(batch);
  };

  retireDirectCanonicalTreeCell = key => {
    const batch = directCanonicalTreeCells.get(key);
    if (!batch) return false;
    directCanonicalTreeCells.delete(key);
    for (const ownerKey of batch.ownerKeys) directCanonicalTreeOwnerKeys.delete(ownerKey);
    const pageKey = `${DIRECT_CANONICAL_TREE_PAGE_PREFIX}${key}`;
    pendingPersistentTreePages.delete(pageKey);
    pendingPersistentTreePublications.delete(pageKey);
    if (persistentTreePages.has(pageKey) && !persistentTreeDisposeOwners.includes(pageKey)) {
      persistentTreeDisposeOwners.push(pageKey);
    }
    return true;
  };

  const publishPersistentNaturalOwner = (
    page,
    stableIds,
    composeResult,
  ) => {
    const publicationOwnerKeys = Object.freeze([...(page.ownerKeys ?? [page.ownerKey])]);
    const tickets = publishStaticOwnerTickets?.({
      ownerKeys: publicationOwnerKeys,
      publicationGroup: 'natural-static',
      coverageGeneration: page.coverageGeneration,
      planRevision: page.planRevision,
    }) ?? Object.freeze([]);
    persistentTreePublishedOwnerCount += 1;
    for (const ownerKey of publicationOwnerKeys) persistentTreePublishedOwners.add(ownerKey);
    const waitMs = Math.max(0, monotonicNow() - page.readyAtMs);
    persistentTreeLastPublicationWaitMs = waitMs;
    persistentTreeMaximumPublicationWaitMs = Math.max(
      persistentTreeMaximumPublicationWaitMs,
      waitMs,
    );
    if (!streamingTelemetry) return;
    const stableIdsByTarget = new Map();
    for (const stableId of stableIds) {
      const object = persistentTreeGeneration?.canonicalObjects.get(stableId);
      const target = worldStreamingTargetForCanonicalObject(object?.record ?? object);
      if (!target) continue;
      if (!stableIdsByTarget.has(target)) stableIdsByTarget.set(target, []);
      stableIdsByTarget.get(target).push(stableId);
    }
    for (const [target, targetStableIds] of stableIdsByTarget) {
      const details = {
        target,
        stream: WORLD_STREAMING_STREAM.DISTANT,
        resourceKey: page.ownerKey,
        ownerKey: page.ownerKey,
        stableId: targetStableIds[0] ?? null,
        planId: page.planId,
        metadata: {
          instanceOwnerCount: targetStableIds.length,
          ticketCount: tickets.length,
          coverageGeneration: page.coverageGeneration,
          planRevision: page.planRevision,
          matrixUpdates: composeResult.matrices,
          attributeUpdates: composeResult.attributes,
        },
      };
      const event = streamingTelemetry.record(WORLD_STREAMING_EVENT.PUBLISH, details);
      pendingStaticTreeFirstDraw.push({
        ...details,
        correlationId: event?.correlationId ?? null,
      });
    }
  };

  const mergeNumericStats = (target, source) => {
    for (const [key, value] of Object.entries(source)) {
      if (Number.isFinite(value) && Number.isFinite(target[key])) target[key] += value;
    }
  };

  const buildPersistentNaturalOwner = async (
    page,
    budgetMs = STATIC_TREE_PAGE_FRAME_BUDGET_MS,
  ) => {
    const generation = persistentTreeGeneration;
    if (!generation || !page.value) return;
    const buildStartedAt = monotonicNow();
    const cooperativeBuildBudgetMs = Math.max(0.25, budgetMs * 0.75);
    const objectCountBefore = streamingTelemetry ? generation.canonicalObjects.size : 0;
    const bucketCountBefore = streamingTelemetry ? generation.canonicalBuckets.size : 0;
    const instanceCountBefore = streamingTelemetry
      ? [...generation.canonicalBuckets.values()]
        .reduce((sum, bucket) => sum + bucket.items.length, 0)
      : 0;
    const stagedGeneration = {
      ...generation,
      persistentNatural: false,
      persistentTree: false,
      persistentDistant: false,
      canonicalBuckets: new Map(),
      canonicalObjects: new Map(),
      currentPageStableIds: [],
      currentPageBuckets: new Set(),
      ownedGeometries: new Set(),
      ownedMaterials: new Set(),
      naturalLodMaterials: new Map(),
      naturalLodPolicies: new Map(generation.naturalLodPolicies),
      stats: createStats(),
    };
    const scheduler = createSliceScheduler({
      budgetMs: cooperativeBuildBudgetMs,
      unitLimit: STATIC_TREE_PAGE_UNIT_LIMIT,
      workKind: 'natural',
      assertCurrent: () => {
        if (disposed || generation !== persistentTreeGeneration) throw SYNC_CANCELLED;
      },
    });
    const context = {
      target: generation.root,
      ownedGeometries: stagedGeneration.ownedGeometries,
      stats: stagedGeneration.stats,
      generation: stagedGeneration,
      surfacePolicy: generation.surfacePolicy,
    };
    const pageNaturalKinds = naturalKindFilterForPage(generation, page)
      ?? new Set(Object.values(W8_VEGETATION_LOD_KINDS));
    const coarseKinds = new Set(pageNaturalKinds);
    await addCanonicalChunk({
      chunk: page.value,
      origin: {
        renderOriginChunkX: generation.buildOriginChunkX,
        renderOriginChunkZ: generation.buildOriginChunkZ,
      },
      includeNatural: true,
      farNaturalEligible: true,
      naturalKindFilter: coarseKinds,
      context,
      scheduler,
    });
    // PresentationOwner's persistent page is the shared coarse release artifact.
    // Tree keeps its canonical low-poly silhouette. Non-Tree density is already
    // bounded by the Macro Natural-presence producer; this stage only expands
    // those compact real records into one coarse silhouette.
    const stableIds = stagedGeneration.currentPageStableIds;
    for (const object of stagedGeneration.canonicalObjects.values()) {
      object.persistentNaturalHasLocalPresentation = false;
    }
    for (const bucket of stagedGeneration.canonicalBuckets.values()) {
      for (const item of bucket.items) {
        item.object.instances.push({ bucket, item });
        if (item.visibilityTiers.includes('full')
          || item.visibilityTiers.includes('natural-lod')) {
          item.object.persistentNaturalHasLocalPresentation = true;
        }
      }
    }
    for (const object of stagedGeneration.canonicalObjects.values()) {
      if (!object.naturalKind) continue;
      const naturalLodPolicy = naturalLodPolicyFor(generation, object.naturalKind);
      const exactNaturalVisibility = Math.min(
        object.record.lodPolicy
          ? resolveW8ObjectVisibilityMeters(object.record, generation.renderDistancePreset)
          : generation.renderDistancePolicy.naturalDetailDistanceMeters,
        naturalLodPolicy.visibilityMeters,
      );
      object.persistentNaturalLodPolicy = naturalLodPolicy;
      object.persistentNaturalExactVisibilityMeters = exactNaturalVisibility;
      object.persistentNaturalVisibilityMeters = naturalLodPolicy.visibilityMeters;
    }
    // A PresentationOwner page is born into the persistent coarse contract.
    // Initializing it through the legacy 300 m visibility evaluator leaves the
    // 300–owner-corner safety shell hidden until a later bounded visibility
    // slice. Resolve the same persistent state used after publication now, so
    // the immutable far-density prefix is ready before the owner can become
    // Visual Expected. Renderer slots are still committed and uploaded only by
    // the existing bounded compose/publication path below.
    const stagedNearStableIds = readNearVisibleSnapshotState().stableIds;
    for (const object of stagedGeneration.canonicalObjects.values()) {
      assignPersistentNaturalVisibilityState(
        object,
        evaluatePersistentNaturalVisibility(
          stagedGeneration,
          object,
          generation.playerX,
          generation.playerZ,
          stagedNearStableIds,
        ),
        persistentNaturalVisibilitySequence,
      );
    }

    const previousPage = persistentTreePages.get(page.ownerKey) ?? null;
    const previousStableIds = new Set(previousPage?.stableIds ?? []);
    const stagedItemsForBucket = stagedBucket => stagedBucket.items;
    const previousCountByBucket = new Map();
    for (const stableId of previousStableIds) {
      const object = generation.canonicalObjects.get(stableId);
      for (const instance of object?.instances ?? []) {
        previousCountByBucket.set(
          instance.bucket.key,
          (previousCountByBucket.get(instance.bucket.key) ?? 0) + 1,
        );
      }
    }
    for (const object of stagedGeneration.canonicalObjects.values()) {
      const existing = generation.canonicalObjects.get(object.stableId);
      if (!existing) continue;
      if (!previousStableIds.has(object.stableId)
        || !(page.ownerKeys ?? [page.ownerKey]).includes(existing.ownerKey)
        || existing.identityKey !== object.identityKey) {
        throw new Error(`persistent Natural owner identity collision: ${object.stableId}`);
      }
    }

    const preparedBuckets = new Map();
    const previousOwnedGeometries = new Set(generation.ownedGeometries);
    const previousOwnedMaterials = new Set(generation.ownedMaterials);
    const previousNaturalMaterialKeys = new Set(generation.naturalLodMaterials.keys());
    const preparationContext = {
      target: generation.root,
      ownedGeometries: generation.ownedGeometries,
      stats: generation.stats,
      generation,
      surfacePolicy: generation.surfacePolicy,
    };
    try {
      for (const stagedBucket of stagedGeneration.canonicalBuckets.values()) {
        const stagedItems = stagedItemsForBucket(stagedBucket);
        const existingBucket = generation.canonicalBuckets.get(stagedBucket.key) ?? null;
        const requiredSlots = (existingBucket?.items.length ?? 0)
          - (previousCountByBucket.get(stagedBucket.key) ?? 0)
          + stagedItems.length;
        const capacity = resolvePersistentPresentationBucketCapacity({
          generation,
          bucket: stagedBucket,
          requiredSlots,
        });
        if (existingBucket) {
          if (requiredSlots > existingBucket.capacity) {
            throw new RangeError([
              `persistent Natural bucket capacity exceeded: ${stagedBucket.key}`,
              `required=${requiredSlots}`,
              `capacity=${existingBucket.capacity}`,
            ].join(' '));
          }
          preparedBuckets.set(stagedBucket.key, { bucket: existingBucket, prepared: null });
          continue;
        }
        const bucket = {
          ...stagedBucket,
          items: [...stagedItems],
          capacity,
          persistent: true,
          dirtySlots: new Set(),
          ...(stagedItems.some(item => item.object?.canonicalCoarseTree === true) ? {
            coarseTreeSubmittedCount: 0,
          } : {}),
        };
        const prepared = prepareCanonicalBucketMesh(bucket, preparationContext);
        bucket.items = [];
        preparedBuckets.set(stagedBucket.key, { bucket, prepared });
      }
    } catch (error) {
      for (const geometry of generation.ownedGeometries) {
        if (!previousOwnedGeometries.has(geometry)) {
          geometry.dispose?.();
          generation.ownedGeometries.delete(geometry);
        }
      }
      for (const material of generation.ownedMaterials) {
        if (!previousOwnedMaterials.has(material)) {
          material.dispose?.();
          generation.ownedMaterials.delete(material);
        }
      }
      for (const key of generation.naturalLodMaterials.keys()) {
        if (!previousNaturalMaterialKeys.has(key)) generation.naturalLodMaterials.delete(key);
      }
      throw error;
    }

    const desiredResourceKind = persistentTreeDesiredResourceKinds.get(page.ownerKey);
    if (disposed || generation !== persistentTreeGeneration
      || (page.resourceKind === DIRECT_CANONICAL_TREE_RESOURCE_KIND
        ? !directCanonicalTreeCells.has(page.macroCellKey)
        : desiredResourceKind && desiredResourceKind !== page.resourceKind)) {
      for (const geometry of generation.ownedGeometries) {
        if (!previousOwnedGeometries.has(geometry)) {
          geometry.dispose?.();
          generation.ownedGeometries.delete(geometry);
        }
      }
      for (const material of generation.ownedMaterials) {
        if (!previousOwnedMaterials.has(material)) {
          material.dispose?.();
          generation.ownedMaterials.delete(material);
        }
      }
      for (const key of generation.naturalLodMaterials.keys()) {
        if (!previousNaturalMaterialKeys.has(key)) generation.naturalLodMaterials.delete(key);
      }
      persistentTreeStalePageDiscardCount += 1;
      return null;
    }
    removePersistentNaturalOwner(page.ownerKey);
    for (const { bucket, prepared } of preparedBuckets.values()) {
      if (!generation.canonicalBuckets.has(bucket.key)) {
        generation.canonicalBuckets.set(bucket.key, bucket);
        if (prepared) completeCanonicalBucketMesh(bucket, preparationContext, prepared);
      }
    }
    for (const stagedObject of stagedGeneration.canonicalObjects.values()) {
      stagedObject.instances = [];
      generation.canonicalObjects.set(stagedObject.stableId, stagedObject);
    }
    for (const stagedBucket of stagedGeneration.canonicalBuckets.values()) {
      const bucket = generation.canonicalBuckets.get(stagedBucket.key);
      for (const stagedItem of stagedItemsForBucket(stagedBucket)) {
        const object = generation.canonicalObjects.get(stagedItem.object.stableId);
        const item = {
          ...stagedItem,
          object,
          slot: bucket.items.length,
          ...(object.canonicalCoarseTree === true ? {
            coarseTreeSubmitted: false,
          } : {}),
        };
        bucket.items.push(item);
        object.instances.push({ bucket, item });
        bucket.dirtySlots.add(item.slot);
      }
    }
    mergeNumericStats(generation.stats, stagedGeneration.stats);
    const slice = scheduler.finish();
    persistentTreeMaximumSliceMs = Math.max(persistentTreeMaximumSliceMs, slice.maximumSliceMs);
    persistentTreePages.set(page.ownerKey, Object.freeze({
      ownerKey: page.ownerKey,
      ownerKeys: Object.freeze([...(page.ownerKeys ?? [page.ownerKey])]),
      macroCellKey: page.macroCellKey ?? null,
      resourceKind: page.resourceKind,
      contentHash: page.value.contentHash ?? null,
      stableIds: Object.freeze(stableIds),
      coarseFillBand: page.coarseFillBand ?? 4,
    }));
    persistentNaturalVisibilityObjectRevision += 1;
    reconcilePersistentCoarseTreeSubmission(
      generation,
      generation.playerX,
      generation.playerZ,
      { force: true, stableIds },
    );
    for (const stableId of stableIds) persistentNaturalVisibilityDirtyStableIds.add(stableId);
    persistentTreeVisibilityDirty = true;
    pendingPersistentTreePublications.set(page.ownerKey, {
      page,
      stableIds,
      lightweight: stableIds.length === 0,
      small: stableIds.length > 0
        && stableIds.length <= STATIC_NATURAL_SMALL_PAGE_SLOT_LIMIT,
    });
    persistentTreeExactOwnerBuildCount += 1;
    if (!streamingTelemetry) {
      persistentTreeOwnerBuildCount += 1;
      return null;
    }
    const instanceCountAfter = [...generation.canonicalBuckets.values()]
      .reduce((sum, bucket) => sum + bucket.items.length, 0);
    const allocation = Object.freeze({
      objectCount: Math.max(0, generation.canonicalObjects.size - objectCountBefore),
      instanceCount: Math.max(0, instanceCountAfter - instanceCountBefore),
      bucketCount: Math.max(0, generation.canonicalBuckets.size - bucketCountBefore),
      durationMs: monotonicNow() - buildStartedAt,
      maximumSliceMs: slice.maximumSliceMs,
    });
    persistentTreeOwnerBuildCount += 1;
    persistentTreeAllocatedObjectCount += allocation.objectCount;
    persistentTreeAllocatedInstanceCount += allocation.instanceCount;
    persistentTreeAllocatedBucketCount += allocation.bucketCount;
    return allocation;
  };

  const enqueuePersistentNaturalOwnerBuild = (
    page,
    budgetMs = STATIC_TREE_PAGE_FRAME_BUDGET_MS,
    { deferStart = false } = {},
  ) => {
    const requestedGeneration = persistentTreeGeneration;
    persistentTreeBuildQueuedCount += 1;
    const execute = async () => {
      if (!requestedGeneration || requestedGeneration !== persistentTreeGeneration) return null;
      if (page.resourceKind !== 'presentation'
        && page.resourceKind !== DIRECT_CANONICAL_TREE_RESOURCE_KIND) {
        persistentTreeStalePageDiscardCount += 1;
        return null;
      }
      const desiredResourceKind = persistentTreeDesiredResourceKinds.get(page.ownerKey);
      if (page.resourceKind === DIRECT_CANONICAL_TREE_RESOURCE_KIND
        ? !directCanonicalTreeCells.has(page.macroCellKey)
        : desiredResourceKind && desiredResourceKind !== page.resourceKind) {
        persistentTreeStalePageDiscardCount += 1;
        return null;
      }
      const resident = persistentTreePages.get(page.ownerKey);
      if (resident?.resourceKind === page.resourceKind
        && resident.contentHash === (page.value?.contentHash ?? null)) {
        persistentTreeOwnerReuseCount += 1;
        return null;
      }
      persistentTreeBuildActiveCount += 1;
      try {
        return await buildPersistentNaturalOwner(page, budgetMs);
      } finally {
        persistentTreeBuildActiveCount -= 1;
      }
    };
    // Each owner stages into private maps and yields cooperatively. The only
    // live mutation is its bounded synchronous commit after the final slice;
    // no whole-owner Promise tail serializes otherwise-independent staging.
    const scheduled = deferStart
      ? Promise.resolve(yieldPresentationWorkToMainThread()).then(execute)
      : Promise.resolve(execute());
    return scheduled.finally(() => {
      persistentTreeBuildQueuedCount -= 1;
    });
  };

  const flushPersistentNaturalPublications = (
    composeResult,
    {
      canContinue = () => true,
    } = {},
  ) => {
    if (!persistentTreeGeneration) return 0;
    let published = 0;
    let spentUnits = 0;
    const ordered = [...pendingPersistentTreePublications.entries()].sort((left, right) => (
      Number(right[1].page.schedulerRequired === true)
        - Number(left[1].page.schedulerRequired === true)
        || (left[1].page.deadlineAtMs ?? Number.POSITIVE_INFINITY)
          - (right[1].page.deadlineAtMs ?? Number.POSITIVE_INFINITY)
        || (left[1].page.coarseFillBand ?? 4) - (right[1].page.coarseFillBand ?? 4)
        || Number(right[1].page.required) - Number(left[1].page.required)
        || left[1].page.readyAtMs - right[1].page.readyAtMs
        || left[0].localeCompare(right[0])
    ));
    for (const [ownerKey, pending] of ordered) {
      if (!canContinue()) break;
      const cost = pending.lightweight === true
        ? STATIC_NATURAL_EMPTY_PUBLICATION_COST
        : pending.small === true
          ? STATIC_NATURAL_SMALL_PUBLICATION_COST
          : STATIC_NATURAL_HEAVY_PUBLICATION_COST;
      if (published > 0 && spentUnits + cost > STATIC_NATURAL_PUBLICATION_BUDGET_UNITS) break;
      const stillDirty = pending.stableIds.some(stableId => {
        const object = persistentTreeGeneration.canonicalObjects.get(stableId);
        return object?.instances.some(instance => (
          instance.bucket.dirtySlots?.has(instance.item.slot)
        )) === true;
      });
      if (stillDirty
        || persistentNaturalCoverageBlocksStableIds(pending.stableIds)
        || persistentNaturalBaselineBlocksStableIds(pending.stableIds)) continue;
      pendingPersistentTreePublications.delete(ownerKey);
      publishPersistentNaturalOwner(
        pending.page,
        pending.stableIds,
        composeResult,
      );
      if (pending.lightweight === true) {
        persistentTreeLightweightOwnerPublicationCount += 1;
      } else if (pending.small === true) {
        persistentTreeSmallFarOwnerPublicationCount += 1;
      }
      spentUnits += cost;
      published += 1;
    }
    return published;
  };

  const deadlinePersistentNaturalPublications = () => (
    [...pendingPersistentTreePublications.values()]
      // Boot Visual Expected work belongs to the coarse scheduler class but
      // intentionally has no simultaneous deadline. Reserve targeted compose
      // for entering owners with a real first-visible ETA; boot keeps using
      // the ordinary bounded dirty composer.
      .filter(pending => Number.isFinite(pending.page.deadlineAtMs))
      .sort((left, right) => (
        Number(right.page.schedulerRequired) - Number(left.page.schedulerRequired)
          || (left.page.deadlineAtMs ?? Number.POSITIVE_INFINITY)
            - (right.page.deadlineAtMs ?? Number.POSITIVE_INFINITY)
          || left.page.readyAtMs - right.page.readyAtMs
          || left.page.ownerKey.localeCompare(right.page.ownerKey)
      ))
  );

  const dirtySlotsForPersistentNaturalPublication = (generation, pending) => {
    const targetSlotsByBucket = new Map();
    for (const stableId of pending.stableIds) {
      const object = generation.canonicalObjects.get(stableId);
      for (const { bucket, item } of object?.instances ?? []) {
        if (!Number.isSafeInteger(item.slot)
          || !bucket.dirtySlots?.has(item.slot)) continue;
        if (!targetSlotsByBucket.has(bucket)) targetSlotsByBucket.set(bucket, new Set());
        targetSlotsByBucket.get(bucket).add(item.slot);
      }
    }
    // A dense-prefix toggle can move a second item to the target's former
    // slot. Append every dirty slot from an affected bucket after the
    // deadline identity's current slot so both sides of the swap share one
    // r160 update-range publication. Target mode preserves insertion order.
    for (const [bucket, slots] of targetSlotsByBucket) {
      if (!isPersistentCoarseTreeBucket(bucket)) continue;
      for (const slot of bucket.dirtySlots ?? []) {
        if (slot >= 0 && slot < bucket.items.length) slots.add(slot);
      }
    }
    return targetSlotsByBucket;
  };

  const processPersistentNaturalWork = (
    frameBudgetMs = STATIC_TREE_PAGE_FRAME_BUDGET_MS,
  ) => {
    if (!incrementalStaticTreePages || !persistentTreeGeneration) return null;
    reconcileNearPublicationsImmediately(persistentTreeGeneration);
    if (!(frameBudgetMs > 0)) return Object.freeze({ remainingMs: 0, buildStarted: false });
    presentationSchedulerNaturalSlices += 1;
    const frameStartedAt = monotonicNow();
    const withinBudget = () => (
      monotonicNow() - frameStartedAt < frameBudgetMs
    );
    const remainingBudgetMs = () => Math.max(
      0,
      frameBudgetMs - (monotonicNow() - frameStartedAt),
    );
    const admittedOwners = persistentTreeAdmissionsSinceFrame;
    persistentTreeAdmissionsSinceFrame = 0;
    persistentTreeMaximumAdmissionsPerFrame = Math.max(
      persistentTreeMaximumAdmissionsPerFrame,
      admittedOwners,
    );
    if (admittedOwners > NATURAL_OWNER_BUILD_QUEUE_MAXIMUM) {
      persistentTreeAdmissionLimitViolationCount += 1;
    }
    const frameSample = streamingTelemetry || diagnosticsEnabled ? {
      frameSequence: ++persistentTreeFrameSequence,
      startedAtMs: frameStartedAt,
      budgetMs: frameBudgetMs,
      admittedOwners,
      coverageGeneration: persistentTreeCoverageGeneration,
      planRevision: persistentTreePlanRevision,
      residentBefore: persistentTreePages.size,
      pendingPagesBefore: pendingPersistentTreePages.size,
      pendingPublicationsBefore: pendingPersistentTreePublications.size,
      disposeBacklogBefore: persistentTreeDisposeOwners.length,
      publishedOwners: 0,
      builtOwners: 0,
      disposedOwners: 0,
      compactionMoves: 0,
      visibilityMatrixInvalidations: 0,
      matrixUpdates: 0,
      attributeUpdates: 0,
      bufferRangeUpdates: 0,
      bufferUploadBytes: 0,
      visibilityMs: 0,
      visibilityQueueBefore: persistentNaturalVisibilityQueueLength(
        persistentNaturalVisibilityJob,
      ),
      visibilityQueueAfter: 0,
      visibilityObjectsProcessed: 0,
      composeMs: 0,
      disposeMs: 0,
      buildMs: 0,
      buildMaximumSliceMs: 0,
      allocatedObjects: 0,
      allocatedInstances: 0,
      allocatedBuckets: 0,
    } : null;
    let frameSampleFinished = false;
    const finishFrameSample = () => {
      if (!frameSample || frameSampleFinished) return;
      frameSampleFinished = true;
      frameSample.residentAfter = persistentTreePages.size;
      frameSample.pendingPagesAfter = pendingPersistentTreePages.size;
      frameSample.pendingPublicationsAfter = pendingPersistentTreePublications.size;
      frameSample.disposeBacklogAfter = persistentTreeDisposeOwners.length;
      frameSample.visibilityQueueAfter = persistentNaturalVisibilityQueueLength(
        persistentNaturalVisibilityJob,
      );
      frameSample.totalMs = monotonicNow() - frameSample.startedAtMs;
      recordPersistentTreeFrameSample(frameSample);
      if (diagnosticsEnabled) recordDiagnosticWork('persistent-natural-frame', {
        calls: 1,
        admittedOwners: frameSample.admittedOwners,
        publishedOwners: frameSample.publishedOwners,
        builtOwners: frameSample.builtOwners,
        disposedOwners: frameSample.disposedOwners,
        residentOwners: frameSample.residentAfter,
        pendingPages: frameSample.pendingPagesAfter,
        pendingPublications: frameSample.pendingPublicationsAfter,
        disposeBacklog: frameSample.disposeBacklogAfter,
        compactionMoves: frameSample.compactionMoves,
        visibilityMatrixInvalidations: frameSample.visibilityMatrixInvalidations,
        matrixUpdates: frameSample.matrixUpdates,
        attributeUpdates: frameSample.attributeUpdates,
        bufferRangeUpdates: frameSample.bufferRangeUpdates,
        bufferUploadBytes: frameSample.bufferUploadBytes,
        allocatedObjects: frameSample.allocatedObjects,
        allocatedInstances: frameSample.allocatedInstances,
        allocatedBuckets: frameSample.allocatedBuckets,
        visibilityMs: frameSample.visibilityMs,
        visibilityQueueBefore: frameSample.visibilityQueueBefore,
        visibilityQueueAfter: frameSample.visibilityQueueAfter,
        visibilityObjectsProcessed: frameSample.visibilityObjectsProcessed,
        composeMs: frameSample.composeMs,
        disposeMs: frameSample.disposeMs,
        buildMs: frameSample.buildMs,
        buildMaximumSliceMs: frameSample.buildMaximumSliceMs,
        totalMs: frameSample.totalMs,
      });
    };

    const compactionBefore = persistentTreeCompactionMoveCount;
    const disposedBefore = persistentTreeOwnerDisposeCount;
    const disposeStartedAt = monotonicNow();
    if (persistentTreeDisposeOwners.length && withinBudget()) {
      removePersistentNaturalOwner(persistentTreeDisposeOwners.shift());
    }
    const disposeMs = monotonicNow() - disposeStartedAt;
    persistentTreeMaximumDisposeSliceMs = Math.max(persistentTreeMaximumDisposeSliceMs, disposeMs);
    if (frameSample) {
      frameSample.disposedOwners = Math.min(
        STATIC_TREE_OWNER_DISPOSE_LIMIT,
        persistentTreeOwnerDisposeCount - disposedBefore,
      );
      frameSample.compactionMoves = persistentTreeCompactionMoveCount - compactionBefore;
      frameSample.disposeMs = disposeMs;
    }

    const nearSignature = readNearVisibleSnapshotState().signature;
    if (nearSignature !== persistentTreeGeneration.nearVisibleStableSignature) {
      persistentTreeVisibilityDirty = true;
    }
    const dirtySlotCount = () => [...persistentTreeGeneration.canonicalBuckets.values()]
      .reduce((sum, bucket) => sum + (bucket.dirtySlots?.size ?? 0), 0);
    const dirtyBeforeVisibility = streamingTelemetry || diagnosticsEnabled
      ? dirtySlotCount() : 0;
    const visibilityStartedAt = monotonicNow();
    let visibilityWork = Object.freeze({ processed: 0, remaining: 0, durationMs: 0 });
    if (withinBudget()) {
      visibilityWork = processPersistentNaturalVisibility(
        persistentTreeGeneration,
        Math.min(NATURAL_VISIBILITY_FRAME_BUDGET_MS, remainingBudgetMs()),
      );
    }
    const visibilityMs = monotonicNow() - visibilityStartedAt;
    const visibilityInvalidations = streamingTelemetry || diagnosticsEnabled
      ? Math.max(0, dirtySlotCount() - dirtyBeforeVisibility)
      : 0;
    persistentTreeVisibilityMatrixInvalidationCount += visibilityInvalidations;
    persistentTreeMaximumVisibilitySliceMs = Math.max(
      persistentTreeMaximumVisibilitySliceMs,
      visibilityMs,
    );

    const composeResults = [];
    // Deadline pages share the normal 3 ms/512-unit budget, but their exact
    // dirty slots are composed before unrelated resident dirt. This makes the
    // existing publication deadline ordering effective at the GPU boundary.
    const deadlineSlotsByBucket = new Map();
    for (const pending of deadlinePersistentNaturalPublications()) {
      const pendingSlots = dirtySlotsForPersistentNaturalPublication(
        persistentTreeGeneration,
        pending,
      );
      for (const [bucket, slots] of pendingSlots) {
        if (!deadlineSlotsByBucket.has(bucket)) deadlineSlotsByBucket.set(bucket, new Set());
        for (const slot of slots) deadlineSlotsByBucket.get(bucket).add(slot);
      }
    }
    if (deadlineSlotsByBucket.size > 0 && remainingBudgetMs() > 0) {
      composeResults.push(composePersistentTreeDirtyRanges(
        persistentTreeGeneration,
        remainingBudgetMs(),
        STATIC_TREE_PAGE_UNIT_LIMIT,
        deadlineSlotsByBucket,
      ));
    }
    // Do not issue a second update-range write for the same attributes in one
    // frame: Three r160 retains only the latest range set before render.
    if (composeResults.length === 0 && remainingBudgetMs() > 0) {
      composeResults.push(composePersistentTreeDirtyRanges(
        persistentTreeGeneration,
        remainingBudgetMs(),
        STATIC_TREE_PAGE_UNIT_LIMIT,
      ));
    }
    const composeResult = Object.freeze({
      matrices: composeResults.reduce((sum, result) => sum + result.matrices, 0),
      attributes: composeResults.reduce((sum, result) => sum + result.attributes, 0),
      buckets: composeResults.reduce((sum, result) => sum + result.buckets, 0),
      bufferRangeUpdates: composeResults.reduce(
        (sum, result) => sum + result.bufferRangeUpdates,
        0,
      ),
      bufferUploadBytes: composeResults.reduce(
        (sum, result) => sum + result.bufferUploadBytes,
        0,
      ),
      durationMs: composeResults.reduce((sum, result) => sum + result.durationMs, 0),
    });
    releaseComposedPersistentNaturalCoverage(persistentTreeGeneration);
    const publishedOwners = flushPersistentNaturalPublications(composeResult, {
      canContinue: withinBudget,
    });
    releasePersistentNaturalBaselineCoverage(persistentTreeGeneration);
    if (frameSample) {
      frameSample.visibilityMs = visibilityMs;
      frameSample.visibilityObjectsProcessed = visibilityWork.processed;
      frameSample.visibilityQueueAfter = visibilityWork.remaining;
      frameSample.visibilityMatrixInvalidations = visibilityInvalidations;
      frameSample.composeMs = composeResult.durationMs;
      frameSample.matrixUpdates = composeResult.matrices;
      frameSample.attributeUpdates = composeResult.attributes;
      frameSample.bufferRangeUpdates = composeResult.bufferRangeUpdates;
      frameSample.bufferUploadBytes = composeResult.bufferUploadBytes;
      frameSample.publishedOwners = publishedOwners;
    }

    if (pendingPersistentTreePages.size === 0
      || remainingBudgetMs() < 0.25) {
      finishFrameSample();
      return Object.freeze({ remainingMs: remainingBudgetMs(), buildStarted: false });
    }
    const prioritizedPages = [...pendingPersistentTreePages.values()].sort((left, right) => (
      Number(right.schedulerRequired === true) - Number(left.schedulerRequired === true)
        || (left.deadlineAtMs ?? Number.POSITIVE_INFINITY)
          - (right.deadlineAtMs ?? Number.POSITIVE_INFINITY)
        || (left.coarseFillBand ?? 4) - (right.coarseFillBand ?? 4)
        || Number(right.required) - Number(left.required)
        || left.readyAtMs - right.readyAtMs
        || left.ownerKey.localeCompare(right.ownerKey)
    ));
    const queueTarget = resolveNaturalOwnerBuildQueueTarget({
      backlog: pendingPersistentTreePages.size + persistentTreeBuildQueuedCount,
    });
    persistentTreeLastBuildQueueTarget = queueTarget;
    persistentTreeMaximumBuildQueueTarget = Math.max(
      persistentTreeMaximumBuildQueueTarget,
      queueTarget,
    );
    const availableQueueSlots = Math.max(0, queueTarget - persistentTreeBuildQueuedCount);
    if (availableQueueSlots === 0) {
      finishFrameSample();
      return Object.freeze({ remainingMs: remainingBudgetMs(), buildStarted: false });
    }
    const pages = prioritizedPages.slice(0, availableQueueSlots);
    for (const page of pages) pendingPersistentTreePages.delete(page.ownerKey);
    const pageBudgetMs = Math.max(0.25, remainingBudgetMs());
    const scheduled = pages.map(page => (
      enqueuePersistentNaturalOwnerBuild(page, pageBudgetMs, { deferStart: true })
    ));
    void Promise.all(scheduled)
      .then(allocations => {
        if (frameSample) {
          for (const allocation of allocations.filter(Boolean)) {
            frameSample.builtOwners += 1;
            frameSample.buildMs += allocation.durationMs;
            frameSample.buildMaximumSliceMs = Math.max(
              frameSample.buildMaximumSliceMs,
              allocation.maximumSliceMs,
            );
            frameSample.allocatedObjects += allocation.objectCount;
            frameSample.allocatedInstances += allocation.instanceCount;
            frameSample.allocatedBuckets += allocation.bucketCount;
          }
        }
      }).catch(error => {
        if (error !== SYNC_CANCELLED) throw error;
      }).finally(finishFrameSample);
    return Object.freeze({ remainingMs: 0, buildStarted: true });
  };

  const runtimeHandoffSourceDescriptor = object => {
    const featureType = object?.record?.featureType ?? null;
    const lodPolicy = object?.record?.lodPolicy ?? null;
    if (lodPolicy && lodPolicy.outer === null && lodPolicy.far === null) return null;
    if (featureType === 'settlement-building') {
      return Object.freeze({
        kind: 'building',
        stableId: object.stableId,
        sourceIdentity: object.stableId,
        projectionIdentity: object.stableId,
        ownerKey: object.ownerKey,
      });
    }
    if (featureType === 'settlement-road') {
      return Object.freeze({
        kind: 'road',
        stableId: object.stableId,
        sourceIdentity: object.record.sourceStableId
          ?? object.record.sourceSegmentStableId ?? object.stableId,
        projectionIdentity: object.stableId,
        ownerKey: object.ownerKey,
      });
    }
    return null;
  };

  const runtimeHandoffDescriptorKey = descriptor => [
    descriptor.kind,
    descriptor.sourceIdentity,
    descriptor.projectionIdentity,
    descriptor.ownerKey,
  ].join('\n');

  const createRuntimePresentationCoverageBarrier = ({
    generation,
    previousRenderedKeys,
    previousNearStableIds,
    renderedKeys,
    carriedBarrier = null,
  }) => {
    const nextRendered = new Set(renderedKeys);
    const outgoingOwners = new Set([...previousRenderedKeys]
      .filter(ownerKey => !nextRendered.has(ownerKey)));
    const descriptors = new Map();
    const heldDescriptorKeys = new Set();
    for (const held of getNearPresentationHolds() ?? []) {
      if (!held || nextRendered.has(held.ownerKey)) continue;
      outgoingOwners.add(held.ownerKey);
      for (const descriptor of held.descriptors ?? []) {
        if (descriptor?.ownerKey !== held.ownerKey
          || !['building', 'road'].includes(descriptor?.kind)
          || typeof descriptor?.sourceIdentity !== 'string'
          || typeof descriptor?.projectionIdentity !== 'string') continue;
        const key = runtimeHandoffDescriptorKey(descriptor);
        heldDescriptorKeys.add(key);
        descriptors.set(key, Object.freeze({
          kind: descriptor.kind,
          stableId: descriptor.stableId ?? descriptor.projectionIdentity,
          sourceIdentity: descriptor.sourceIdentity,
          projectionIdentity: descriptor.projectionIdentity,
          ownerKey: descriptor.ownerKey,
        }));
      }
    }
    for (const descriptor of carriedBarrier?.descriptors ?? []) {
      if (!nextRendered.has(descriptor.ownerKey)) {
        descriptors.set(runtimeHandoffDescriptorKey(descriptor), descriptor);
        outgoingOwners.add(descriptor.ownerKey);
      }
    }
    for (const object of generation?.canonicalObjects?.values?.() ?? []) {
      if (!outgoingOwners.has(object.ownerKey)
        || isFeatureDestroyed(object.stableId)
        || (!previousNearStableIds.has(object.stableId) && object.visibleLod !== 'near')) continue;
      const descriptor = runtimeHandoffSourceDescriptor(object);
      if (descriptor) descriptors.set(runtimeHandoffDescriptorKey(descriptor), descriptor);
    }
    if (descriptors.size === 0) return null;
    const requestedAtMs = carriedBarrier?.requestedAtMs ?? monotonicNow();
    const barrier = {
      sequence: runtimePresentationCoverageBarrierRequestedCount + 1,
      requestedAtMs,
      descriptors: Object.freeze([...descriptors.values()].sort((left, right) => (
        runtimeHandoffDescriptorKey(left).localeCompare(runtimeHandoffDescriptorKey(right))
      ))),
      ownerKeys: new Set([...outgoingOwners].filter(ownerKey => (
        [...descriptors.values()].some(descriptor => descriptor.ownerKey === ownerKey)
      ))),
      generation,
      generationEpoch: generation?.epoch ?? null,
      publishedAtMs: null,
      releasedAtMs: null,
      released: false,
      retryCount: carriedBarrier?.retryCount ?? 0,
      prepared: false,
      composeFinished: false,
      roadWorks: [],
      roadWorkIndex: 0,
      composedBuckets: 0,
      matrixUpdates: 0,
      bufferUpdates: 0,
      blankFrames: carriedBarrier?.blankFrames ?? 0,
      duplicateFrames: carriedBarrier?.duplicateFrames ?? 0,
      distantPublishAtMs: null,
      nearReleaseAtMs: null,
      releasedDescriptorKeys: new Set([...(carriedBarrier?.releasedDescriptorKeys ?? [])]
        .filter(key => !heldDescriptorKeys.has(key))),
    };
    runtimePresentationCoverageBarrierRequestedCount += 1;
    recordDiagnosticEvent('near-distant-coverage-barrier-created', {
      sequence: barrier.sequence,
      generationEpoch: barrier.generationEpoch,
      ownerKeys: Object.freeze(sortedKeyList(barrier.ownerKeys)),
      buildingSourceCount: barrier.descriptors.filter(value => value.kind === 'building').length,
      roadSourceCount: barrier.descriptors.filter(value => value.kind === 'road').length,
    });
    return barrier;
  };

  const runtimeHandoffDescriptorCovered = (generation, descriptor) => {
    const object = generation?.canonicalObjects?.get?.(descriptor.stableId) ?? null;
    if (!object || object.ownerKey !== descriptor.ownerKey
      || !['mid', 'far'].includes(object.visibleLod)) return false;
    return object.instances.some(instance => (
      instance.bucket.mesh?.visible !== false
      && (instance.bucket.mesh?.userData?.canonicalStableIds ?? [])
        .includes(descriptor.projectionIdentity)
    ));
  };

  const inspectRuntimePresentationCoverageBarrier = (generation, barrier) => {
    if (!barrier) return Object.freeze({ covered: true, missing: Object.freeze([]) });
    const missing = barrier.descriptors.filter(descriptor => (
      !runtimeHandoffDescriptorCovered(generation, descriptor)
    ));
    return Object.freeze({ covered: missing.length === 0, missing: Object.freeze(missing) });
  };

  const recordRuntimePresentationCoverageFrame = (generation, barrier) => {
    if (!barrier || barrier.released) return;
    const nearVisible = readNearVisibleSnapshotState().stableIds;
    let blank = false;
    let duplicate = false;
    for (const descriptor of barrier.descriptors) {
      const nearCovered = nearVisible.has(descriptor.projectionIdentity);
      const distantCovered = runtimeHandoffDescriptorCovered(generation, descriptor);
      if (!nearCovered && !distantCovered) blank = true;
      if (nearCovered && distantCovered) duplicate = true;
    }
    if (blank) {
      barrier.blankFrames += 1;
      runtimePresentationCoverageBarrierBlankFrameCount += 1;
    }
    if (duplicate) {
      barrier.duplicateFrames += 1;
      runtimePresentationCoverageBarrierDuplicateFrameCount += 1;
    }
  };

  const releaseCoveredNearPresentation = ({ generation, barrier, kinds = null }) => {
    const nearVisible = readNearVisibleSnapshotState().stableIds;
    const candidates = barrier.descriptors.filter(descriptor => (
      !barrier.releasedDescriptorKeys.has(runtimeHandoffDescriptorKey(descriptor))
        && (kinds === null || kinds.has(descriptor.kind))
        && nearVisible.has(descriptor.projectionIdentity)
        && runtimeHandoffDescriptorCovered(generation, descriptor)
    ));
    if (candidates.length === 0) return true;
    if (candidates.some(descriptor => descriptor.kind === 'road')) {
      const heldRoads = barrier.descriptors.filter(descriptor => (
        descriptor.kind === 'road'
          && !barrier.releasedDescriptorKeys.has(runtimeHandoffDescriptorKey(descriptor))
          && nearVisible.has(descriptor.projectionIdentity)
      ));
      if (heldRoads.some(descriptor => !runtimeHandoffDescriptorCovered(generation, descriptor))) {
        return true;
      }
    }
    const coveredAtMs = monotonicNow();
    const releaseResult = releaseNearPresentationHolds({
      ownerKeys: Object.freeze(sortedKeyList(new Set(
        candidates.map(descriptor => descriptor.ownerKey),
      ))),
      descriptors: Object.freeze(candidates),
      reason: 'distant-covered',
      distantPublishAtMs: coveredAtMs,
    });
    if (releaseResult && typeof releaseResult.then === 'function') {
      throw new TypeError('Near presentation release must complete synchronously');
    }
    if (releaseResult?.released !== true) return false;
    for (const descriptor of candidates) {
      barrier.releasedDescriptorKeys.add(runtimeHandoffDescriptorKey(descriptor));
    }
    barrier.distantPublishAtMs = coveredAtMs;
    barrier.nearReleaseAtMs = releaseResult.releasedAtMs ?? monotonicNow();
    return true;
  };

  const discardRuntimePresentationBarrierRoadWork = barrier => {
    if (!barrier) return 0;
    let discarded = 0;
    for (const work of barrier.roadWorks ?? []) {
      discarded += discardSettlementRoadComposeWork(work);
    }
    barrier.roadWorks = [];
    barrier.roadWorkIndex = 0;
    return discarded;
  };

  const resetRuntimePresentationCoverageBarrierWork = (barrier, generation) => {
    discardRuntimePresentationBarrierRoadWork(barrier);
    barrier.generation = generation;
    barrier.generationEpoch = generation?.epoch ?? null;
    barrier.prepared = false;
    barrier.composeFinished = false;
    barrier.composedBuckets = 0;
    barrier.matrixUpdates = 0;
    barrier.bufferUpdates = 0;
  };

  const publishRuntimePresentationCoverageBarrier = ({
    generation,
    barrier,
    activeDataKeys,
    renderedKeys,
    playerLogicalX,
    playerLogicalZ,
  }) => {
    if (!generation || !barrier || barrier.released) return false;
    if (barrier.prepared && (barrier.generation !== generation
      || barrier.generationEpoch !== (generation.epoch ?? null))) {
      resetRuntimePresentationCoverageBarrierWork(barrier, generation);
    }
    if (!barrier.prepared) {
      generation.activeKeys = new Set(activeDataKeys);
      generation.renderedKeys = new Set(renderedKeys);
      updateCanonicalVisibility(
        generation,
        playerLogicalX,
        playerLogicalZ,
        {
          compose: false,
          ignoreNearStableIds: new Set(
            barrier.descriptors.map(descriptor => descriptor.projectionIdentity),
          ),
        },
      );
      const descriptorIds = new Set(barrier.descriptors.map(value => value.stableId));
      const criticalBuckets = new Set();
      for (const stableId of descriptorIds) {
        const object = generation.canonicalObjects.get(stableId);
        for (const instance of object?.instances ?? []) {
          criticalBuckets.add(instance.bucket);
          if (instance.bucket.persistent === true && Number.isSafeInteger(instance.item.slot)) {
            instance.bucket.dirtySlots ??= new Set();
            instance.bucket.dirtySlots.add(instance.item.slot);
          }
        }
      }
      barrier.roadWorks = [];
      barrier.roadWorkIndex = 0;
      for (const bucket of criticalBuckets) {
        if (isSettlementRoadBucket(bucket)) {
          barrier.roadWorks.push(createSettlementRoadComposeWork(generation, bucket));
        } else if (generation.persistentDistant === true && bucket.persistent === true) {
          const work = createCanonicalBucketComposeWork(generation, bucket);
          const composed = advanceCanonicalBucketComposeWork(work, {
            budgetStartedAtMs: monotonicNow(),
            budgetMs: Number.POSITIVE_INFINITY,
            unitLimit: Number.POSITIVE_INFINITY,
          });
          barrier.composedBuckets += 1;
          barrier.matrixUpdates += composed.matrices;
          barrier.bufferUpdates += composed.attributes;
        } else {
          const composed = composeCanonicalBucket(generation, bucket);
          barrier.composedBuckets += composed.composed;
          barrier.matrixUpdates += composed.matrices;
          barrier.bufferUpdates += composed.attributes;
        }
      }
      barrier.generation = generation;
      barrier.generationEpoch = generation.epoch ?? null;
      barrier.prepared = true;
      const queued = barrier.roadWorks.reduce(
        (total, work) => total + settlementRoadWorkRemaining(work),
        0,
      );
      roadPresentationMaximumQueueLength = Math.max(
        roadPresentationMaximumQueueLength,
        queued,
      );
      if (!releaseCoveredNearPresentation({
        generation,
        barrier,
        kinds: new Set(['building']),
      })) return false;
      if (barrier.roadWorks.length > 0) return false;
    }
    const roadStartedAt = monotonicNow();
    while (barrier.roadWorkIndex < barrier.roadWorks.length
      && (barrier.roadWorkIndex === 0
        || monotonicNow() - roadStartedAt < ROAD_PRESENTATION_FRAME_BUDGET_MS)) {
      const roadWork = barrier.roadWorks[barrier.roadWorkIndex];
      const composed = advanceSettlementRoadComposeWork(roadWork, {
        budgetStartedAtMs: roadStartedAt,
        budgetMs: ROAD_PRESENTATION_FRAME_BUDGET_MS,
      });
      if (composed.stale) {
        roadPresentationMaximumSliceMs = Math.max(
          roadPresentationMaximumSliceMs,
          monotonicNow() - roadStartedAt,
        );
        resetRuntimePresentationCoverageBarrierWork(barrier, generation);
        return false;
      }
      barrier.matrixUpdates += composed.matrices;
      barrier.bufferUpdates += composed.attributes;
      if (!composed.done) break;
      barrier.composedBuckets += 1;
      barrier.roadWorkIndex += 1;
    }
    roadPresentationMaximumSliceMs = Math.max(
      roadPresentationMaximumSliceMs,
      monotonicNow() - roadStartedAt,
    );
    if (barrier.roadWorkIndex < barrier.roadWorks.length) return false;
    if (!releaseCoveredNearPresentation({ generation, barrier })) return false;
    if (!barrier.composeFinished && barrier.composedBuckets > 0) {
      finishCanonicalCompose(generation, barrier.composedBuckets, barrier.matrixUpdates);
      runtimePresentationHandoffMatrixUpdateCount += barrier.matrixUpdates;
      runtimePresentationHandoffBufferUpdateCount += barrier.bufferUpdates;
      barrier.composeFinished = true;
    }
    const coverage = inspectRuntimePresentationCoverageBarrier(generation, barrier);
    if (!coverage.covered) {
      barrier.retryCount += 1;
      runtimePresentationCoverageBarrierRetryCount += 1;
      return false;
    }
    const distantPublishAtMs = barrier.distantPublishAtMs ?? monotonicNow();
    const nearVisibleBeforeRelease = readNearVisibleSnapshotState().stableIds;
    const heldDescriptors = barrier.descriptors.filter(descriptor => (
      nearVisibleBeforeRelease.has(descriptor.projectionIdentity)
    ));
    const releaseResult = heldDescriptors.length > 0
      ? releaseNearPresentationHolds({
        ownerKeys: Object.freeze(sortedKeyList(new Set(
          heldDescriptors.map(descriptor => descriptor.ownerKey),
        ))),
        descriptors: Object.freeze(heldDescriptors),
        reason: 'distant-covered',
        distantPublishAtMs,
      })
      : Object.freeze({ released: true, releasedAtMs: distantPublishAtMs });
    if (releaseResult && typeof releaseResult.then === 'function') {
      throw new TypeError('Near presentation release must complete synchronously');
    }
    if (releaseResult?.released !== true) {
      barrier.retryCount += 1;
      runtimePresentationCoverageBarrierRetryCount += 1;
      return false;
    }
    const nearReleaseAtMs = barrier.nearReleaseAtMs
      ?? releaseResult.releasedAtMs ?? monotonicNow();
    const nearVisibleAfterRelease = readNearVisibleSnapshotState().stableIds;
    const duplicateCount = barrier.descriptors.filter(descriptor => (
      nearVisibleAfterRelease.has(descriptor.projectionIdentity)
        && runtimeHandoffDescriptorCovered(generation, descriptor)
    )).length;
    if (duplicateCount > 0) {
      barrier.duplicateFrames += 1;
      runtimePresentationCoverageBarrierDuplicateFrameCount += 1;
    }
    barrier.generation = generation;
    barrier.generationEpoch = generation.epoch ?? null;
    barrier.publishedAtMs = distantPublishAtMs;
    barrier.distantPublishAtMs = distantPublishAtMs;
    barrier.nearReleaseAtMs = nearReleaseAtMs;
    barrier.releasedAtMs = nearReleaseAtMs;
    barrier.released = true;
    runtimePresentationCoverageBarrierReleasedCount += 1;
    const heldMs = Math.max(0, nearReleaseAtMs - barrier.requestedAtMs);
    runtimePresentationCoverageBarrierMaximumHeldMs = Math.max(
      runtimePresentationCoverageBarrierMaximumHeldMs,
      heldMs,
    );
    runtimePresentationCoverageBarrierLastRelease = Object.freeze({
      sequence: barrier.sequence,
      generationEpoch: barrier.generationEpoch,
      ownerKeys: Object.freeze(sortedKeyList(barrier.ownerKeys)),
      buildingSources: Object.freeze(barrier.descriptors
        .filter(value => value.kind === 'building')
        .map(value => Object.freeze({ ...value }))),
      roadSources: Object.freeze(barrier.descriptors
        .filter(value => value.kind === 'road')
        .map(value => Object.freeze({ ...value }))),
      nearReleaseAtMs,
      distantPublishAtMs,
      coverageGapMs: Math.max(0, distantPublishAtMs - nearReleaseAtMs),
      heldMs,
      finalReleaseAtMs: nearReleaseAtMs,
      blankFrames: barrier.blankFrames,
      duplicateFrames: barrier.duplicateFrames,
      retryCount: barrier.retryCount,
    });
    recordDiagnosticEvent('near-distant-coverage-barrier-released', {
      ...runtimePresentationCoverageBarrierLastRelease,
    });
    return true;
  };

  const queueRuntimePresentationHandoff = ({
    transitionContract,
    activeDataKeys,
    renderedKeys,
    renderOrigin,
    quality,
    playerLogicalX,
    playerLogicalZ,
    initialStage = 'local-terrain',
    coverageBarrier = null,
  }) => {
    if (pendingRuntimePresentationHandoff) {
      discardSettlementRoadComposeWork(pendingRuntimePresentationHandoff.bucketWork?.roadWork);
      discardRuntimePresentationBarrierRoadWork(
        pendingRuntimePresentationHandoff.coverageBarrier,
      );
      runtimePresentationHandoffSupersededCount += 1;
    }
    pendingRuntimePresentationHandoff = {
      sequence: ++runtimePresentationHandoffSequence,
      stage: initialStage,
      transitionContract,
      activeDataKeys: Object.freeze([...activeDataKeys]),
      renderedKeys: Object.freeze([...renderedKeys]),
      renderOrigin: Object.freeze({ ...renderOrigin }),
      quality,
      playerLogicalX,
      playerLogicalZ,
      targetLocalTerrainGeneration: activeLocalTerrainGeneration,
      targetGeneration: activeGeneration,
      dirtyBuckets: [],
      dirtyBucketIndex: 0,
      bucketWork: null,
      composedBuckets: 0,
      matrixUpdates: 0,
      bufferUpdates: 0,
      coverageBarrier,
    };
    runtimePresentationHandoffRequestedCount += 1;
    return pendingRuntimePresentationHandoff;
  };

  const processRuntimePresentationHandoff = () => {
    const handoff = pendingRuntimePresentationHandoff;
    if (!handoff) return Object.freeze({
      processed: false,
      durationMs: 0,
      meshUpdates: 0,
      matrixUpdates: 0,
      bufferUpdates: 0,
      uploadBytes: 0,
      localTerrainHandoffs: 0,
    });
    roadPresentationFrameSequence += 1;
    if (pendingDistantPublication?.generation === handoff.targetGeneration) {
      recordRuntimePresentationCoverageFrame(
        handoff.targetGeneration,
        handoff.coverageBarrier,
      );
      return Object.freeze({
        processed: false,
        durationMs: 0,
        meshUpdates: 0,
        matrixUpdates: 0,
        bufferUpdates: 0,
        uploadBytes: 0,
        localTerrainHandoffs: 0,
      });
    }
    const startedAt = monotonicNow();
    const localTerrainHandoffsBefore = runtimePresentationHandoffLocalTerrainCount;
    let frameMatrixUpdates = 0;
    let frameBufferUpdates = 0;
    let frameUploadBytes = 0;
    const complete = ({ superseded = false } = {}) => {
      if (pendingRuntimePresentationHandoff !== handoff) return;
      pendingRuntimePresentationHandoff = null;
      runtimePresentationHandoffCompletedCount += 1;
      if (superseded) runtimePresentationHandoffSupersededCount += 1;
    };

    if (handoff.targetGeneration && handoff.targetGeneration !== activeGeneration) {
      if (handoff.coverageBarrier && !handoff.coverageBarrier.released && activeGeneration) {
        runtimePresentationHandoffSupersededCount += 1;
        runtimePresentationCoverageBarrierSupersededCount += 1;
        handoff.targetGeneration = activeGeneration;
        resetRuntimePresentationCoverageBarrierWork(
          handoff.coverageBarrier,
          activeGeneration,
        );
        handoff.stage = 'ownership';
        handoff.dirtyBuckets = [];
        handoff.dirtyBucketIndex = 0;
        handoff.bucketWork = null;
        handoff.composedBuckets = 0;
        handoff.matrixUpdates = 0;
      } else {
        complete({ superseded: true });
      }
    } else if (handoff.stage === 'local-terrain') {
      if (handoff.targetLocalTerrainGeneration === activeLocalTerrainGeneration) {
        if (applyLocalTerrainOwnerHandoff(
          handoff.targetLocalTerrainGeneration,
          handoff.activeDataKeys,
          handoff.renderedKeys,
        )) runtimePresentationHandoffLocalTerrainCount += 1;
      }
      handoff.stage = 'ownership';
    } else if (handoff.stage === 'ownership') {
      if (!handoff.targetGeneration) {
        complete();
      } else {
        handoff.targetGeneration.activeKeys = new Set(handoff.activeDataKeys);
        handoff.targetGeneration.renderedKeys = new Set(handoff.renderedKeys);
        positionGenerationForOrigin(handoff.targetGeneration, handoff.renderOrigin);
        updateFarRiverVisibility(handoff.targetGeneration);
        handoff.stage = 'visibility';
      }
    } else if (handoff.stage === 'visibility') {
      const dirtyBuckets = updateCanonicalVisibility(
        handoff.targetGeneration,
        handoff.playerLogicalX,
        handoff.playerLogicalZ,
        { compose: false },
      );
      handoff.dirtyBuckets = [...dirtyBuckets.values()];
      handoff.dirtyBucketIndex = 0;
      handoff.stage = handoff.dirtyBuckets.length ? 'compose' : 'finalize';
    } else if (handoff.stage === 'compose') {
      const bucket = handoff.dirtyBuckets[handoff.dirtyBucketIndex];
      if (bucket) {
        handoff.bucketWork ??= createCanonicalBucketComposeWork(
          handoff.targetGeneration,
          bucket,
        );
        const composed = advanceCanonicalBucketComposeWork(handoff.bucketWork, {
          budgetStartedAtMs: startedAt,
        });
        handoff.matrixUpdates += composed.matrices;
        handoff.bufferUpdates += composed.attributes;
        frameMatrixUpdates += composed.matrices;
        frameBufferUpdates += composed.attributes;
        frameUploadBytes += composed.bytes ?? 0;
        if (composed.done) {
          handoff.composedBuckets += 1;
          handoff.dirtyBucketIndex += 1;
          handoff.bucketWork = null;
        }
      }
      if (handoff.dirtyBucketIndex >= handoff.dirtyBuckets.length) {
        handoff.stage = 'finalize';
      }
    } else if (handoff.stage === 'finalize') {
      finishCanonicalCompose(
        handoff.targetGeneration,
        handoff.composedBuckets,
        handoff.matrixUpdates,
      );
      if (!handoff.coverageBarrier || handoff.coverageBarrier.released) complete();
      else handoff.stage = 'coverage';
    } else if (handoff.stage === 'coverage') {
      if (handoff.coverageBarrier && !handoff.coverageBarrier.released) {
        publishRuntimePresentationCoverageBarrier({
          generation: handoff.targetGeneration,
          barrier: handoff.coverageBarrier,
          activeDataKeys: handoff.activeDataKeys,
          renderedKeys: handoff.renderedKeys,
          playerLogicalX: handoff.playerLogicalX,
          playerLogicalZ: handoff.playerLogicalZ,
        });
      }
      if (!handoff.coverageBarrier || handoff.coverageBarrier.released) complete();
    }

    recordRuntimePresentationCoverageFrame(
      handoff.targetGeneration,
      handoff.coverageBarrier,
    );

    const durationMs = monotonicNow() - startedAt;
    runtimePresentationHandoffMatrixUpdateCount += frameMatrixUpdates;
    runtimePresentationHandoffBufferUpdateCount += frameBufferUpdates;
    runtimePresentationHandoffMaximumSliceMs = Math.max(
      runtimePresentationHandoffMaximumSliceMs,
      durationMs,
    );
    runtimePresentationHandoffMaximumMatrixUpdatesPerFrame = Math.max(
      runtimePresentationHandoffMaximumMatrixUpdatesPerFrame,
      frameMatrixUpdates,
    );
    runtimePresentationHandoffMaximumBufferUpdatesPerFrame = Math.max(
      runtimePresentationHandoffMaximumBufferUpdatesPerFrame,
      frameBufferUpdates,
    );
    return Object.freeze({
      processed: true,
      durationMs,
      meshUpdates: Number(frameBufferUpdates > 0),
      matrixUpdates: frameMatrixUpdates,
      bufferUpdates: frameBufferUpdates,
      uploadBytes: frameUploadBytes,
      localTerrainHandoffs:
        runtimePresentationHandoffLocalTerrainCount - localTerrainHandoffsBefore,
    });
  };

  const commitRuntimePresentationState = ({
    transitionContract = null,
    activeDataKeys = [],
    renderedKeys = [],
    renderOrigin,
    quality = activeGeneration?.quality ?? 'high',
    renderDistancePreset = activeLocalTerrainGeneration?.renderDistancePreset
      ?? W8_DEFAULT_RENDER_DISTANCE_PRESET,
    playerLogicalX = activeGeneration?.playerX ?? 0,
    playerLogicalZ = activeGeneration?.playerZ ?? 0,
  } = {}) => {
    if (!acceptCommittedRenderOrigin(renderOrigin)) return false;
    const acceptedTransition = validateTransitionCoverage(transitionContract, {
      activeDataKeys,
      renderedKeys,
    });
    if (!acceptRuntimeTransitionContract(acceptedTransition)) return false;
    const previousRenderedKeys = new Set(
      runtimePresentationCommittedRenderedKeys
        ?? pendingRuntimePresentationHandoff?.renderedKeys
        ?? activeGeneration?.renderedKeys
        ?? [],
    );
    const previousNearStableIds = new Set(
      runtimePresentationCommittedNearStableIds
        ?? activeGeneration?.nearVisibleStableIds
        ?? [],
    );
    runtimePresentationCommittedNearStableIds = new Set(
      readNearVisibleSnapshotState().stableIds,
    );
    const carriedBarrier = pendingRuntimePresentationHandoff?.coverageBarrier?.released === false
      ? pendingRuntimePresentationHandoff.coverageBarrier : null;
    runtimePresentationCommittedRenderedKeys = new Set(renderedKeys);
    positionGenerationForOrigin(activeLocalTerrainGeneration, renderOrigin);
    positionGenerationForOrigin(activeGeneration, renderOrigin);
    macroCoarseWorldPresentation?.rebase(renderOrigin);
    if (enableMacroCoarseWorld) {
      const macroCenter = logicalWorldToMacroCell(playerLogicalX, playerLogicalZ);
      void ensureMacroSurfaceWindow(macroCenter.macroX, macroCenter.macroZ).catch(error => {
        recordDiagnosticEvent('macro-coarse-surface-window-prime-failed', {
          macroX: macroCenter.macroX,
          macroZ: macroCenter.macroZ,
          message: error?.message ?? String(error),
        });
      });
    }
    if (incrementalStaticTreePages) {
      // Near has already published this contract. Update the retained Local
      // Terrain indices before a renderer can observe the next frame.
      if (applyLocalTerrainOwnerHandoff(
        activeLocalTerrainGeneration,
        activeDataKeys,
        renderedKeys,
      )) runtimePresentationHandoffLocalTerrainCount += 1;
      // The Near registry contains only attached, draw-ready projections.
      // Suppress matching Building slots before this commit can be rendered;
      // the remaining ownership/visibility compose stays frame-budgeted.
      suppressPublishedNearDistantBuildings();
      const coverageGeneration = pendingDistantPublication?.previous
        ?? persistentDistantPublishedGeneration
        ?? activeGeneration;
      const coverageBarrier = createRuntimePresentationCoverageBarrier({
        generation: coverageGeneration,
        previousRenderedKeys,
        previousNearStableIds,
        renderedKeys,
        carriedBarrier,
      });
      queueRuntimePresentationHandoff({
        transitionContract: acceptedTransition,
        activeDataKeys,
        renderedKeys,
        renderOrigin,
        quality,
        renderDistancePreset,
        playerLogicalX,
        playerLogicalZ,
        initialStage: 'ownership',
        coverageBarrier,
      });
      return true;
    }
    applyLocalTerrainOwnerHandoff(
      activeLocalTerrainGeneration,
      activeDataKeys,
      renderedKeys,
    );
    if (!activeGeneration) return true;
    activeGeneration.activeKeys = new Set(activeDataKeys);
    activeGeneration.renderedKeys = new Set(renderedKeys);
    updateFarRiverVisibility(activeGeneration);
    updateCanonicalVisibility(activeGeneration, playerLogicalX, playerLogicalZ);
    return true;
  };

  const prepareClipmapBuild = ({
    centerChunkX,
    centerChunkZ,
    activeChunks,
    origin,
    renderDistancePreset,
    surfacePolicy,
    stats,
    target,
    ownedGeometries,
    generation,
  }) => {
    const startedAt = monotonicNow();
    const topology = clipmapTopologyFor(renderDistancePreset);
    const presetId = normalizeW8RenderDistancePreset(renderDistancePreset);
    const sourceGeneration = [
      activeLocalTerrainGeneration,
      ...[...preparedTerrainPresentationGenerations.values()]
        .map(prepared => prepared.generation),
    ].filter(candidate => candidate && candidate !== generation
      && candidate.renderDistancePreset === presetId
      && candidate.clipmapGeometryResource)
      .sort((left, right) => (
        Math.max(
          Math.abs(left.centerChunkX - centerChunkX),
          Math.abs(left.centerChunkZ - centerChunkZ),
        ) - Math.max(
          Math.abs(right.centerChunkX - centerChunkX),
          Math.abs(right.centerChunkZ - centerChunkZ),
        )
      ))[0] ?? null;
    let sourceSlotByTarget = null;
    if (sourceGeneration) {
      const deltaChunkX = centerChunkX - sourceGeneration.centerChunkX;
      const deltaChunkZ = centerChunkZ - sourceGeneration.centerChunkZ;
      const slotMapKey = `${presetId}:${deltaChunkX},${deltaChunkZ}`;
      sourceSlotByTarget = clipmapShiftSlotMapCache.get(slotMapKey) ?? null;
      if (!sourceSlotByTarget) {
        const sourceSlotByCoordinate = new Map(topology.vertices.map(({ x, z }, index) => (
          [`${x},${z}`, index]
        )));
        sourceSlotByTarget = new Int32Array(topology.vertices.length);
        sourceSlotByTarget.fill(-1);
        const deltaX = deltaChunkX * LOGICAL_CHUNK_SIZE_METERS;
        const deltaZ = deltaChunkZ * LOGICAL_CHUNK_SIZE_METERS;
        for (let index = 0; index < topology.vertices.length; index += 1) {
          const { x, z } = topology.vertices[index];
          const sourceX = x + deltaX;
          const sourceZ = z + deltaZ;
          const sourceIndex = sourceSlotByCoordinate.get(`${sourceX},${sourceZ}`);
          if (sourceIndex === undefined) continue;
          const sourceDistanceOutside = Math.max(Math.abs(sourceX), Math.abs(sourceZ))
            - FIVE_BY_FIVE_HALF_EXTENT_METERS;
          const targetDistanceOutside = Math.max(Math.abs(x), Math.abs(z))
            - FIVE_BY_FIVE_HALF_EXTENT_METERS;
          if (sourceDistanceOutside <= CLIPMAP_BLEND_METERS
            || targetDistanceOutside <= CLIPMAP_BLEND_METERS) continue;
          sourceSlotByTarget[index] = sourceIndex;
        }
        clipmapShiftSlotMapCache.set(slotMapKey, sourceSlotByTarget);
      }
    }
    let pool = clipmapGeometryPoolByPreset.get(presetId);
    if (!pool) {
      pool = [];
      clipmapGeometryPoolByPreset.set(presetId, pool);
    }
    let resource = pool.filter(value => value.generation === null)
      .sort((left, right) => (
        Math.max(
          Math.abs((left.centerChunkX ?? centerChunkX) - centerChunkX),
          Math.abs((left.centerChunkZ ?? centerChunkZ) - centerChunkZ),
        ) - Math.max(
          Math.abs((right.centerChunkX ?? centerChunkX) - centerChunkX),
          Math.abs((right.centerChunkZ ?? centerChunkZ) - centerChunkZ),
        )
      ))[0] ?? null;
    let geometryAllocated = false;
    if (!resource) {
      const positions = new Float32Array(topology.vertices.length * 3);
      const colors = new Float32Array(topology.vertices.length * 3);
      for (let index = 0; index < topology.vertices.length; index += 1) {
        const offset = index * 3;
        positions[offset] = topology.vertices[index].x * UNITS_PER_METER;
        positions[offset + 2] = topology.vertices[index].z * UNITS_PER_METER;
      }
      const geometry = makeFlatClipmapGeometry(THREE, positions, colors, topology.indices);
      // terrainMaterial is flat-shaded, so Three.js derives the face normal in
      // the fragment shader. Retaining/recomputing a smooth normal attribute
      // would add a full-ring CPU pass and upload without affecting the image.
      geometry.userData = { ...(geometry.userData ?? {}), worldFixedClipmap: true };
      resource = {
        geometry,
        positions: geometry.attributes.position.array
          ?? geometry.attributes.position.values
          ?? positions,
        colors: geometry.attributes.color.array
          ?? geometry.attributes.color.values
          ?? colors,
        sampleHashes: new Uint32Array(topology.vertices.length),
        generation: null,
        centerChunkX: null,
        centerChunkZ: null,
        published: false,
      };
      pool.push(resource);
      geometryAllocated = true;
      clipmapGeometryAllocationCount += 1;
      clipmapIndexAllocationCount += 1;
    }
    resource.generation = generation;
    generation.clipmapGeometryResource = resource;
    ownedGeometries.add(resource.geometry);
    const centerWorldX = (centerChunkX + 0.5) * LOGICAL_CHUNK_SIZE_METERS;
    const centerWorldZ = (centerChunkZ + 0.5) * LOGICAL_CHUNK_SIZE_METERS;
    const originMetersX = origin.renderOriginChunkX * LOGICAL_CHUNK_SIZE_METERS;
    const originMetersZ = origin.renderOriginChunkZ * LOGICAL_CHUNK_SIZE_METERS;
    const { positions, colors, sampleHashes } = resource;
    const dirtySlots = [];
    let newlySampledCount = 0;
    let reusedSampleCount = 0;
    let surfaceRefreshCount = 0;
    let sourceSlotReuseCount = 0;
    let cacheReuseCount = 0;
    let vertexWriteCount = 0;
    let vertexComponentWriteCount = geometryAllocated ? topology.vertices.length * 2 : 0;
    let checksum = 0;
    const sampleVertex = ({ x, z }, vertexIndex) => {
      const offset = vertexIndex * 3;
      const sourceIndex = sourceSlotByTarget?.[vertexIndex] ?? -1;
      if (sourceIndex >= 0) {
        const sourceOffset = sourceIndex * 3;
        const sourcePositions = sourceGeneration.clipmapGeometryResource.positions;
        const sourceColors = sourceGeneration.clipmapGeometryResource.colors;
        const positionY = sourcePositions[sourceOffset + 1];
        const red = sourceColors[sourceOffset];
        const green = sourceColors[sourceOffset + 1];
        const blue = sourceColors[sourceOffset + 2];
        if (positions[offset + 1] !== positionY || colors[offset] !== red
          || colors[offset + 1] !== green || colors[offset + 2] !== blue) {
          dirtySlots.push(vertexIndex);
        }
        positions[offset + 1] = positionY;
        colors[offset] = red;
        colors[offset + 1] = green;
        colors[offset + 2] = blue;
        reusedSampleCount += 1;
        sourceSlotReuseCount += 1;
        sampleHashes[vertexIndex] = sourceGeneration.clipmapGeometryResource
          .sampleHashes[sourceIndex];
        checksum = (checksum ^ sampleHashes[vertexIndex]) >>> 0;
        vertexWriteCount += 1;
        vertexComponentWriteCount += 4;
        return 0;
      }
      const worldX = centerWorldX + x; const worldZ = centerWorldZ + z;
      const distanceOutside = Math.max(Math.abs(x), Math.abs(z))
        - FIVE_BY_FIVE_HALF_EXTENT_METERS;
      const resolved = resolveBaseClipmapSample(
        worldX,
        worldZ,
        surfacePolicy,
        distanceOutside <= CLIPMAP_BLEND_METERS,
      );
      const base = resolved.value;
      if (resolved.lastNaturalSampleReused) {
        reusedSampleCount += 1;
        cacheReuseCount += 1;
      }
      else newlySampledCount += 1;
      if (!resolved.lastSurfaceSampleReused) surfaceRefreshCount += 1;
      let height = base.height;
      let red = base.color[0];
      let green = base.color[1];
      let blue = base.color[2];
      if (distanceOutside <= CLIPMAP_BLEND_METERS) {
        const boundaryX = centerWorldX + clamp(x,
          -FIVE_BY_FIVE_HALF_EXTENT_METERS, FIVE_BY_FIVE_HALF_EXTENT_METERS);
        const boundaryZ = centerWorldZ + clamp(z,
          -FIVE_BY_FIVE_HALF_EXTENT_METERS, FIVE_BY_FIVE_HALF_EXTENT_METERS);
        const actual = sampleActiveTerrain(activeChunks, boundaryX, boundaryZ);
        if (actual !== null) {
          const boundaryBase = baseClipmapSample(boundaryX, boundaryZ, surfacePolicy);
          const activeWeight = 1 - smoothstep(distanceOutside / CLIPMAP_BLEND_METERS);
          height += (actual.height - boundaryBase.height) * activeWeight;
          red += (actual.color[0] - boundaryBase.color[0]) * activeWeight;
          green += (actual.color[1] - boundaryBase.color[1]) * activeWeight;
          blue += (actual.color[2] - boundaryBase.color[2]) * activeWeight;
          if (Math.abs(distanceOutside) < 1e-9) {
            stats.maximumInnerBoundaryErrorMeters = Math.max(
              stats.maximumInnerBoundaryErrorMeters,
              Math.abs(height - actual.height),
            );
            stats.maximumInnerBoundaryColorDifference = Math.max(
              stats.maximumInnerBoundaryColorDifference,
              Math.abs(red - actual.color[0]),
              Math.abs(green - actual.color[1]),
              Math.abs(blue - actual.color[2]),
            );
          }
        }
      }
      const positionY = height * UNITS_PER_METER;
      if (positions[offset + 1] !== positionY || colors[offset] !== red
        || colors[offset + 1] !== green || colors[offset + 2] !== blue) {
        dirtySlots.push(vertexIndex);
      }
      positions[offset + 1] = positionY;
      colors[offset] = red;
      colors[offset + 1] = green;
      colors[offset + 2] = blue;
      let sampleHash = 0x811c9dc5;
      sampleHash = Math.imul(sampleHash ^ Math.round(worldX * 1000), 0x01000193) >>> 0;
      sampleHash = Math.imul(sampleHash ^ Math.round(worldZ * 1000), 0x01000193) >>> 0;
      sampleHash = Math.imul(sampleHash ^ Math.round(positionY * 1000), 0x01000193) >>> 0;
      sampleHash = Math.imul(sampleHash ^ Math.round(red * 1000), 0x01000193) >>> 0;
      sampleHash = Math.imul(sampleHash ^ Math.round(green * 1000), 0x01000193) >>> 0;
      sampleHash = Math.imul(sampleHash ^ Math.round(blue * 1000), 0x01000193) >>> 0;
      sampleHashes[vertexIndex] = sampleHash;
      checksum = (checksum ^ sampleHash) >>> 0;
      vertexWriteCount += 1;
      vertexComponentWriteCount += 4;
      return resolved.lastNaturalSampleReused && resolved.lastSurfaceSampleReused ? 0 : 1;
    };
    return {
      topology,
      positions,
      colors,
      sampleVertex,
      stats,
      target,
      ownedGeometries,
      generation,
      resource,
      geometryAllocated,
      dirtySlots,
      meshOffsetX: (centerWorldX - originMetersX) * UNITS_PER_METER,
      meshOffsetZ: (centerWorldZ - originMetersZ) * UNITS_PER_METER,
      startedAt,
      sampleMetrics: () => ({
        newlySampledCount,
        reusedSampleCount,
        surfaceRefreshCount,
        sourceSlotReuseCount,
        cacheReuseCount,
        vertexWriteCount,
        vertexComponentWriteCount,
        checksum,
      }),
    };
  };

  const finishClipmapBuild = ({
    topology,
    positions,
    colors,
    stats,
    target,
    startedAt,
    sampleMetrics,
    resource,
    geometryAllocated,
    dirtySlots,
    generation,
    meshOffsetX,
    meshOffsetZ,
  }) => {
    const diagnosticStartedAt = diagnosticsEnabled ? monotonicNow() : 0;
    const { geometry } = resource;
    for (let offset = 0; offset < colors.length; offset += 3) {
      if (![colors[offset], colors[offset + 1], colors[offset + 2]].every(Number.isFinite)
        || (colors[offset] === 0 && colors[offset + 1] === 0 && colors[offset + 2] === 0)) {
        throw new Error(`invalid canonical Terrain color at Low vertex ${offset / 3}`);
      }
    }
    const mesh = new Mesh(geometry, terrainMaterial);
    mesh.name = 'w8-seeded-macro-terrain-clipmap';
    mesh.position.set(meshOffsetX, 0, meshOffsetZ);
    mesh.castShadow = false; mesh.receiveShadow = false;
    mesh.userData = {
      ...(mesh.userData ?? {}),
      presentationOnly: true,
      logicalTerrainSurface: true,
      terrainLodBand: W8_LOGICAL_TERRAIN_BAND.LOW,
      innerCellBoundaryMeters: FIVE_BY_FIVE_HALF_EXTENT_METERS,
      outerCellBoundaryMeters: topology.extentMeters,
    };
    target.add(mesh); stats.clipmapMeshCount = 1;
    const {
      newlySampledCount,
      reusedSampleCount,
      surfaceRefreshCount,
      sourceSlotReuseCount,
      cacheReuseCount,
      vertexWriteCount,
      vertexComponentWriteCount,
      checksum,
    } = sampleMetrics();
    stats.clipmapDeterministicChecksum = checksum;
    const sampleCount = topology.vertices.length;
    let uploadBytes;
    let updateRangeCount = 0;
    if (geometryAllocated || resource.published === false) {
      uploadBytes = estimateMeshUploadBytes(mesh);
    } else {
      const positionUpdate = markAttributeRanges(
        geometry.attributes?.position,
        dirtySlots,
        3,
        64,
      );
      const colorUpdate = markAttributeRanges(geometry.attributes?.color, dirtySlots, 3, 64);
      updateRangeCount = (positionUpdate?.rangeCount ?? 0) + (colorUpdate?.rangeCount ?? 0);
      uploadBytes = (positionUpdate?.byteCount ?? 0) + (colorUpdate?.byteCount ?? 0);
    }
    const buildDurationMs = monotonicNow() - startedAt;
    stats.clipmapSampleCount = sampleCount;
    stats.clipmapNewlySampledCount = newlySampledCount;
    stats.clipmapReusedSampleCount = reusedSampleCount;
    stats.clipmapSampleReuseRatio = sampleCount > 0 ? reusedSampleCount / sampleCount : 1;
    stats.clipmapSurfaceRefreshCount = surfaceRefreshCount;
    stats.clipmapSourceSlotReuseCount = sourceSlotReuseCount;
    stats.clipmapCacheReuseCount = cacheReuseCount;
    stats.clipmapVertexWriteCount = vertexWriteCount;
    stats.clipmapVertexComponentWriteCount = vertexComponentWriteCount;
    stats.clipmapDirtySlotCount = dirtySlots.length;
    stats.clipmapUpdateRangeCount = updateRangeCount;
    stats.clipmapBufferUploadBytes = uploadBytes;
    stats.clipmapGeometryAllocationCount = Number(geometryAllocated);
    stats.clipmapIndexAllocationCount = Number(geometryAllocated);
    stats.clipmapBuildDurationMs = buildDurationMs;
    clipmapBuildCount += 1;
    if (reusedSampleCount === 0) clipmapFullBuildCount += 1;
    else clipmapIncrementalBuildCount += 1;
    clipmapTotalSampleCount += sampleCount;
    clipmapTotalNewlySampledCount += newlySampledCount;
    clipmapTotalReusedSampleCount += reusedSampleCount;
    clipmapTotalVertexWriteCount += vertexWriteCount;
    clipmapTotalBufferUploadBytes += uploadBytes;
    clipmapLastBuildDurationMs = buildDurationMs;
    clipmapMaximumBuildDurationMs = Math.max(clipmapMaximumBuildDurationMs, buildDurationMs);
    resource.centerChunkX = generation.centerChunkX;
    resource.centerChunkZ = generation.centerChunkZ;
    if (diagnosticsEnabled) recordDiagnosticWork('terrain-clipmap-build', {
      calls: 1,
      vertices: sampleCount,
      indices: topology.indices.length,
      newlySampledCount,
      reusedSampleCount,
      reuseRatio: stats.clipmapSampleReuseRatio,
      surfaceRefreshCount,
      sourceSlotReuseCount,
      cacheReuseCount,
      vertexWrites: vertexWriteCount,
      vertexComponentWrites: vertexComponentWriteCount,
      dirtySlots: dirtySlots.length,
      updateRanges: updateRangeCount,
      uploadBytes,
      geometryAllocations: Number(geometryAllocated),
      indexAllocations: Number(geometryAllocated),
      allocatedBytes: geometryAllocated
        ? positions.byteLength + colors.byteLength + topology.indices.length * 4 : 0,
      maximumSynchronousSliceMs: monotonicNow() - diagnosticStartedAt,
    });
  };

  const createClipmap = input => {
    const build = prepareClipmapBuild(input);
    for (let index = 0; index < build.topology.vertices.length; index += 1) {
      build.sampleVertex(build.topology.vertices[index], index);
    }
    finishClipmapBuild(build);
  };

  const createClipmapIncrementally = async (input, assertCurrent, scheduler = null) => {
    const build = prepareClipmapBuild(input);
    const sliceScheduler = scheduler ?? createSliceScheduler({
      assertCurrent,
      workKind: 'terrain',
      isUrgent: true,
    });
    const verticesPerCheckpoint = 8;
    for (let start = 0; start < build.topology.vertices.length; start += verticesPerCheckpoint) {
      assertCurrent();
      const end = Math.min(build.topology.vertices.length, start + verticesPerCheckpoint);
      let completedWorkUnits = 0;
      for (let index = start; index < end; index += 1) {
        completedWorkUnits += build.sampleVertex(build.topology.vertices[index], index);
      }
      // A world-fixed hit is a buffer copy, while a miss performs five macro
      // evaluations plus biome/surface resolution. Count only miss work here;
      // elapsed wall time still enforces the 4ms staging budget independently.
      const pendingYield = sliceScheduler.checkpoint({
        units: Math.ceil(completedWorkUnits / 2),
      });
      if (pendingYield) await pendingYield;
    }
    assertCurrent();
    finishClipmapBuild(build);
    const finishYield = sliceScheduler.checkpoint({ force: true });
    if (finishYield) await finishYield;
    return scheduler ? sliceScheduler.snapshot().maximumSliceMs
      : sliceScheduler.finish().maximumSliceMs;
  };

  const recordContinuousTerrainCoverageFrame = (playerLogicalX, playerLogicalZ) => {
    const generation = activeLocalTerrainGeneration?.root?.parent === root
      ? activeLocalTerrainGeneration : null;
    const presetId = activeGeneration?.renderDistancePreset
      ?? generation?.renderDistancePreset
      ?? W8_DEFAULT_RENDER_DISTANCE_PRESET;
    const requiredHalfExtent = resolveW8RenderDistancePolicy(presetId).worldPresentationDistanceMeters;
    const centerWorldX = generation
      ? (generation.centerChunkX + 0.5) * LOGICAL_CHUNK_SIZE_METERS : null;
    const centerWorldZ = generation
      ? (generation.centerChunkZ + 0.5) * LOGICAL_CHUNK_SIZE_METERS : null;
    const terrainExtent = generation?.renderDistancePolicy?.terrainCoverageDistanceMeters ?? null;
    continuousTerrainCoverageComplete = generation !== null
      && Number.isFinite(terrainExtent)
      && Math.abs(playerLogicalX - centerWorldX) + requiredHalfExtent <= terrainExtent
      && Math.abs(playerLogicalZ - centerWorldZ) + requiredHalfExtent <= terrainExtent;
    if (!continuousTerrainCoverageComplete) {
      continuousTerrainCoverageMiss += 1;
      visibleTerrainHoleFrame += 1;
    }
  };

  const createFarRiverPresentation = async ({
    projections,
    origin: renderOrigin,
    context,
    scheduler,
  }) => {
    const instances = [];
    const originMetersX = renderOrigin.renderOriginChunkX * LOGICAL_CHUNK_SIZE_METERS;
    const originMetersZ = renderOrigin.renderOriginChunkZ * LOGICAL_CHUNK_SIZE_METERS;
    for (const projection of projections) {
      const surface = projection.waterSurface;
      if (!surface) continue;
      for (const line of surface.centerlines ?? []) {
        for (let index = 0; index < line.length - 1; index += 1) {
          const start = line[index];
          const end = line[index + 1];
          const dx = end.x - start.x;
          const dz = end.z - start.z;
          const worldX = (start.x + end.x) / 2;
          const worldZ = (start.z + end.z) / 2;
          const sample = baseClipmapSample(worldX, worldZ, context.surfacePolicy);
          transform.position.set(
            (worldX - originMetersX) * UNITS_PER_METER,
            (sample.riverSurfaceHeight ?? sample.baseHeight) * UNITS_PER_METER + 1.5,
            (worldZ - originMetersZ) * UNITS_PER_METER,
          );
          transform.rotation.set(-Math.PI / 2, 0, Math.atan2(dz, dx));
          transform.scale.set(
            (Math.hypot(dx, dz) + 0.01) * UNITS_PER_METER,
            surface.widthMeters * UNITS_PER_METER,
            1,
          );
          transform.updateMatrix();
          instances.push({
            matrix: transform.matrix.clone?.() ?? structuredClone(transform.matrix),
            stableId: surface.stableId,
            ownerKey: `${surface.owningChunkCoordinate.x},${surface.owningChunkCoordinate.z}`,
            lengthMeters: Math.hypot(dx, dz),
          });
          const pendingYield = scheduler.checkpoint();
          if (pendingYield) await pendingYield;
        }
      }
    }
    if (!instances.length) return;
    const mesh = new InstancedMesh(
      roadGeometry,
      visualAssets.materials.water,
      instances.length,
    );
    mesh.name = 'w8-far-canonical-river-water';
    mesh.count = instances.length;
    mesh.userData = {
      presentationOnly: true,
      waterType: 'river',
      canonicalStableIds: instances.map(instance => instance.stableId),
      ownerKeys: instances.map(instance => instance.ownerKey),
    };
    for (let index = 0; index < instances.length; index += 1) {
      mesh.setMatrixAt(index, instances[index].matrix);
      const pendingYield = scheduler.checkpoint();
      if (pendingYield) await pendingYield;
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    context.target.add(mesh);
    context.generation.farRiverPresentation = {
      mesh,
      instances,
      activeSignature: null,
    };
    updateFarRiverVisibility(context.generation);
    context.stats.distantProxyInstancedMeshCount += 1;
  };

  function updateFarRiverVisibility(generation) {
    const presentation = generation?.farRiverPresentation;
    if (!presentation?.mesh) return;
    const activeSignature = sortedKeyList(generation.activeKeys ?? []).join('\n');
    if (presentation.activeSignature === activeSignature) return;
    transform.position.set(0, 0, 0);
    transform.rotation.set(0, 0, 0);
    transform.scale.set(0, 0, 0);
    transform.updateMatrix();
    const hidden = transform.matrix.clone?.() ?? structuredClone(transform.matrix);
    let visibleOwnerCount = 0;
    let visibleSegmentCount = 0;
    let visibleLengthMeters = 0;
    const visibleOwners = new Set();
    presentation.instances.forEach((instance, index) => {
      const visible = !generation.activeKeys.has(instance.ownerKey);
      presentation.mesh.setMatrixAt(index, visible ? instance.matrix : hidden);
      if (visible) {
        visibleOwners.add(instance.ownerKey);
        visibleSegmentCount += 1;
        visibleLengthMeters += instance.lengthMeters;
      }
    });
    visibleOwnerCount = visibleOwners.size;
    presentation.mesh.instanceMatrix.needsUpdate = true;
    presentation.activeSignature = activeSignature;
    generation.stats.visibleFarRiverOwnerCount = visibleOwnerCount;
    generation.stats.visibleFarRiverSegmentCount = visibleSegmentCount;
    generation.stats.visibleFarRiverLengthMeters = visibleLengthMeters;
    generation.stats.canonicalRiverRecordCount =
      generation.stats.canonicalActiveRiverRecordCount + visibleOwnerCount;
    generation.stats.canonicalRiverSegmentCount =
      generation.stats.canonicalActiveRiverSegmentCount + visibleSegmentCount;
    generation.stats.canonicalRiverLengthMeters =
      generation.stats.canonicalActiveRiverLengthMeters + visibleLengthMeters;
  }

  const mapWithQueryConcurrency = async (values, operation, assertCurrent = null) => {
    const results = new Array(values.length);
    let cursor = 0;
    const acquireQuerySlot = () => {
      if (activeQueryCount < CANONICAL_QUERY_CONCURRENCY) {
        activeQueryCount += 1;
        maximumObservedQueryConcurrency = Math.max(
          maximumObservedQueryConcurrency,
          activeQueryCount,
        );
        return Promise.resolve();
      }
      return new Promise(resolve => queryWaiters.push(resolve));
    };
    const releaseQuerySlot = () => {
      activeQueryCount -= 1;
      const next = queryWaiters.shift();
      if (next) {
        activeQueryCount += 1;
        maximumObservedQueryConcurrency = Math.max(
          maximumObservedQueryConcurrency,
          activeQueryCount,
        );
        next();
      }
    };
    const worker = async () => {
      while (cursor < values.length) {
        assertCurrent?.();
        const index = cursor;
        cursor += 1;
        await acquireQuerySlot();
        try {
          results[index] = await operation(values[index], index);
          assertCurrent?.();
        } finally {
          releaseQuerySlot();
        }
      }
    };
    await Promise.all(Array.from(
      { length: Math.min(CANONICAL_QUERY_CONCURRENCY, values.length) },
      () => worker(),
    ));
    return results;
  };

  const prepareCanonicalFarChunks = async ({
    centerWorldX,
    centerWorldZ,
    quality,
    renderDistancePreset,
    activeKeys,
    consumerEpoch,
    assertCurrent = null,
    independentRoadPresentation = false,
    independentRoadContext = null,
  }) => {
    assertCurrent?.();
    const queryStartedAt = globalThis.performance?.now?.() ?? Date.now();
    const renderDistancePolicy = resolveW8RenderDistancePolicy(renderDistancePreset);
    const visibilityMeters = renderDistancePolicy.generalDetailDistanceMeters;
    const roadVisibilityMeters = renderDistancePolicy.worldPresentationDistanceMeters;
    const settlementPolicy = resolveW8SettlementPresentationPolicy(
      quality,
      renderDistancePolicy.id,
    );
    const localQueryRadius = visibilityMeters + CANONICAL_QUERY_MARGIN_METERS;
    const roadQueryRadius = roadVisibilityMeters + CANONICAL_QUERY_MARGIN_METERS;
    const queryRadius = Math.max(
      localQueryRadius,
      roadQueryRadius,
      settlementPolicy.metadata.queryDistanceMeters,
    );
    const settlementQuery = mapWithQueryConcurrency(
      [{ centerWorldX, centerWorldZ, queryRadius }],
      query => findSettlementsNear(
        query.centerWorldX,
        query.centerWorldZ,
        query.queryRadius,
      ),
      assertCurrent,
    );
    const majorRoadOwnerCoverageQuery = !independentRoadPresentation
      && resolveCanonicalMajorRoadOwnerCoverage
      ? resolveCanonicalMajorRoadOwnerCoverage({
        centerWorldX,
        centerWorldZ,
        radiusMeters: roadQueryRadius,
        priority: CHUNK_DATA_PRIORITY.GAMEPLAY_REQUIRED,
        required: true,
        consumerId: 'distant-major-road-owner-query',
      })
      : Promise.resolve(null);
    const [[candidateResult], canonicalMajorRoadOwnerCoverage] = await Promise.all([
      settlementQuery,
      majorRoadOwnerCoverageQuery,
    ]);
    assertCurrent?.();
    const candidates = [...candidateResult].filter(candidate => (
      settlementCandidateDistance(candidate, centerWorldX, centerWorldZ).boundaryDistanceMeters
        <= queryRadius
    )).sort((left, right) => left.settlementId.localeCompare(right.settlementId));
    const selection = selectW8SettlementPresentationCandidates({
      candidates,
      playerX: centerWorldX,
      playerZ: centerWorldZ,
      quality,
      renderDistancePreset: renderDistancePolicy.id,
    });
    const roadEntries = selection.ranked.filter(entry => (
      entry.boundaryDistanceMeters <= roadVisibilityMeters
    ));
    const selectedEntryById = new Map();
    for (const entry of [...selection.local, ...selection.remote, ...roadEntries]) {
      if (!selectedEntryById.has(entry.candidate.settlementId)) {
        selectedEntryById.set(entry.candidate.settlementId, entry);
      }
    }
    const selectedEntries = [...selectedEntryById.values()];
    const templateResolutionStartedAt = globalThis.performance?.now?.() ?? Date.now();
    const resolvedTemplates = await mapWithQueryConcurrency(selectedEntries, entry => readThroughLru(
      templateCache,
      entry.candidate.settlementId,
      TEMPLATE_CACHE_CAPACITY,
      () => resolveTemplate({ candidate: entry.candidate }),
    ), assertCurrent);
    const templateResolutionDurationMs = (globalThis.performance?.now?.() ?? Date.now())
      - templateResolutionStartedAt;
    assertCurrent?.();
    const selected = selectedEntries.map((entry, index) => ({
      ...entry,
      template: resolvedTemplates[index],
    })).filter(value => value.template);
    const selectedById = new Map(selected.map(value => [value.candidate.settlementId, value]));
    const localSelections = selection.local.map(value => (
      selectedById.get(value.candidate.settlementId)
    )).filter(Boolean);
    const activeLocalSelection = selection.activeLocal
      ? selectedById.get(selection.activeLocal.candidate.settlementId) ?? null
      : null;
    const additionalLocalSelections = localSelections.filter(value => (
      value.candidate.settlementId !== activeLocalSelection?.candidate.settlementId
    ));
    const remoteSelections = selection.remote.map(value => (
      selectedById.get(value.candidate.settlementId)
    )).filter(Boolean);
    const roadSelections = roadEntries.map(value => (
      selectedById.get(value.candidate.settlementId)
    )).filter(Boolean);
    const horizonSelections = [
      ...(activeLocalSelection ? [{ ...activeLocalSelection, standby: true }] : []),
      ...remoteSelections.map(value => ({ ...value, standby: false })),
    ];
    const selectionDiagnostics = selection.ranked.map(value => {
      const resolved = selectedById.get(value.candidate.settlementId);
      return Object.freeze({
        settlementId: value.candidate.settlementId,
        centerDistanceMeters: value.centerDistanceMeters,
        boundaryDistanceMeters: value.boundaryDistanceMeters,
        tier: value.tier,
        selected: value.selected,
        selectedReason: value.selectedReason,
        roadSilhouetteSelected: roadEntries.some(entry => (
          entry.candidate.settlementId === value.candidate.settlementId
        )),
        buildingCount: resolved?.template?.buildings?.length ?? null,
      });
    });
    const ownerQueries = new Map();
    const addOwnerCoordinate = (chunkX, chunkZ) => {
      const key = `${chunkX},${chunkZ}`;
      if (!ownerQueries.has(key)) {
        ownerQueries.set(key, {
          key,
          chunkX,
          chunkZ,
          settlementIds: new Set(),
          roadSettlementIds: new Set(),
          canonicalMajorRoadCoverage: false,
          remoteHorizonSettlementIds: new Set(),
        });
      }
      return ownerQueries.get(key);
    };
    const addSettlementOwner = (point, settlementId, kind = 'settlement') => {
      const owner = determineDetailCandidateOwner(point);
      const ownerQuery = addOwnerCoordinate(owner.x, owner.z);
      if (kind === 'road') ownerQuery.roadSettlementIds.add(settlementId);
      else ownerQuery.settlementIds.add(settlementId);
    };
    for (const { template } of localSelections) {
      assertCurrent?.();
      for (const building of template.buildings ?? []) {
        if (Math.hypot(
          building.x - centerWorldX,
          building.z - centerWorldZ,
        ) <= localQueryRadius) addSettlementOwner(building, template.settlementId);
      }
      if (Math.hypot(
        template.center.x - centerWorldX,
        template.center.z - centerWorldZ,
      ) <= localQueryRadius + 32) addSettlementOwner(template.center, template.settlementId);
    }
    for (const { template } of roadSelections) {
      assertCurrent?.();
      for (const road of template.roads ?? []) {
        const dx = road.end.x - road.start.x;
        const dz = road.end.z - road.start.z;
        const sampleCount = Math.max(1, Math.ceil(Math.hypot(dx, dz) / 8));
        for (let sample = 0; sample <= sampleCount; sample += 1) {
          const t = sample / sampleCount;
          const point = {
            x: road.start.x + dx * t,
            z: road.start.z + dz * t,
          };
          if (Math.hypot(
            point.x - centerWorldX,
            point.z - centerWorldZ,
          ) <= roadQueryRadius) addSettlementOwner(point, template.settlementId, 'road');
        }
      }
    }
    for (const coordinate of canonicalMajorRoadOwnerCoverage?.ownerCoordinates ?? []) {
      assertCurrent?.();
      addOwnerCoordinate(coordinate.chunkX, coordinate.chunkZ).canonicalMajorRoadCoverage = true;
    }
    const isRoadOwner = owner => (
      owner.roadSettlementIds.size > 0 || owner.canonicalMajorRoadCoverage === true
    );
    for (const remote of horizonSelections) {
      const center = remote.candidate.center ?? remote.candidate.worldPosition;
      const owner = determineDetailCandidateOwner(center);
      addOwnerCoordinate(owner.x, owner.z)
        .remoteHorizonSettlementIds.add(remote.candidate.settlementId);
    }
    const owners = [...ownerQueries.values()]
      .filter(owner => !activeKeys.has(owner.key))
      .sort((left, right) => (
        left.chunkZ - right.chunkZ || left.chunkX - right.chunkX
      ));
    const roadOwners = owners.filter(isRoadOwner);
    if (independentRoadPresentation && independentRoadContext) {
      stageIndependentRoadSettlementOwners({
        owners: roadOwners,
        settlementIds: localSelections.map(value => value.candidate.settlementId),
        roadSettlementIds: roadSelections.map(value => value.candidate.settlementId),
        queryRadius,
        roadVisibilityMeters,
        roadQueryRadius,
      });
    }
    const mainOwners = independentRoadPresentation
      ? owners.filter(owner => (
        owner.settlementIds.size > 0
        || owner.remoteHorizonSettlementIds.size > 0
      ))
      : owners;
    const roadLifecycle = lifecycleFor(consumerEpoch);
    if (roadLifecycle && !independentRoadPresentation) {
      roadLifecycle.status = 'loading';
      roadLifecycle.queryPlannedAtMs = monotonicNow();
      roadLifecycle.roadVisibilityMeters = roadVisibilityMeters;
      roadLifecycle.roadQueryRadius = roadQueryRadius;
      roadLifecycle.plannedRoadOwnerKeys = owners
        .filter(isRoadOwner)
        .map(owner => owner.key)
        .sort();
    }
    const cacheBefore = {
      hits: farOwnerChunkCacheHits,
      misses: farOwnerChunkCacheMisses,
      evictions: farOwnerChunkCacheEvictions,
    };
    const loadOwners = async ownerList => mapWithQueryConcurrency(ownerList, async owner => {
      let cacheDisposition = null;
      const chunk = await readThroughLru(
        farOwnerChunkCache,
        owner.key,
        FAR_OWNER_CHUNK_CACHE_CAPACITY,
        async () => {
          return getCanonicalChunkData(owner.chunkX, owner.chunkZ, {
            priority: CHUNK_DATA_PRIORITY.DISTANT_OWNER,
            consumerId: 'distant-owner-query',
            epoch: consumerEpoch,
          });
        },
        event => {
          if (event === 'hit') farOwnerChunkCacheHits += 1;
          else if (event === 'miss') farOwnerChunkCacheMisses += 1;
          else if (event === 'eviction') farOwnerChunkCacheEvictions += 1;
          if (event === 'hit' || event === 'miss') cacheDisposition = event;
        },
        consumerEpoch,
      );
      if (roadLifecycle && !independentRoadPresentation && isRoadOwner(owner)) {
        roadLifecycle.completedRoadOwnerKeys.push(owner.key);
        roadLifecycle.completedRoadOwnerKeys.sort();
        if (cacheDisposition === 'hit') roadLifecycle.cacheHitCount += 1;
        if (cacheDisposition === 'miss') roadLifecycle.cacheMissCount += 1;
        const presentationResource = presentationOwnerResourceOf(chunk);
        const roadRecords = [
          ...(presentationResource?.structures ?? []).map(expandPresentationStructureRecord),
          ...(chunk?.presentationLayers?.formal?.roadsAndBuildings
            ?? chunk?.settlementFeatures ?? []),
        ].filter(record => record?.featureType === 'settlement-road'
          && (record.canonicalMajorRoad === true
            || owner.roadSettlementIds.has(record.settlementId ?? record.parentSettlementId)));
        roadLifecycle.loadedRoadRecordCount += roadRecords.length;
        if (roadLifecycle.roadOwnerLoadEvents.length
          < W8_ROAD_LIFECYCLE_DIAGNOSTIC_RECORD_LIMIT) {
          roadLifecycle.roadOwnerLoadEvents.push({
            ownerKey: owner.key,
            completedAtMs: monotonicNow(),
            cacheDisposition,
            loadedRoadRecordCount: roadRecords.length,
          });
        }
      }
      return { ...owner, chunk };
    }, assertCurrent);
    const innerWarmStartedAt = globalThis.performance?.now?.() ?? Date.now();
    const chunks = await loadOwners(mainOwners);
    assertCurrent?.();
    if (roadLifecycle && !independentRoadPresentation) {
      roadLifecycle.queryReadyAtMs = monotonicNow();
      roadLifecycle.status = 'query-ready';
    }
    const innerWarmDurationMs = (globalThis.performance?.now?.() ?? Date.now()) - innerWarmStartedAt;
    const remoteHorizons = horizonSelections.map(remote => {
      const ownerChunk = chunks.find(value => (
        value.remoteHorizonSettlementIds.has(remote.candidate.settlementId)
      ))?.chunk;
      const landmarks = [
        ...(ownerChunk?.presentationLayers?.landmarks ?? ownerChunk?.settlementLandmarks ?? []),
      ].filter(record => (
        (record.parentSettlementId ?? record.settlementId) === remote.candidate.settlementId
          && W8_SETTLEMENT_ROLE_LANDMARKS[remote.candidate.townType]?.landmarkType
            === record.landmarkType
      )).slice(0, 1);
      return Object.freeze({
        ...remote,
        landmarks: Object.freeze(landmarks),
      });
    });
    const minimumRiverChunkX = Math.floor(
      (centerWorldX - renderDistancePolicy.terrainCoverageDistanceMeters)
        / LOGICAL_CHUNK_SIZE_METERS,
    );
    const maximumRiverChunkX = Math.floor(
      (centerWorldX + renderDistancePolicy.terrainCoverageDistanceMeters)
        / LOGICAL_CHUNK_SIZE_METERS,
    );
    const minimumRiverChunkZ = Math.floor(
      (centerWorldZ - renderDistancePolicy.terrainCoverageDistanceMeters)
        / LOGICAL_CHUNK_SIZE_METERS,
    );
    const maximumRiverChunkZ = Math.floor(
      (centerWorldZ + renderDistancePolicy.terrainCoverageDistanceMeters)
        / LOGICAL_CHUNK_SIZE_METERS,
    );
    const riverOwnerCoordinates = [];
    for (let chunkZ = minimumRiverChunkZ; chunkZ <= maximumRiverChunkZ; chunkZ += 1) {
      for (let chunkX = minimumRiverChunkX; chunkX <= maximumRiverChunkX; chunkX += 1) {
        const key = `${chunkX},${chunkZ}`;
        if (!canonicalRiverMayAffectChunk({
          chunkX,
          chunkZ,
          settlementReferences: candidates,
        })) continue;
        riverOwnerCoordinates.push({ chunkX, chunkZ });
      }
    }
    const riverProjections = (await mapWithQueryConcurrency(
      riverOwnerCoordinates,
      coordinate => createCanonicalRiverProjection({
        worldSeedHash,
        chunkX: coordinate.chunkX,
        chunkZ: coordinate.chunkZ,
        settlementReferences: candidates,
      }),
      assertCurrent,
    )).filter(projection => projection.surfaceCorridor || projection.waterSurface);
    assertCurrent?.();
    return {
      queryCenter: { x: centerWorldX, z: centerWorldZ },
      queryRadius,
      visibilityMeters,
      roadVisibilityMeters,
      roadQueryRadius,
      candidateCount: candidates.length,
      activeLocalSettlementId: activeLocalSelection?.candidate.settlementId ?? null,
      additionalLocalSettlementIds: additionalLocalSelections.map(value => (
        value.candidate.settlementId
      )),
      localSettlementIds: localSelections.map(value => value.candidate.settlementId),
      localSettlementLimit: settlementPolicy.local.settlementLimit,
      settlementSelections: Object.freeze(selectionDiagnostics),
      templateSuccessCount: selected.length,
      remoteCandidateCount: selection.remote.length,
      remoteSelectedCount: remoteSelections.length,
      remoteHorizonMaterializedCount: remoteHorizons.length,
      remoteSettlementLimit: settlementPolicy.remote.settlementLimit,
      remoteBuildingLimitPerSettlement: settlementPolicy.remote.buildingLimitPerSettlement,
      remotePartLimit: settlementPolicy.remote.partLimit,
      remoteHorizonStartMeters: settlementPolicy.remote.horizonStartMeters,
      remoteFadeStartMeters: settlementPolicy.remote.fadeStartMeters,
      remoteFadeEndMeters: settlementPolicy.remote.fadeEndMeters,
      remoteHiddenDistanceMeters: settlementPolicy.remote.hiddenDistanceMeters,
      remoteFogEnabled: settlementPolicy.remote.fog,
      remoteAtmosphereMode: settlementPolicy.remote.atmosphere.mode,
      remoteFogIntegrationEndMeters:
        settlementPolicy.remote.atmosphere.fogIntegrationEndMeters,
      settlementMetadataQueryDistanceMeters: settlementPolicy.metadata.queryDistanceMeters,
      ownerChunkCount: mainOwners.length,
      ownerChunkKeys: mainOwners.map(owner => owner.key),
      buildingOwnerChunkCount: owners.filter(owner => owner.settlementIds.size > 0).length,
      buildingOwnerChunkKeys: owners.filter(owner => owner.settlementIds.size > 0).map(owner => owner.key),
      roadOwnerChunkCount: independentRoadPresentation
        ? independentRoadDesiredOwners.size : roadOwners.length,
      roadOwnerChunkKeys: independentRoadPresentation
        ? [...independentRoadDesiredOwners.keys()].sort()
        : roadOwners.map(owner => owner.key),
      canonicalMajorRoadOwnerCoverageCount:
        canonicalMajorRoadOwnerCoverage?.ownerCount ?? 0,
      canonicalMajorRoadNetworkRoadCount:
        canonicalMajorRoadOwnerCoverage?.roadCount ?? 0,
      canonicalMajorRoadNetworkGraphEdgeCount:
        canonicalMajorRoadOwnerCoverage?.graphEdgeCount ?? 0,
      remoteHorizonOwnerChunkCount: owners.filter(owner => (
        owner.remoteHorizonSettlementIds.size > 0
      )).length,
      farOwnerChunkCacheHits: farOwnerChunkCacheHits - cacheBefore.hits,
      farOwnerChunkCacheMisses: farOwnerChunkCacheMisses - cacheBefore.misses,
      farOwnerChunkCacheEvictions: farOwnerChunkCacheEvictions - cacheBefore.evictions,
      innerWarmDurationMs,
      queryPreparationDurationMs: (globalThis.performance?.now?.() ?? Date.now()) - queryStartedAt,
      templateResolutionDurationMs,
      canonicalChunkSuccessCount: chunks.filter(value => value.chunk).length,
      settlementFeatureCount: chunks.reduce(
        (sum, value) => sum + (
          presentationOwnerResourceOf(value.chunk)?.structures?.length
          ?? value.chunk?.settlementFeatures?.length
          ?? 0
        ),
        0,
      ),
      majorRoadFeatureCount: chunks.reduce(
        (sum, value) => sum + (
          presentationOwnerResourceOf(value.chunk)?.structures
          ?? value.chunk?.settlementFeatures
          ?? []
        ).filter(feature => feature.canonicalMajorRoad === true).length,
        0,
      ),
      landmarkCount: chunks.reduce(
        (sum, value) => sum + (value.chunk?.settlementLandmarks?.length ?? 0),
        0,
      ),
      settlementIds: new Set(localSelections.map(value => value.candidate.settlementId)),
      roadSettlementIds: new Set(roadSelections.map(value => value.candidate.settlementId)),
      remoteHorizons: Object.freeze(remoteHorizons),
      riverProjections: Object.freeze(riverProjections),
      chunks: chunks.filter(value => value.chunk),
    };
  };

  const syncLocalTerrainIncrementally = async ({
    coverageEpoch,
    transitionContract = null,
    activeDataKeys,
    renderedKeys,
    getChunkData,
    renderOrigin,
    centerChunkX,
    centerChunkZ,
    renderDistancePreset = W8_DEFAULT_RENDER_DISTANCE_PRESET,
    deferPublication = false,
    presentationGenerationIdentity = null,
    isPresentationGenerationCurrent = null,
    isTerrainPresentationUrgent = null,
  } = {}) => {
    const startedAt = monotonicNow();
    localTerrainLastRootSwapDurationMs = 0;
    localTerrainLastMaximumSliceMs = 0;
    localTerrainLastSliceCount = 0;
    const requestedEpoch = Number(coverageEpoch);
    if (!Number.isSafeInteger(requestedEpoch) || requestedEpoch < 1) {
      throw new TypeError('coverageEpoch must be a positive safe integer');
    }
    if (!Array.isArray(activeDataKeys) || !Array.isArray(renderedKeys)
      || typeof getChunkData !== 'function') {
      throw new TypeError('Incremental Local terrain sync requires active/rendered keys and ChunkData');
    }
    const acceptedTransition = validateTransitionCoverage(transitionContract, {
      activeDataKeys,
      renderedKeys,
      centerChunkX,
      centerChunkZ,
    });
    recordDiagnosticEvent('terrain-replacement-requested', {
      coverageEpoch: requestedEpoch,
      transitionGeneration: acceptedTransition?.generation ?? null,
      centerChunkX,
      centerChunkZ,
      renderDistancePreset: normalizeW8RenderDistancePreset(renderDistancePreset),
      oldRootId: activeLocalTerrainGeneration?.root?.name ?? null,
      oldRootAttached: activeLocalTerrainGeneration?.root?.parent === root,
    });
    localTerrainLastRequestedEpoch = requestedEpoch;
    localTerrainLastActiveKeyCount = activeDataKeys.length;
    localTerrainLastRenderedKeyCount = renderedKeys.length;
    localTerrainLastResolvedChunkCount = 0;
    localTerrainLastMidgroundOwnerCount = 0;
    localTerrainLastMissingOwnerKeys = Object.freeze([]);
    localTerrainLastRejectionReason = null;
    const reject = (reason, missingOwnerKeys = []) => {
      localTerrainRejectionCount += 1;
      localTerrainLastRejectionReason = reason;
      localTerrainLastMissingOwnerKeys = Object.freeze(sortedKeyList(missingOwnerKeys));
      localTerrainLastSyncDurationMs = monotonicNow() - startedAt;
      recordDiagnosticEvent('terrain-replacement-rejected', {
        coverageEpoch: requestedEpoch,
        transitionGeneration: acceptedTransition?.generation ?? null,
        reason,
        missingOwnerKeys: localTerrainLastMissingOwnerKeys,
        activeRootId: activeLocalTerrainGeneration?.root?.name ?? null,
        activeRootAttached: activeLocalTerrainGeneration?.root?.parent === root,
        stagingRootId: stagingLocalTerrainRootId,
      });
      return Object.freeze({
        committed: false,
        reused: false,
        coverageEpoch: requestedEpoch,
        reason,
        missingOwnerKeys: localTerrainLastMissingOwnerKeys,
        activeRootId: activeLocalTerrainGeneration?.root?.name ?? null,
      });
    };
    if (disposed) return reject('disposed');
    if (!deferPublication && !acceptCommittedRenderOrigin(renderOrigin)) {
      localTerrainStaleDiscardCount += 1;
      return reject('stale-render-origin');
    }
    if (!deferPublication && requestedEpoch < localTerrainSyncEpoch) {
      localTerrainStaleDiscardCount += 1;
      return reject('stale-epoch');
    }
    if (deferPublication && (typeof presentationGenerationIdentity !== 'string'
      || !presentationGenerationIdentity)) {
      throw new TypeError('presentationGenerationIdentity is required for deferred Local Terrain');
    }
    if (deferPublication
      && !preparedTerrainPresentationGenerations.has(presentationGenerationIdentity)
      && preparedTerrainPresentationGenerations.size
        >= TERRAIN_PRESENTATION_STAGED_GENERATION_LIMIT) {
      return reject('presentation-staging-capacity');
    }
    if (deferPublication) {
      const existingPrepared = preparedTerrainPresentationGenerations.get(
        presentationGenerationIdentity,
      );
      if (existingPrepared) {
        const requestedPreset = normalizeW8RenderDistancePreset(renderDistancePreset);
        if (existingPrepared.centerChunkX !== centerChunkX
          || existingPrepared.centerChunkZ !== centerChunkZ
          || existingPrepared.renderDistancePreset !== requestedPreset
          || !equalKeySets(existingPrepared.generation.activeKeys, new Set(activeDataKeys))
          || !equalKeySets(existingPrepared.generation.renderedKeys, new Set(renderedKeys))) {
          throw new Error(`conflicting Terrain presentation identity: ${presentationGenerationIdentity}`);
        }
        return Object.freeze({
          committed: false,
          prepared: true,
          reused: true,
          coverageEpoch: existingPrepared.coverageEpoch,
          reason: null,
          missingOwnerKeys: Object.freeze([]),
          activeRootId: activeLocalTerrainGeneration?.root?.name ?? null,
          presentationGeneration: existingPrepared,
        });
      }
    }
    if (isPresentationGenerationCurrent !== null
      && typeof isPresentationGenerationCurrent !== 'function') {
      throw new TypeError('isPresentationGenerationCurrent must be a function when provided');
    }
    if (isTerrainPresentationUrgent !== null
      && typeof isTerrainPresentationUrgent !== 'function') {
      throw new TypeError('isTerrainPresentationUrgent must be a function when provided');
    }
    const assertCurrent = () => {
      const current = deferPublication
        ? isPresentationGenerationCurrent?.() !== false
        : requestedEpoch === localTerrainSyncEpoch && transitionIsCurrent(acceptedTransition);
      if (disposed || !current) throw LOCAL_SYNC_CANCELLED;
    };
    const renderDistancePolicy = resolveW8RenderDistancePolicy(renderDistancePreset);
    const activeKeys = new Set(activeDataKeys);
    const rendered = new Set(renderedKeys);
    if (activeDataKeys.length !== 25 || activeKeys.size !== 25) {
      return reject('active-key-count');
    }
    if (renderedKeys.length !== 9 || rendered.size !== 9) {
      return reject('rendered-key-count');
    }
    const renderedOutsideActive = [...rendered].filter(key => !activeKeys.has(key));
    if (renderedOutsideActive.length) {
      return reject('rendered-owner-outside-active', renderedOutsideActive);
    }
    if (!deferPublication && !acceptRuntimeTransitionContract(acceptedTransition)) {
      localTerrainStaleDiscardCount += 1;
      return reject('stale-transition');
    }
    if (!deferPublication) localTerrainSyncEpoch = requestedEpoch;
    const activeChunks = new Map();
    const missingOwnerKeys = [];
    for (const key of activeDataKeys) {
      const [chunkX, chunkZ] = key.split(',').map(Number);
      const chunk = getChunkData(chunkX, chunkZ);
      if (!chunk || chunk.chunkX !== chunkX || chunk.chunkZ !== chunkZ) {
        missingOwnerKeys.push(key);
      } else {
        activeChunks.set(key, chunk);
      }
    }
    localTerrainLastResolvedChunkCount = activeChunks.size;
    if (missingOwnerKeys.length) return reject('missing-chunk-data', missingOwnerKeys);
    const midgroundOwnerKeys = new Set([...activeKeys].filter(key => !rendered.has(key)));
    localTerrainLastMidgroundOwnerCount = midgroundOwnerKeys.size;
    if (midgroundOwnerKeys.size !== 16) return reject('midground-owner-count');
    const scheduler = createSliceScheduler({
      assertCurrent,
      budgetMs: deferPublication
        ? TERRAIN_PRESENTATION_STAGING_SLICE_BUDGET_MS
        : PRESENTATION_SLICE_BUDGET_MS,
      workKind: 'terrain',
      isUrgent: () => deferPublication
        ? isTerrainPresentationUrgent?.() === true : true,
      trackGeneration: deferPublication,
    });

    let surfacePolicy = surfacePolicyForChunks(activeChunks.values());
    try {
      scheduler.setStage?.('surface-corridors');
      const corridors = await riverSurfaceCorridorsForClipmapIncrementally(
        centerChunkX,
        centerChunkZ,
        surfacePolicy,
        renderDistancePolicy.terrainCoverageDistanceMeters,
        scheduler,
      );
      assertCurrent();
      surfacePolicy = Object.freeze({
        ...surfacePolicy,
        riverCorridors: Object.freeze(corridors),
      });
    } catch (error) {
      const sliceSnapshot = scheduler.snapshot();
      localTerrainLastMaximumSliceMs = sliceSnapshot.maximumSliceMs;
      localTerrainLastSliceCount = sliceSnapshot.sliceCount;
      if (error === LOCAL_SYNC_CANCELLED) {
        localTerrainStaleDiscardCount += 1;
        return reject(disposed ? 'disposed-during-build' : 'stale-after-build');
      }
      throw error;
    }

    const reusableMidgroundMesh = !deferPublication && activeLocalTerrainGeneration
      && activeLocalTerrainGeneration.centerChunkX === centerChunkX
      && activeLocalTerrainGeneration.centerChunkZ === centerChunkZ
      && equalKeySets(activeLocalTerrainGeneration.activeKeys, activeKeys)
      && equalKeySets(activeLocalTerrainGeneration.renderedKeys, rendered)
      ? activeLocalTerrainGeneration.root.children?.find(child => (
        child.name === 'w8-midground-outer-sixteen-terrain'
      )) ?? null
      : null;
    if (!deferPublication && activeLocalTerrainGeneration
      && activeLocalTerrainGeneration.centerChunkX === centerChunkX
      && activeLocalTerrainGeneration.centerChunkZ === centerChunkZ
      && activeLocalTerrainGeneration.renderDistancePreset === renderDistancePolicy.id
      && equalKeySets(activeLocalTerrainGeneration.activeKeys, activeKeys)
      && equalKeySets(activeLocalTerrainGeneration.renderedKeys, rendered)) {
      positionGenerationForOrigin(activeLocalTerrainGeneration, renderOrigin);
      applyLocalTerrainOwnerHandoff(
        activeLocalTerrainGeneration,
        activeDataKeys,
        renderedKeys,
      );
      assignTransitionContract(activeLocalTerrainGeneration, acceptedTransition);
      recordDiagnosticEvent('terrain-coverage-verified', {
        coverageEpoch: requestedEpoch,
        transitionGeneration: acceptedTransition?.generation ?? null,
        rootId: activeLocalTerrainGeneration.root.name,
        rootAttached: activeLocalTerrainGeneration.root.parent === root,
        reused: true,
        activeOwnerCount: activeKeys.size,
        renderedOwnerCount: rendered.size,
      });
      committedLocalTerrainEpoch = requestedEpoch;
      currentCanonicalSurfacePolicy = surfacePolicy;
      recordDiagnosticEvent('terrain-replacement-reused', {
        coverageEpoch: requestedEpoch,
        transitionGeneration: acceptedTransition?.generation ?? null,
        rootId: activeLocalTerrainGeneration.root.name,
        rootAttached: activeLocalTerrainGeneration.root.parent === root,
      });
      const sliceSnapshot = scheduler.finish();
      localTerrainLastMaximumSliceMs = sliceSnapshot.maximumSliceMs;
      localTerrainLastSliceCount = sliceSnapshot.sliceCount;
      localTerrainLastSyncDurationMs = monotonicNow() - startedAt;
      return Object.freeze({
        committed: true,
        reused: true,
        coverageEpoch: requestedEpoch,
        reason: null,
        missingOwnerKeys: Object.freeze([]),
        activeRootId: activeLocalTerrainGeneration.root.name,
      });
    }

    const localRoot = new Group();
    localRoot.name = `w8-local-terrain-coverage-epoch-${requestedEpoch}`;
    localRoot.userData = {
      presentationOnly: true,
      localTerrainCoverage: true,
      coverageEpoch: requestedEpoch,
      renderDistancePreset: renderDistancePolicy.id,
    };
    stagingLocalTerrainRootId = localRoot.name;
    const generation = {
      epoch: requestedEpoch,
      createdAtMs: monotonicNow(),
      activatedAtMs: null,
      root: localRoot,
      ownedGeometries: new Set(),
      ownedMaterials: new Set(),
      stats: createStats(),
      activeKeys,
      renderedKeys: rendered,
      midgroundOwnerKeys,
      centerChunkX,
      centerChunkZ,
      renderDistancePreset: renderDistancePolicy.id,
      renderDistancePolicy,
      buildOriginChunkX: renderOrigin.renderOriginChunkX,
      buildOriginChunkZ: renderOrigin.renderOriginChunkZ,
      currentOriginChunkX: renderOrigin.renderOriginChunkX,
      currentOriginChunkZ: renderOrigin.renderOriginChunkZ,
      surfacePolicy,
    };
    assignTransitionContract(generation, acceptedTransition);
    const context = {
      target: localRoot,
      ownedGeometries: generation.ownedGeometries,
      stats: generation.stats,
      generation,
      surfacePolicy,
    };
    const midground = [...midgroundOwnerKeys]
      .map(key => activeChunks.get(key))
      .sort((left, right) => left.chunkZ - right.chunkZ || left.chunkX - right.chunkX);
    const terrainOwners = [...activeKeys]
      .map(key => activeChunks.get(key))
      .sort((left, right) => left.chunkZ - right.chunkZ || left.chunkX - right.chunkX);
    let outerReadyAtMs = null;
    let clipmapReadyAtMs = null;
    try {
      scheduler.setStage?.('outer-mid');
      generation.stats.midgroundChunkCount = midground.length;
      if (reusableMidgroundMesh) {
        const midgroundMesh = new Mesh(
          reusableMidgroundMesh.geometry,
          reusableMidgroundMesh.material,
        );
        midgroundMesh.name = reusableMidgroundMesh.name;
        midgroundMesh.castShadow = reusableMidgroundMesh.castShadow;
        midgroundMesh.receiveShadow = reusableMidgroundMesh.receiveShadow;
        midgroundMesh.userData = { ...(reusableMidgroundMesh.userData ?? {}) };
        localRoot.add(midgroundMesh);
        generation.localTerrainMesh = midgroundMesh;
        generation.currentVisibleMidgroundOwnerKeys = new Set(
          midgroundMesh.userData.visibleOwnerKeys ?? [],
        );
        generation.reusedMidgroundGeometry = reusableMidgroundMesh.geometry;
        const pendingYield = scheduler.checkpoint({ force: true });
        if (pendingYield) await pendingYield;
      } else {
        await createMidgroundTerrainIncrementally(
          terrainOwners,
          renderOrigin,
          context,
          scheduler,
        );
      }
      outerReadyAtMs = monotonicNow();
      scheduler.setStage?.('clipmap');
      await createClipmapIncrementally({
        centerChunkX,
        centerChunkZ,
        activeChunks,
        origin: renderOrigin,
        renderDistancePreset: renderDistancePolicy.id,
        surfacePolicy,
        stats: generation.stats,
        target: localRoot,
        ownedGeometries: generation.ownedGeometries,
        generation,
      }, assertCurrent, scheduler);
      clipmapReadyAtMs = monotonicNow();
      scheduler.setStage?.('finalize');
      assertCurrent();
      applyLocalTerrainOwnerHandoff(generation, activeDataKeys, renderedKeys);
      positionGenerationForOrigin(generation, renderOrigin);
      const sliceSnapshot = scheduler.finish();
      localTerrainLastMaximumSliceMs = sliceSnapshot.maximumSliceMs;
      localTerrainLastSliceCount = sliceSnapshot.sliceCount;
    } catch (error) {
      disposeGeneration(generation);
      if (stagingLocalTerrainRootId === localRoot.name) stagingLocalTerrainRootId = null;
      const sliceSnapshot = scheduler.snapshot();
      localTerrainLastMaximumSliceMs = sliceSnapshot.maximumSliceMs;
      localTerrainLastSliceCount = sliceSnapshot.sliceCount;
      if (error === LOCAL_SYNC_CANCELLED) {
        localTerrainStaleDiscardCount += 1;
        return reject(disposed ? 'disposed-during-build' : 'stale-after-build');
      }
      localTerrainLastRejectionReason = 'build-error';
      localTerrainLastSyncDurationMs = monotonicNow() - startedAt;
      throw error;
    }
    if (stagingLocalTerrainRootId === localRoot.name) stagingLocalTerrainRootId = null;
    assertCurrent();
    const previous = activeLocalTerrainGeneration;
    recordDiagnosticEvent('terrain-replacement-ready', {
      coverageEpoch: requestedEpoch,
      transitionGeneration: acceptedTransition?.generation ?? null,
      rootId: generation.root.name,
      rootAttached: generation.root.parent === root,
      geometryCount: generation.ownedGeometries.size,
      oldRootId: previous?.root?.name ?? null,
      oldRootAttached: previous?.root?.parent === root,
    });
    if (deferPublication) {
      const prior = preparedTerrainPresentationGenerations.get(
        presentationGenerationIdentity,
      );
      if (prior && prior.generation !== generation) {
        disposeGeneration(prior.generation);
        terrainPresentationGenerationDiscardCount += 1;
      }
      const geometryCount = generation.ownedGeometries.size;
      const uploadBytes = [...(generation.root.children ?? [])].reduce(
        (sum, mesh) => sum + estimateMeshUploadBytes(mesh),
        0,
      );
      const presentationReadyAtMs = monotonicNow();
      const prepared = Object.freeze({
        identity: presentationGenerationIdentity,
        generation,
        coverageEpoch: requestedEpoch,
        centerChunkX,
        centerChunkZ,
        activeDataKeys: Object.freeze(sortedKeyList(activeKeys)),
        renderedKeys: Object.freeze(sortedKeyList(rendered)),
        renderDistancePreset: renderDistancePolicy.id,
        geometryCount,
        uploadBytes,
        maximumSliceMs: localTerrainLastMaximumSliceMs,
        clipmapMetrics: Object.freeze({
          sampleCount: generation.stats.clipmapSampleCount,
          newlySampledCount: generation.stats.clipmapNewlySampledCount,
          reusedSampleCount: generation.stats.clipmapReusedSampleCount,
          reuseRatio: generation.stats.clipmapSampleReuseRatio,
          surfaceRefreshCount: generation.stats.clipmapSurfaceRefreshCount,
          sourceSlotReuseCount: generation.stats.clipmapSourceSlotReuseCount,
          cacheReuseCount: generation.stats.clipmapCacheReuseCount,
          vertexWriteCount: generation.stats.clipmapVertexWriteCount,
          vertexComponentWriteCount: generation.stats.clipmapVertexComponentWriteCount,
          dirtySlotCount: generation.stats.clipmapDirtySlotCount,
          updateRangeCount: generation.stats.clipmapUpdateRangeCount,
          bufferUploadBytes: generation.stats.clipmapBufferUploadBytes,
          geometryAllocationCount: generation.stats.clipmapGeometryAllocationCount,
          indexAllocationCount: generation.stats.clipmapIndexAllocationCount,
          buildDurationMs: generation.stats.clipmapBuildDurationMs,
        }),
        rollingMetrics: Object.freeze({
          publicationScope: 'entering-owner-strip-and-low-ring',
          fullTerrainRebuild: activeLocalTerrainGeneration !== null
            && generation.stats.midgroundReusedOwnerCount === 0
            && generation.stats.clipmapReusedSampleCount === 0,
          newOwnerCount: generation.stats.midgroundNewOwnerCount,
          reusedOwnerCount: generation.stats.midgroundReusedOwnerCount,
          discardedOwnerCount: generation.stats.midgroundDiscardedOwnerCount,
          newOwnerSampleCount: generation.stats.midgroundNewSampleCount,
          reusedOwnerSampleCount: generation.stats.midgroundReusedSampleCount,
          discardedOwnerSampleCount: generation.stats.midgroundDiscardedSampleCount,
          mediumGeometryAllocationCount: generation.stats.midgroundGeometryAllocationCount,
          mediumGeometryReuseCount: generation.stats.midgroundGeometryReuseCount,
          newLowSampleCount: generation.stats.clipmapNewlySampledCount,
          reusedLowSampleCount: generation.stats.clipmapReusedSampleCount,
        }),
        outerReadyAtMs,
        clipmapReadyAtMs,
        presentationReadyAtMs,
        preparedAtMs: presentationReadyAtMs,
      });
      preparedTerrainPresentationGenerations.set(presentationGenerationIdentity, prepared);
      terrainPresentationGenerationPrepareCount += 1;
      terrainPresentationGenerationMaximumStagedCount = Math.max(
        terrainPresentationGenerationMaximumStagedCount,
        preparedTerrainPresentationGenerations.size,
      );
      terrainPresentationGenerationMaximumGeometryCount = Math.max(
        terrainPresentationGenerationMaximumGeometryCount,
        geometryCount,
      );
      terrainPresentationGenerationMaximumUploadBytes = Math.max(
        terrainPresentationGenerationMaximumUploadBytes,
        uploadBytes,
      );
      terrainPresentationGenerationMaximumSliceMs = Math.max(
        terrainPresentationGenerationMaximumSliceMs,
        localTerrainLastMaximumSliceMs,
      );
      terrainPresentationGenerationMaximumResidentGeometryCount = Math.max(
        terrainPresentationGenerationMaximumResidentGeometryCount,
        (activeLocalTerrainGeneration?.ownedGeometries?.size ?? 0)
          + [...preparedTerrainPresentationGenerations.values()].reduce(
            (sum, value) => sum + value.geometryCount,
            0,
          ),
      );
      terrainPresentationGenerationMaximumResidentUploadBytes = Math.max(
        terrainPresentationGenerationMaximumResidentUploadBytes,
        [...(activeLocalTerrainGeneration?.root?.children ?? [])].reduce(
          (sum, mesh) => sum + estimateMeshUploadBytes(mesh),
          0,
        ) + [...preparedTerrainPresentationGenerations.values()].reduce(
          (sum, value) => sum + value.uploadBytes,
          0,
        ),
      );
      recordDiagnosticEvent('terrain-presentation-generation-ready', {
        identity: presentationGenerationIdentity,
        coverageEpoch: requestedEpoch,
        centerChunkX,
        centerChunkZ,
        rootId: generation.root.name,
        rootAttached: generation.root.parent === root,
        geometryCount,
        uploadBytes,
        maximumSliceMs: localTerrainLastMaximumSliceMs,
      });
      localTerrainLastSyncDurationMs = monotonicNow() - startedAt;
      return Object.freeze({
        committed: false,
        prepared: true,
        reused: false,
        coverageEpoch: requestedEpoch,
        reason: null,
        missingOwnerKeys: Object.freeze([]),
        activeRootId: previous?.root?.name ?? null,
        outerReadyAtMs: prepared.outerReadyAtMs,
        clipmapReadyAtMs: prepared.clipmapReadyAtMs,
        presentationReadyAtMs: prepared.presentationReadyAtMs,
        preparedAtMs: prepared.preparedAtMs,
        geometryCount: prepared.geometryCount,
        uploadBytes: prepared.uploadBytes,
        maximumSliceMs: prepared.maximumSliceMs,
        clipmapMetrics: prepared.clipmapMetrics,
        rollingMetrics: prepared.rollingMetrics,
        presentationGeneration: prepared,
      });
    }
    if (generation.reusedMidgroundGeometry) {
      previous?.ownedGeometries.delete(generation.reusedMidgroundGeometry);
      generation.ownedGeometries.add(generation.reusedMidgroundGeometry);
    }
    const swapStartedAt = monotonicNow();
    const publication = publishLocalTerrainGeneration(generation, previous);
    generation.stats.publicationScope = publication.publicationScope;
    activeLocalTerrainGeneration = generation;
    refreshMacroCoarseWorldPresentation(renderOrigin);
    recordDiagnosticEvent('terrain-replacement-attached', {
      coverageEpoch: requestedEpoch,
      transitionGeneration: acceptedTransition?.generation ?? null,
      rootId: generation.root.name,
      rootAttached: generation.root.parent === root,
      oldRootId: previous?.root?.name ?? null,
      oldRootAttached: previous?.root?.parent === root,
    });
    recordDiagnosticEvent('terrain-coverage-verified', {
      coverageEpoch: requestedEpoch,
      transitionGeneration: acceptedTransition?.generation ?? null,
      rootId: generation.root.name,
      rootAttached: generation.root.parent === root,
      reused: false,
      activeOwnerCount: activeKeys.size,
      renderedOwnerCount: rendered.size,
    });
    committedLocalTerrainEpoch = requestedEpoch;
    localTerrainCommitCount += 1;
    currentCanonicalSurfacePolicy = surfacePolicy;
    recordDiagnosticEvent('terrain-old-released', {
      coverageEpoch: requestedEpoch,
      transitionGeneration: acceptedTransition?.generation ?? null,
      newRootId: generation.root.name,
      newRootAttached: generation.root.parent === root,
      oldRootId: previous?.root?.name ?? null,
      oldRootAttached: previous?.root?.parent === root,
    });
    localTerrainLastRootSwapDurationMs = monotonicNow() - swapStartedAt;
    localTerrainLastSyncDurationMs = monotonicNow() - startedAt;
    return Object.freeze({
      committed: true,
      reused: false,
      coverageEpoch: requestedEpoch,
      reason: null,
      missingOwnerKeys: Object.freeze([]),
      activeRootId: generation.root.name,
    });
  };

  const snapshotRemoteHorizonAtmospheres = generation => {
    if (!generation) return Object.freeze({
      settlements: Object.freeze({}),
      buildings: Object.freeze({}),
    });
    const settlements = new Map();
    const buildings = new Map();
    for (const object of generation.canonicalObjects.values()) {
      if (!object.remoteHorizon) continue;
      const buildingDistanceMeters = Math.hypot(
        object.worldX - generation.playerX,
        object.worldZ - generation.playerZ,
      );
      const atmosphere = resolveW8RemoteSettlementAtmosphere({
        boundaryDistanceMeters: buildingDistanceMeters,
        quality: generation.quality,
        renderDistancePreset: generation.renderDistancePreset,
      });
      buildings.set(object.stableId, Object.freeze({
        settlementId: object.settlementId,
        distanceMeters: buildingDistanceMeters,
        worldX: object.worldX,
        worldZ: object.worldZ,
        visibleLod: object.visibleLod,
        presentationTier: object.presentationTier,
        ...atmosphere,
      }));
      if (!settlements.has(object.settlementId)) {
        const centerDistanceMeters = Math.hypot(
          object.settlementCenterX - generation.playerX,
          object.settlementCenterZ - generation.playerZ,
        );
        const boundaryDistanceMeters = Math.max(
          0,
          centerDistanceMeters - object.settlementRadiusMeters,
        );
        settlements.set(object.settlementId, Object.freeze({
          boundaryDistanceMeters,
          ...resolveW8RemoteSettlementAtmosphere({
            boundaryDistanceMeters,
            quality: generation.quality,
            renderDistancePreset: generation.renderDistancePreset,
          }),
        }));
      }
    }
    const sortedObject = values => Object.freeze(Object.fromEntries(
      [...values.entries()].sort(([left], [right]) => left.localeCompare(right)),
    ));
    return Object.freeze({
      settlements: sortedObject(settlements),
      buildings: sortedObject(buildings),
    });
  };
  const emptyRemoteHorizonAtmospheres = Object.freeze({
    settlements: Object.freeze({}),
    buildings: Object.freeze({}),
  });

  const snapshotSettlementSelections = generation => {
    if (!generation) return Object.freeze([]);
    const objectsBySettlement = new Map();
    for (const object of generation.canonicalObjects.values()) {
      if (!object.settlementId) continue;
      if (!objectsBySettlement.has(object.settlementId)) {
        objectsBySettlement.set(object.settlementId, []);
      }
      objectsBySettlement.get(object.settlementId).push(object);
    }
    return Object.freeze((generation.settlementSelections ?? []).map(selection => {
      const objects = objectsBySettlement.get(selection.settlementId) ?? [];
      const stableIdSuppressionCount = objects.filter(object => (
        generation.nearVisibleStableIds.has(object.stableId)
      )).length;
      const visibleInstanceCount = objects.reduce((sum, object) => {
        if (!['mid', 'far'].includes(object.visibleLod) || !object.presentationTier) return sum;
        return sum + object.instances.filter(instance => (
          canonicalInstanceOpacity(object, instance.item) > 0
        )).length;
      }, 0);
      return Object.freeze({
        ...selection,
        presentationStableIdCount: objects.length,
        stableIdSuppressionCount,
        registeredInstanceCount: objects.reduce((sum, object) => (
          sum + object.instances.length
        ), 0),
        visibleInstanceCount,
      });
    }));
  };

  const snapshotTreeRenderPaths = () => {
    const entries = new Map(Object.values(TREE_RENDER_PATH).map(pathId => [pathId, {
      pathId,
      rootNames: new Set(),
      meshes: [],
      ownerKeys: new Set(),
      stableIds: new Set(),
      instanceCount: 0,
      active: false,
      publicationSources: new Set(),
      planIds: new Set(),
      coverageGenerations: new Set(),
      matrixUpdateCount: 0,
      bufferUpdateCount: 0,
      visibilityChangeCount: 0,
      lastUpdateAtMs: null,
    }]));
    const collect = generation => {
      if (!generation) return;
      const persistent = generation.persistentTree === true;
      const publicationSource = persistent
        ? 'static-owner-page-ticket' : 'distant-atomic-root';
      for (const bucket of generation.canonicalBuckets?.values?.() ?? []) {
        const pathId = bucket.mesh?.userData?.treePathId
          ?? treePathIdForBucket(bucket, generation);
        if (!pathId) continue;
        const entry = entries.get(pathId);
        const stableIds = (bucket.mesh?.userData?.canonicalStableIds ?? [])
          .slice(0, bucket.mesh?.count ?? 0)
          .filter(stableId => typeof stableId === 'string');
        entry.rootNames.add(generation.root?.name ?? 'unknown');
        entry.instanceCount += bucket.mesh?.count ?? 0;
        entry.active ||= generation.root?.visible !== false
          && bucket.mesh?.visible !== false && (bucket.mesh?.count ?? 0) > 0;
        entry.publicationSources.add(publicationSource);
        if (persistentTreePlanId) entry.planIds.add(persistentTreePlanId);
        if (persistent) entry.coverageGenerations.add(persistentTreeCoverageGeneration);
        for (const stableId of stableIds) entry.stableIds.add(stableId);
        for (const object of bucket.items?.map?.(item => item.object) ?? []) {
          if (stableIds.includes(object.stableId)) entry.ownerKeys.add(object.ownerKey);
        }
        entry.meshes.push(Object.freeze({
          name: bucket.mesh?.name ?? null,
          materialName: bucket.mesh?.material?.name
            || bucket.mesh?.material?.type
            || bucket.mesh?.material?.constructor?.name
            || null,
          count: bucket.mesh?.count ?? 0,
          visible: generation.root?.visible !== false && bucket.mesh?.visible !== false,
          mode: bucket.mesh?.userData?.treePathMode ?? parseNaturalLodBucket(bucket)?.mode ?? null,
        }));
        entry.lastUpdateAtMs = Math.max(
          entry.lastUpdateAtMs ?? 0,
          generation.treeLastUpdateAtMs ?? 0,
        ) || null;
      }
      const primaryPathId = persistent ? TREE_RENDER_PATH.STATIC : TREE_RENDER_PATH.LEGACY;
      const primary = entries.get(primaryPathId);
      primary.matrixUpdateCount += persistent
        ? persistentTreeMatrixUpdateCount
        : generation.stats?.canonicalMatrixUpdateCount ?? 0;
      primary.bufferUpdateCount += persistent
        ? persistentTreeAttributeUpdateCount
        : generation.stats?.canonicalNeedsUpdateCount ?? 0;
      primary.visibilityChangeCount += generation.treeVisibilityChangeCount ?? 0;
    };
    collect(activeGeneration);
    collect(persistentTreeGeneration);
    return Object.freeze([...entries.values()].map(entry => {
      const state = treePathAuditState.get(entry.pathId);
      return Object.freeze({
        pathId: entry.pathId,
        rootNames: Object.freeze([...entry.rootNames]),
        rootCount: entry.rootNames.size,
        meshes: Object.freeze(entry.meshes),
        meshCount: entry.meshes.length,
        materialNames: Object.freeze([...new Set(entry.meshes
          .map(mesh => mesh.materialName).filter(Boolean))]),
        instanceCount: entry.instanceCount,
        ownerCount: entry.ownerKeys.size,
        stableIdCount: entry.stableIds.size,
        firstDrawAtMs: state?.firstDrawAtMs ?? null,
        lastUpdateAtMs: entry.lastUpdateAtMs,
        matrixUpdateCount: entry.matrixUpdateCount,
        bufferUpdateCount: entry.bufferUpdateCount,
        visibilityChangeCount: entry.visibilityChangeCount,
        disposeCount: state?.disposeCount ?? 0,
        active: entry.active,
        hidden: !entry.active,
        publicationSources: Object.freeze([...entry.publicationSources]),
        planIds: Object.freeze([...entry.planIds]),
        coverageGenerations: Object.freeze([...entry.coverageGenerations]),
      });
    }));
  };

  const snapshotTreeMaterials = () => {
    const source = ['treeLeaves', 'treeLeavesForest', 'treeLeavesMeadow']
      .filter(key => visualAssets.materials?.[key])
      .map(key => snapshotMaterial(`exact:${key}`, visualAssets.materials[key]));
    const generated = [];
    const seen = new Set();
    for (const [generationPath, generation] of [
      ['legacy-distant', activeGeneration],
      ['persistent-natural', persistentTreeGeneration],
    ]) {
      for (const material of generation?.naturalLodMaterials?.values?.() ?? []) {
        if (material?.userData?.naturalLodKind !== W8_VEGETATION_LOD_KINDS.TREE
          || seen.has(material)) continue;
        seen.add(material);
        generated.push(snapshotMaterial(
          `${generationPath}:${material.userData?.naturalLodMode ?? 'unknown'}`,
          material,
        ));
      }
    }
    return Object.freeze({
      schemaVersion: 'w8-tree-material-audit-1',
      source: Object.freeze(source),
      generated: Object.freeze(generated.sort((left, right) => (
        left.path.localeCompare(right.path)
      ))),
    });
  };

  const snapshotVisibleRootRevisions = () => Object.freeze([
    Object.freeze({
      role: 'distant',
      rootName: activeGeneration?.root?.name ?? null,
      attached: activeGeneration?.root?.parent === root,
      visible: activeGeneration?.root?.visible !== false,
      renderDistancePreset: activeGeneration?.renderDistancePreset ?? null,
      transitionGeneration: activeGeneration?.transitionContract?.generation ?? null,
      coverageSignature: activeGeneration?.transitionContract?.coverageSignature ?? null,
      publicationPlanId: settlementPublicationPlanId,
      publicationRevision: settlementPublicationRevision,
    }),
    Object.freeze({
      role: 'local-terrain',
      rootName: activeLocalTerrainGeneration?.root?.name ?? null,
      attached: activeLocalTerrainGeneration?.root?.parent === root,
      visible: activeLocalTerrainGeneration?.root?.visible !== false,
      renderDistancePreset: activeLocalTerrainGeneration?.renderDistancePreset ?? null,
      transitionGeneration:
        activeLocalTerrainGeneration?.transitionContract?.generation ?? null,
      coverageSignature:
        activeLocalTerrainGeneration?.transitionContract?.coverageSignature ?? null,
      coverageEpoch: committedLocalTerrainEpoch,
    }),
    Object.freeze({
      role: 'macro-coarse-world',
      rootName: macroCoarseWorldPresentation?.root?.name ?? null,
      attached: macroCoarseWorldPresentation?.root?.parent === root,
      visible: macroCoarseWorldPresentation?.root?.visible !== false,
      renderDistancePreset: null,
      coverageRevision: macroCoarseWorldController?.snapshot()?.coverageRevision ?? null,
      cellSizeMeters: MACRO_CELL_SIZE_METERS,
      readyCellCount: macroCoarseWorldController?.snapshot()?.presentedCellCount ?? 0,
    }),
    Object.freeze({
      role: 'persistent-natural',
      rootName: persistentTreeGeneration?.root?.name ?? null,
      attached: persistentTreeGeneration?.root?.parent === scene,
      visible: persistentTreeGeneration?.root?.visible !== false,
      renderDistancePreset: persistentTreeGeneration?.renderDistancePreset ?? null,
      planId: persistentTreePlanId,
      coverageGeneration: persistentTreeCoverageGeneration,
      planRevision: persistentTreePlanRevision,
    }),
    Object.freeze({
      role: 'prepared-distant',
      rootName: preparedRenderDistanceDistant?.generation?.root?.name ?? null,
      attached: preparedRenderDistanceDistant?.generation?.root?.parent === root,
      visible: preparedRenderDistanceDistant?.generation?.root?.visible !== false,
      renderDistancePreset:
        preparedRenderDistanceDistant?.generation?.renderDistancePreset ?? null,
      transitionGeneration:
        preparedRenderDistanceDistant?.generation?.transitionContract?.generation ?? null,
    }),
    Object.freeze({
      role: 'prepared-local-terrain',
      rootName: preparedRenderDistanceLocalTerrain?.generation?.root?.name ?? null,
      attached: preparedRenderDistanceLocalTerrain?.generation?.root?.parent === root,
      visible: preparedRenderDistanceLocalTerrain?.generation?.root?.visible !== false,
      renderDistancePreset:
        preparedRenderDistanceLocalTerrain?.generation?.renderDistancePreset ?? null,
      transitionGeneration:
        preparedRenderDistanceLocalTerrain?.generation?.transitionContract?.generation ?? null,
    }),
  ]);

  const snapshotPresenterAudit = () => {
    const visibleStableIds = generation => new Set([
      ...(generation?.canonicalObjects?.values?.() ?? []),
    ].filter(object => (
      !['hidden', 'destroyed'].includes(object.visibleLod)
      && object.presentationTier !== null
      && object.instances.some(instance => (
        instance.bucket?.mesh?.visible !== false
        && canonicalInstanceOpacity(object, instance.item) > 0
      ))
    )).map(object => object.stableId));
    const legacy = visibleStableIds(activeGeneration);
    const persistent = visibleStableIds(persistentTreeGeneration);
    const overlaps = [...persistent].filter(stableId => legacy.has(stableId)).sort();
    return Object.freeze({
      schemaVersion: 'w8-presenter-audit-1',
      legacyDistantVisibleStableIdCount: legacy.size,
      persistentNaturalVisibleStableIdCount: persistent.size,
      legacyDistantVisibleStableIds: Object.freeze([...legacy].sort()),
      persistentNaturalVisibleStableIds: Object.freeze([...persistent].sort()),
      duplicatePresenterCount: overlaps.length,
      duplicateStableIds: Object.freeze(overlaps),
      buildingPublicationSource,
      settlementRoadPublicationSource,
      settlementMetadataPublicationSource,
    });
  };

  const roadPointToSegmentDistance = (pointX, pointZ, start, end) => {
    const dx = Number(end?.x) - Number(start?.x);
    const dz = Number(end?.z) - Number(start?.z);
    const lengthSquared = dx * dx + dz * dz;
    if (!(lengthSquared > 0)) return Math.hypot(pointX - Number(start?.x), pointZ - Number(start?.z));
    const t = clamp(((pointX - Number(start?.x)) * dx + (pointZ - Number(start?.z)) * dz)
      / lengthSquared, 0, 1);
    return Math.hypot(
      pointX - (Number(start?.x) + dx * t),
      pointZ - (Number(start?.z) + dz * t),
    );
  };

  const snapshotRoadLifecycleDiagnostic = ({
    includeRecords = true,
    includeHistory = true,
  } = {}) => {
    const generation = activeGeneration;
    const roadVisibilityMeters = generation?.renderDistancePolicy
      ?.worldPresentationDistanceMeters ?? null;
    const playerX = Number(generation?.playerX ?? 0);
    const playerZ = Number(generation?.playerZ ?? 0);
    const latest = roadLifecycleHistory.at(-1) ?? null;
    const latestSnapshot = copyRoadLifecycle(latest);
    if (!roadLifecycleDiagnosticEnabled || !includeRecords) {
      return Object.freeze({
        schemaVersion: 'w8-road-lifecycle-diagnostic-1',
        enabled: roadLifecycleDiagnosticEnabled,
        player: Object.freeze({ x: playerX, z: playerZ }),
        roadVisibilityMeters,
        historyLimit: W8_ROAD_LIFECYCLE_DIAGNOSTIC_HISTORY_LIMIT,
        historyCount: roadLifecycleHistory.length,
        droppedHistoryCount: roadLifecycleDroppedHistoryCount,
        latest: latestSnapshot,
        history: includeHistory
          ? Object.freeze(roadLifecycleHistory.map(copyRoadLifecycle))
          : Object.freeze([]),
        registeredRoadRecordCount: null,
        drawableRoadRecordCount: null,
        midpointCullGapCandidateCount: null,
        hiddenWithinSegmentRangeCount: null,
        recordsTruncated: false,
        records: Object.freeze([]),
      });
    }
    const drawableStableIds = new Set(
      [...(generation?.canonicalBuckets?.values?.() ?? [])]
        .filter(isSettlementRoadBucket)
        .flatMap(bucket => bucket.mesh?.userData?.canonicalStableIds ?? [])
        .filter(Boolean),
    );
    const records = [...(generation?.canonicalObjects?.values?.() ?? [])]
      .filter(object => object.record?.featureType === 'settlement-road')
      .slice(0, W8_ROAD_LIFECYCLE_DIAGNOSTIC_RECORD_LIMIT)
      .map(object => {
        const midpointDistanceMeters = Math.hypot(object.worldX - playerX, object.worldZ - playerZ);
        const segmentDistanceMeters = roadPointToSegmentDistance(
          playerX,
          playerZ,
          object.record.start,
          object.record.end,
        );
        const drawable = drawableStableIds.has(object.stableId);
        return Object.freeze({
          stableId: object.stableId,
          ownerKey: object.ownerKey,
          settlementId: object.settlementId,
          midpointDistanceMeters,
          segmentDistanceMeters,
          visibleLod: object.visibleLod,
          presentationTier: object.presentationTier,
          farEligible: object.farEligible === true,
          drawable,
          midpointCullGapCandidate: roadVisibilityMeters !== null
            && segmentDistanceMeters <= roadVisibilityMeters
            && midpointDistanceMeters > roadVisibilityMeters,
        });
      });
    const gapCandidateCount = records.filter(record => record.midpointCullGapCandidate).length;
    const hiddenWithinSegmentRangeCount = records.filter(record => (
      roadVisibilityMeters !== null
        && record.segmentDistanceMeters <= roadVisibilityMeters
        && record.visibleLod === 'hidden'
    )).length;
    return Object.freeze({
      schemaVersion: 'w8-road-lifecycle-diagnostic-1',
      enabled: roadLifecycleDiagnosticEnabled,
      player: Object.freeze({ x: playerX, z: playerZ }),
      roadVisibilityMeters,
      historyLimit: W8_ROAD_LIFECYCLE_DIAGNOSTIC_HISTORY_LIMIT,
      historyCount: roadLifecycleHistory.length,
      droppedHistoryCount: roadLifecycleDroppedHistoryCount,
      latest: latestSnapshot,
      history: includeHistory
        ? Object.freeze(roadLifecycleHistory.map(copyRoadLifecycle))
        : Object.freeze([]),
      registeredRoadRecordCount: records.length,
      drawableRoadRecordCount: records.filter(record => record.drawable).length,
      midpointCullGapCandidateCount: gapCandidateCount,
      hiddenWithinSegmentRangeCount,
      recordsTruncated: [...(generation?.canonicalObjects?.values?.() ?? [])]
        .filter(object => object.record?.featureType === 'settlement-road').length > records.length,
      records: includeRecords ? Object.freeze(records) : Object.freeze([]),
    });
  };

  const snapshotRoadVisibilityDiagnostic = () => {
    const generation = activeGeneration;
    const roadObjects = [...(generation?.canonicalObjects?.values?.() ?? [])]
      .filter(object => object.record?.featureType === 'settlement-road');
    const roadBuckets = [...(generation?.canonicalBuckets?.values?.() ?? [])]
      .filter(isSettlementRoadBucket);
    const drawableStableIds = new Set(roadBuckets.flatMap(bucket => (
      bucket.mesh?.userData?.canonicalStableIds ?? []
    )).filter(Boolean));
    const distanceFor = object => Math.hypot(
      object.worldX - Number(generation?.playerX ?? 0),
      object.worldZ - Number(generation?.playerZ ?? 0),
    );
    const registeredDistances = roadObjects.map(distanceFor);
    const drawableObjects = roadObjects.filter(object => drawableStableIds.has(object.stableId));
    const drawableDistances = drawableObjects.map(distanceFor);
    const generalVisibilityMeters = generation?.renderDistancePolicy
      ?.generalDetailDistanceMeters ?? null;
    const roadVisibilityMeters = generation?.renderDistancePolicy
      ?.worldPresentationDistanceMeters ?? null;
    const firstMesh = roadBuckets.find(bucket => bucket.mesh)?.mesh ?? null;
    const material = Array.isArray(firstMesh?.material)
      ? firstMesh.material[0] ?? null : firstMesh?.material ?? null;
    const geometryDiagnostic = firstMesh?.geometry?.userData
      ?.roadVisibilityDiagnostic ?? null;
    const maximum = values => values.reduce((result, value) => (
      result === null ? value : Math.max(result, value)
    ), null);
    return Object.freeze({
      ...roadVisibilityDiagnostic,
      generalVisibilityMeters,
      roadVisibilityMeters,
      registeredRoadRecordCount: roadObjects.length,
      drawableRoadRecordCount: drawableObjects.length,
      drawableBeyondGeneralVisibilityCount: drawableObjects.filter(object => (
        generalVisibilityMeters !== null && distanceFor(object) > generalVisibilityMeters
      )).length,
      maximumRegisteredDistanceMeters: maximum(registeredDistances),
      maximumDrawableDistanceMeters: maximum(drawableDistances),
      roadMeshCount: roadBuckets.filter(bucket => bucket.mesh).length,
      roadTriangleCount: roadBuckets.reduce((total, bucket) => (
        total + Number(bucket.mesh?.geometry?.userData?.roadRibbon?.triangleCount ?? 0)
      ), 0),
      geometry: geometryDiagnostic,
      material: Object.freeze({
        name: material?.name ?? null,
        type: material?.type ?? material?.constructor?.name ?? null,
        colorHex: typeof material?.color?.getHex === 'function'
          ? material.color.getHex() : null,
        fog: material?.fog ?? null,
        toneMapped: material?.toneMapped ?? null,
        depthTest: material?.depthTest ?? null,
        depthWrite: material?.depthWrite ?? null,
        polygonOffset: material?.polygonOffset ?? null,
      }),
    });
  };

  const snapshotOriginTransforms = ({ slotLimit = 48 } = {}) => {
    const visibleDistantGeneration = persistentDistantPublishedGeneration ?? activeGeneration;
    const clipmap = activeLocalTerrainGeneration?.root?.children?.find(child => (
      child.name === 'w8-seeded-macro-terrain-clipmap'
    )) ?? null;
    const buildingSlots = [];
    for (const bucket of visibleDistantGeneration?.canonicalBuckets?.values?.() ?? []) {
      if (!bucket.persistent || !bucket.name?.includes('building') || !bucket.mesh) continue;
      for (let slot = 0; slot < bucket.items.length && buildingSlots.length < slotLimit; slot += 1) {
        const item = bucket.items[slot];
        if (!item) continue;
        buildingSlots.push(Object.freeze({
          ownerKey: item.object.ownerKey,
          stableId: item.object.stableId,
          slotIndex: slot,
          materialBucket: bucket.key,
          visibleStableId: bucket.mesh.userData?.canonicalStableIds?.[slot] ?? null,
          matrixUploadRevision: bucket.mesh.instanceMatrix?.version ?? null,
          handoffOpacity: localHandoffOpacityValues(bucket)?.[slot] ?? null,
          handoffOpacityUploadRevision: bucket.localHandoffOpacityAttribute?.version ?? null,
          matrixDirty: bucket.dirtySlots?.has(slot) ?? false,
        }));
      }
      if (buildingSlots.length >= slotLimit) break;
    }
    const localTerrain = generationTransformSnapshot('distant-local-terrain', activeLocalTerrainGeneration);
    const macroPresentationSnapshot = macroCoarseWorldPresentation?.snapshot() ?? null;
    const macroExpectedRootX = macroPresentationSnapshot && committedRenderOrigin
      ? (macroPresentationSnapshot.anchorWorldX
        - committedRenderOrigin.renderOriginChunkX * LOGICAL_CHUNK_SIZE_METERS)
        * UNITS_PER_METER : null;
    const macroExpectedRootZ = macroPresentationSnapshot && committedRenderOrigin
      ? (macroPresentationSnapshot.anchorWorldZ
        - committedRenderOrigin.renderOriginChunkZ * LOGICAL_CHUNK_SIZE_METERS)
        * UNITS_PER_METER : null;
    const macroRootX = Number(macroCoarseWorldPresentation?.root?.position?.x ?? 0);
    const macroRootZ = Number(macroCoarseWorldPresentation?.root?.position?.z ?? 0);
    return Object.freeze({
      schemaVersion: 'w8-origin-transform-audit-1',
      committedRenderOrigin,
      roots: Object.freeze([
        Object.freeze({
          role: 'distant-container',
          rootIdentity: root.name,
          renderOriginRevision: committedRenderOrigin?.rebaseCount ?? null,
          rootPosition: transformVectorSnapshot(root.position),
          matrixWorldTranslation: matrixWorldTranslationSnapshot(root),
          rebaseAppliedBy: 'scene-owned-fixed-container',
          staleRevisionGuard: 'acceptCommittedRenderOrigin',
          attached: root.parent === scene,
          visible: root.visible !== false,
          originAligned: Number(root.position?.x ?? 0) === 0
            && Number(root.position?.y ?? 0) === 0
            && Number(root.position?.z ?? 0) === 0,
        }),
        localTerrain,
        Object.freeze({
          role: 'macro-coarse-world',
          rootIdentity: macroCoarseWorldPresentation?.root?.name ?? null,
          logicalOwner: macroCoarseWorldController?.snapshot()?.center?.key ?? null,
          renderOriginRevision: committedRenderOrigin?.rebaseCount ?? null,
          rootPosition: transformVectorSnapshot(macroCoarseWorldPresentation?.root?.position),
          matrixWorldTranslation: macroCoarseWorldPresentation?.root
            ? matrixWorldTranslationSnapshot(macroCoarseWorldPresentation.root) : null,
          rebaseAppliedBy: 'macro-coarse-world-presentation-rebase',
          staleRevisionGuard: 'acceptCommittedRenderOrigin',
          attached: macroCoarseWorldPresentation?.root?.parent === root,
          visible: macroCoarseWorldPresentation?.root?.visible !== false,
          drawnOwnerCount: macroCoarseWorldController?.snapshot()?.presentedCellCount ?? 0,
          originAligned: macroPresentationSnapshot === null || (
            Math.abs(macroRootX - macroExpectedRootX) <= 0.000001
            && Math.abs(macroRootZ - macroExpectedRootZ) <= 0.000001
          ),
        }),
        Object.freeze({
          role: 'clipmap',
          rootIdentity: clipmap?.name ?? null,
          logicalOwner: localTerrain.logicalOwner ?? null,
          transitionGeneration: localTerrain.transitionGeneration ?? null,
          renderOriginRevision: localTerrain.renderOriginRevision ?? null,
          rootPosition: transformVectorSnapshot(clipmap?.position),
          matrixWorldTranslation: clipmap ? matrixWorldTranslationSnapshot(clipmap) : null,
          rebaseAppliedBy: 'distant-local-terrain-parent',
          rebaseAppliedAtMs: localTerrain.rebaseAppliedAtMs ?? null,
          staleRevisionGuard: 'acceptCommittedRenderOrigin + transitionIsCurrent',
          attached: Boolean(clipmap?.parent === activeLocalTerrainGeneration?.root),
          visible: clipmap?.visible !== false,
          drawnOwnerCount: localTerrain.drawnOwnerCount ?? 0,
          originAligned: localTerrain.originAligned === true,
        }),
        generationTransformSnapshot('distant-building-and-legacy', visibleDistantGeneration),
        generationTransformSnapshot(
          'persistent-natural',
          persistentTreeGeneration,
          { attachedTo: scene },
        ),
      ]),
      buildingSlots: Object.freeze(buildingSlots),
      buildingSlotCount: [...(visibleDistantGeneration?.canonicalBuckets?.values?.() ?? [])]
        .filter(bucket => bucket.persistent && bucket.name?.includes('building'))
        .reduce((sum, bucket) => sum + bucket.items.filter(Boolean).length, 0),
      buildingSlotSnapshotTruncated: buildingSlots.length >= slotLimit,
    });
  };

  return Object.freeze({
    syncLocalTerrainIncrementally,
    pumpTerrainPresentationScheduler() {
      return terrainScheduler.pumpFrame();
    },
    terrainPresentationSchedulerSnapshot() {
      return terrainScheduler.snapshot();
    },
    resetTerrainPresentationSchedulerDiagnostics() {
      terrainScheduler.resetDiagnostics?.();
      presentationSchedulerNaturalSlices = 0;
      presentationSchedulerRoadSlices = 0;
      return true;
    },
    resetContinuousTerrainDiagnostics() {
      continuousTerrainCoverageMiss = 0;
      continuousTerrainCoverageComplete = false;
      visibleTerrainHoleFrame = 0;
      return true;
    },
    sampleTerrainFallbackHeightMeters(worldX, worldZ) {
      if (!Number.isFinite(worldX) || !Number.isFinite(worldZ)) return null;
      const sample = baseClipmapSample(
        worldX,
        worldZ,
        activeLocalTerrainGeneration?.surfacePolicy ?? currentCanonicalSurfacePolicy,
      );
      return Number.isFinite(sample?.height) ? sample.height : null;
    },
    terrainPresentationCoverageForOwner(chunkX, chunkZ) {
      if (!Number.isSafeInteger(chunkX) || !Number.isSafeInteger(chunkZ)) {
        return Object.freeze({ complete: false, worldCoverageComplete: false,
          fallback: true, lagChunks: null,
          generationAgeMs: null, centerChunkX: null, centerChunkZ: null });
      }
      const generation = activeLocalTerrainGeneration;
      const complete = Boolean(generation?.root?.parent === root
        && generation.root.children?.some(child => (
          child.name === 'w8-midground-outer-sixteen-terrain'
        ))
        && generation.root.children?.some(child => (
          child.name === 'w8-seeded-macro-terrain-clipmap'
        )));
      const lagChunks = generation ? Math.max(
        Math.abs(chunkX - generation.centerChunkX),
        Math.abs(chunkZ - generation.centerChunkZ),
      ) : null;
      const clipmapExtentMeters = generation?.renderDistancePolicy?.terrainCoverageDistanceMeters
        ?? null;
      const generationCenterWorldX = generation
        ? (generation.centerChunkX + 0.5) * LOGICAL_CHUNK_SIZE_METERS : null;
      const generationCenterWorldZ = generation
        ? (generation.centerChunkZ + 0.5) * LOGICAL_CHUNK_SIZE_METERS : null;
      const requiredCenterWorldX = (chunkX + 0.5) * LOGICAL_CHUNK_SIZE_METERS;
      const requiredCenterWorldZ = (chunkZ + 0.5) * LOGICAL_CHUNK_SIZE_METERS;
      const requiredHalfExtentMeters = LOGICAL_CHUNK_SIZE_METERS * 0.5;
      const distanceXMeters = generation
        ? Math.abs(requiredCenterWorldX - generationCenterWorldX) : null;
      const distanceZMeters = generation
        ? Math.abs(requiredCenterWorldZ - generationCenterWorldZ) : null;
      const withinNearOuterCoverage = complete && distanceXMeters + requiredHalfExtentMeters
        <= FIVE_BY_FIVE_HALF_EXTENT_METERS
        && distanceZMeters + requiredHalfExtentMeters <= FIVE_BY_FIVE_HALF_EXTENT_METERS;
      const withinClipmapExtent = complete && Number.isFinite(clipmapExtentMeters)
        && distanceXMeters + requiredHalfExtentMeters <= clipmapExtentMeters
        && distanceZMeters + requiredHalfExtentMeters <= clipmapExtentMeters;
      const requiredVisibleHalfExtentMeters = generation?.renderDistancePolicy?.worldPresentationDistanceMeters
        ?? null;
      const withinCameraVisibleExtent = complete
        && Number.isFinite(clipmapExtentMeters)
        && Number.isFinite(requiredVisibleHalfExtentMeters)
        && distanceXMeters + requiredVisibleHalfExtentMeters <= clipmapExtentMeters
        && distanceZMeters + requiredVisibleHalfExtentMeters <= clipmapExtentMeters;
      const worldCoverageComplete = complete && withinCameraVisibleExtent;
      const coverageDeficitMeters = complete && Number.isFinite(clipmapExtentMeters)
        && Number.isFinite(requiredVisibleHalfExtentMeters)
        ? Math.max(
          0,
          distanceXMeters + requiredVisibleHalfExtentMeters - clipmapExtentMeters,
          distanceZMeters + requiredVisibleHalfExtentMeters - clipmapExtentMeters,
        ) : null;
      const activatedAtMs = generation?.activatedAtMs ?? generation?.createdAtMs ?? null;
      return Object.freeze({
        complete,
        worldCoverageComplete,
        // A lagging center is still the same continuous world-fixed surface
        // while it covers the visible domain; only an actual coverage deficit
        // is a presentation fallback.
        fallback: !worldCoverageComplete,
        lagChunks,
        generationAgeMs: activatedAtMs === null
          ? null : Math.max(0, monotonicNow() - activatedAtMs),
        centerChunkX: generation?.centerChunkX ?? null,
        centerChunkZ: generation?.centerChunkZ ?? null,
        requiredChunkX: chunkX,
        requiredChunkZ: chunkZ,
        clipmapExtentMeters,
        nearOuterCoverageHalfExtentMeters: FIVE_BY_FIVE_HALF_EXTENT_METERS,
        requiredHalfExtentMeters,
        requiredVisibleHalfExtentMeters,
        distanceXMeters,
        distanceZMeters,
        withinNearOuterCoverage,
        withinClipmapExtent,
        withinCameraVisibleExtent,
        coverageDeficitMeters,
      });
    },
    prepareTerrainPresentationGeneration(options = {}) {
      return syncLocalTerrainIncrementally({
        ...options,
        transitionContract: null,
        deferPublication: true,
      });
    },
    claimTerrainPresentationGeneration({
      presentationGeneration,
      transitionContract,
      activeDataKeys,
      renderedKeys,
      renderOrigin,
      centerChunkX,
      centerChunkZ,
      renderDistancePreset = W8_DEFAULT_RENDER_DISTANCE_PRESET,
    } = {}) {
      if (disposed) return Object.freeze({ claimed: false, reason: 'disposed' });
      const identity = presentationGeneration?.identity;
      const prepared = typeof identity === 'string'
        ? preparedTerrainPresentationGenerations.get(identity) : null;
      if (!prepared || prepared !== presentationGeneration) {
        terrainPresentationGenerationStalePublishCount += 1;
        return Object.freeze({ claimed: false, reason: 'missing-prepared-generation' });
      }
      const acceptedTransition = validateTransitionCoverage(transitionContract, {
        activeDataKeys,
        renderedKeys,
        centerChunkX,
        centerChunkZ,
      });
      const requestedPreset = normalizeW8RenderDistancePreset(renderDistancePreset);
      const activeKeySet = new Set(activeDataKeys ?? []);
      const renderedKeySet = new Set(renderedKeys ?? []);
      if (prepared.centerChunkX !== centerChunkX || prepared.centerChunkZ !== centerChunkZ
        || prepared.renderDistancePreset !== requestedPreset
        || !equalKeySets(prepared.generation.activeKeys, activeKeySet)
        || !equalKeySets(prepared.generation.renderedKeys, renderedKeySet)) {
        terrainPresentationGenerationStalePublishCount += 1;
        return Object.freeze({ claimed: false, reason: 'coverage-identity-mismatch' });
      }
      if (!acceptRuntimeTransitionContract(acceptedTransition)) {
        terrainPresentationGenerationStalePublishCount += 1;
        return Object.freeze({ claimed: false, reason: 'stale-transition' });
      }
      const generation = prepared.generation;
      const previous = activeLocalTerrainGeneration;
      const claimedCoverageEpoch = Math.max(
        prepared.coverageEpoch,
        committedLocalTerrainEpoch + 1,
        localTerrainSyncEpoch + 1,
      );
      generation.epoch = claimedCoverageEpoch;
      generation.root.userData.coverageEpoch = claimedCoverageEpoch;
      assignTransitionContract(generation, acceptedTransition);
      applyLocalTerrainOwnerHandoff(generation, activeDataKeys, renderedKeys);
      positionGenerationForOrigin(generation, renderOrigin);
      terrainPresentationGenerationMaximumOldNewOverlapGeometryCount = Math.max(
        terrainPresentationGenerationMaximumOldNewOverlapGeometryCount,
        (previous?.ownedGeometries?.size ?? 0) + generation.ownedGeometries.size,
      );
      terrainPresentationGenerationMaximumResidentGeometryCount = Math.max(
        terrainPresentationGenerationMaximumResidentGeometryCount,
        (previous?.ownedGeometries?.size ?? 0)
          + [...preparedTerrainPresentationGenerations.values()].reduce(
            (sum, value) => sum + value.geometryCount,
            0,
          ),
      );
      terrainPresentationGenerationMaximumResidentUploadBytes = Math.max(
        terrainPresentationGenerationMaximumResidentUploadBytes,
        [...(previous?.root?.children ?? [])].reduce(
          (sum, mesh) => sum + estimateMeshUploadBytes(mesh),
          0,
        ) + [...preparedTerrainPresentationGenerations.values()].reduce(
          (sum, value) => sum + value.uploadBytes,
          0,
        ),
      );
      const swapStartedAt = monotonicNow();
      const publication = publishLocalTerrainGeneration(generation, previous);
      generation.stats.publicationScope = publication.publicationScope;
      activeLocalTerrainGeneration = generation;
      refreshMacroCoarseWorldPresentation(renderOrigin);
      localTerrainSyncEpoch = claimedCoverageEpoch;
      committedLocalTerrainEpoch = claimedCoverageEpoch;
      localTerrainLastRequestedEpoch = claimedCoverageEpoch;
      localTerrainCommitCount += 1;
      currentCanonicalSurfacePolicy = generation.surfacePolicy;
      preparedTerrainPresentationGenerations.delete(identity);
      localTerrainLastRootSwapDurationMs = monotonicNow() - swapStartedAt;
      terrainPresentationGenerationClaimCount += 1;
      recordDiagnosticEvent('terrain-presentation-generation-claimed', {
        identity,
        coverageEpoch: claimedCoverageEpoch,
        transitionGeneration: acceptedTransition?.generation ?? null,
        centerChunkX,
        centerChunkZ,
        rootId: generation.root.name,
        rootAttached: generation.root.parent === root,
        oldRootId: previous?.root?.name ?? null,
        oldRootAttached: previous?.root?.parent === root,
      });
      return Object.freeze({
        claimed: true,
        identity,
        coverageEpoch: claimedCoverageEpoch,
        rootId: generation.root.name,
        oldRootId: previous?.root?.name ?? null,
        geometryCount: prepared.geometryCount,
        uploadBytes: prepared.uploadBytes,
      });
    },
    discardTerrainPresentationGeneration(presentationGeneration) {
      const identity = typeof presentationGeneration === 'string'
        ? presentationGeneration : presentationGeneration?.identity;
      if (typeof identity !== 'string') return false;
      const prepared = preparedTerrainPresentationGenerations.get(identity);
      if (!prepared || (typeof presentationGeneration === 'object'
        && presentationGeneration !== prepared)) return false;
      preparedTerrainPresentationGenerations.delete(identity);
      disposeGeneration(prepared.generation);
      terrainPresentationGenerationDiscardCount += 1;
      recordDiagnosticEvent('terrain-presentation-generation-discarded', {
        identity,
        coverageEpoch: prepared.coverageEpoch,
        centerChunkX: prepared.centerChunkX,
        centerChunkZ: prepared.centerChunkZ,
      });
      return true;
    },
    syncLocalTerrain({
      coverageEpoch,
      transitionContract = null,
      activeDataKeys,
      renderedKeys,
      getChunkData,
      renderOrigin,
      centerChunkX,
      centerChunkZ,
      renderDistancePreset = W8_DEFAULT_RENDER_DISTANCE_PRESET,
    } = {}) {
      const localSyncStartedAt = globalThis.performance?.now?.() ?? Date.now();
      localTerrainLastRootSwapDurationMs = 0;
      localTerrainLastMaximumSliceMs = 0;
      localTerrainLastSliceCount = 0;
      const requestedEpoch = Number(coverageEpoch);
      if (!Number.isSafeInteger(requestedEpoch) || requestedEpoch < 1) {
        throw new TypeError('coverageEpoch must be a positive safe integer');
      }
      if (!Array.isArray(activeDataKeys) || !Array.isArray(renderedKeys)
        || typeof getChunkData !== 'function') {
        throw new TypeError('Local terrain sync requires active/rendered keys and a ChunkData provider');
      }
      const acceptedTransition = validateTransitionCoverage(transitionContract, {
        activeDataKeys,
        renderedKeys,
        centerChunkX,
        centerChunkZ,
      });
      localTerrainLastRequestedEpoch = requestedEpoch;
      localTerrainLastActiveKeyCount = activeDataKeys.length;
      localTerrainLastRenderedKeyCount = renderedKeys.length;
      localTerrainLastResolvedChunkCount = 0;
      localTerrainLastMidgroundOwnerCount = 0;
      localTerrainLastMissingOwnerKeys = Object.freeze([]);
      localTerrainLastRejectionReason = null;

      const reject = (reason, missingOwnerKeys = []) => {
        localTerrainRejectionCount += 1;
        localTerrainLastRejectionReason = reason;
        localTerrainLastMissingOwnerKeys = Object.freeze(sortedKeyList(missingOwnerKeys));
        localTerrainLastSyncDurationMs = (globalThis.performance?.now?.() ?? Date.now())
          - localSyncStartedAt;
        return Object.freeze({
          committed: false,
          reused: false,
          coverageEpoch: requestedEpoch,
          reason,
          missingOwnerKeys: localTerrainLastMissingOwnerKeys,
          activeRootId: activeLocalTerrainGeneration?.root?.name ?? null,
        });
      };

      if (disposed) return reject('disposed');
      if (!acceptCommittedRenderOrigin(renderOrigin)) {
        localTerrainStaleDiscardCount += 1;
        return reject('stale-render-origin');
      }
      if (requestedEpoch < localTerrainSyncEpoch) {
        localTerrainStaleDiscardCount += 1;
        return reject('stale-epoch');
      }
      const renderDistancePolicy = resolveW8RenderDistancePolicy(renderDistancePreset);

      const activeKeys = new Set(activeDataKeys);
      const rendered = new Set(renderedKeys);
      if (activeDataKeys.length !== 25 || activeKeys.size !== 25) {
        return reject('active-key-count');
      }
      if (renderedKeys.length !== 9 || rendered.size !== 9) {
        return reject('rendered-key-count');
      }
      const renderedOutsideActive = [...rendered].filter(key => !activeKeys.has(key));
      if (renderedOutsideActive.length) return reject('rendered-owner-outside-active', renderedOutsideActive);
      if (!acceptRuntimeTransitionContract(acceptedTransition)) {
        localTerrainStaleDiscardCount += 1;
        return reject('stale-transition');
      }
      localTerrainSyncEpoch = requestedEpoch;

      const activeChunks = new Map();
      const missingOwnerKeys = [];
      for (const key of activeDataKeys) {
        const [chunkX, chunkZ] = key.split(',').map(Number);
        const chunk = getChunkData(chunkX, chunkZ);
        if (!chunk || chunk.chunkX !== chunkX || chunk.chunkZ !== chunkZ) {
          missingOwnerKeys.push(key);
          continue;
        }
        activeChunks.set(key, chunk);
      }
      currentCanonicalSurfacePolicy = surfacePolicyForChunks(activeChunks.values());
      currentCanonicalSurfacePolicy = Object.freeze({
        ...currentCanonicalSurfacePolicy,
        riverCorridors: Object.freeze(riverSurfaceCorridorsForClipmap(
          centerChunkX,
          centerChunkZ,
          currentCanonicalSurfacePolicy,
          renderDistancePolicy.terrainCoverageDistanceMeters,
        )),
      });
      localTerrainLastResolvedChunkCount = activeChunks.size;
      if (missingOwnerKeys.length) return reject('missing-chunk-data', missingOwnerKeys);

      const midgroundOwnerKeys = new Set([...activeKeys].filter(key => !rendered.has(key)));
      localTerrainLastMidgroundOwnerCount = midgroundOwnerKeys.size;
      if (midgroundOwnerKeys.size !== 16) return reject('midground-owner-count');

      const reusableMidgroundMesh = activeLocalTerrainGeneration
        && activeLocalTerrainGeneration.centerChunkX === centerChunkX
        && activeLocalTerrainGeneration.centerChunkZ === centerChunkZ
        && equalKeySets(activeLocalTerrainGeneration.activeKeys, activeKeys)
        && equalKeySets(activeLocalTerrainGeneration.renderedKeys, rendered)
        ? activeLocalTerrainGeneration.root.children?.find(child => (
          child.name === 'w8-midground-outer-sixteen-terrain'
        )) ?? null
        : null;

      if (activeLocalTerrainGeneration
        && activeLocalTerrainGeneration.centerChunkX === centerChunkX
        && activeLocalTerrainGeneration.centerChunkZ === centerChunkZ
        && activeLocalTerrainGeneration.renderDistancePreset === renderDistancePolicy.id
        && equalKeySets(activeLocalTerrainGeneration.activeKeys, activeKeys)
        && equalKeySets(activeLocalTerrainGeneration.renderedKeys, rendered)) {
        positionGenerationForOrigin(activeLocalTerrainGeneration, renderOrigin);
        applyLocalTerrainOwnerHandoff(
          activeLocalTerrainGeneration,
          activeDataKeys,
          renderedKeys,
        );
        assignTransitionContract(activeLocalTerrainGeneration, acceptedTransition);
        committedLocalTerrainEpoch = requestedEpoch;
        localTerrainLastSyncDurationMs = (globalThis.performance?.now?.() ?? Date.now())
          - localSyncStartedAt;
        return Object.freeze({
          committed: true,
          reused: true,
          coverageEpoch: requestedEpoch,
          reason: null,
          missingOwnerKeys: Object.freeze([]),
          activeRootId: activeLocalTerrainGeneration.root.name,
        });
      }

      const localRoot = new Group();
      localRoot.name = `w8-local-terrain-coverage-epoch-${requestedEpoch}`;
      localRoot.userData = {
        presentationOnly: true,
        localTerrainCoverage: true,
        coverageEpoch: requestedEpoch,
        renderDistancePreset: renderDistancePolicy.id,
      };
      stagingLocalTerrainRootId = localRoot.name;
      const generation = {
        epoch: requestedEpoch,
        root: localRoot,
        ownedGeometries: new Set(),
        ownedMaterials: new Set(),
        stats: createStats(),
        activeKeys,
        renderedKeys: rendered,
        midgroundOwnerKeys,
        centerChunkX,
        centerChunkZ,
        renderDistancePreset: renderDistancePolicy.id,
        renderDistancePolicy,
        buildOriginChunkX: renderOrigin.renderOriginChunkX,
        buildOriginChunkZ: renderOrigin.renderOriginChunkZ,
        currentOriginChunkX: renderOrigin.renderOriginChunkX,
        currentOriginChunkZ: renderOrigin.renderOriginChunkZ,
        surfacePolicy: currentCanonicalSurfacePolicy,
      };
      assignTransitionContract(generation, acceptedTransition);
      const midground = [...midgroundOwnerKeys]
        .map(key => activeChunks.get(key))
        .sort((left, right) => left.chunkZ - right.chunkZ || left.chunkX - right.chunkX);
      const terrainOwners = [...activeKeys]
        .map(key => activeChunks.get(key))
        .sort((left, right) => left.chunkZ - right.chunkZ || left.chunkX - right.chunkX);
      const context = {
        target: localRoot,
        ownedGeometries: generation.ownedGeometries,
        stats: generation.stats,
        generation,
        surfacePolicy: generation.surfacePolicy,
      };
      try {
        context.stats.midgroundChunkCount = midground.length;
        if (reusableMidgroundMesh) {
          const midgroundMesh = new Mesh(
            reusableMidgroundMesh.geometry,
            reusableMidgroundMesh.material,
          );
          midgroundMesh.name = reusableMidgroundMesh.name;
          midgroundMesh.castShadow = reusableMidgroundMesh.castShadow;
          midgroundMesh.receiveShadow = reusableMidgroundMesh.receiveShadow;
          midgroundMesh.userData = { ...(reusableMidgroundMesh.userData ?? {}) };
          localRoot.add(midgroundMesh);
          generation.localTerrainMesh = midgroundMesh;
          generation.currentVisibleMidgroundOwnerKeys = new Set(
            midgroundMesh.userData.visibleOwnerKeys ?? [],
          );
          generation.reusedMidgroundGeometry = reusableMidgroundMesh.geometry;
        } else {
          measure(
            'distant-midground-terrain',
            () => createMidgroundTerrain(terrainOwners, renderOrigin, context),
          );
        }
        measure('distant-clipmap', () => createClipmap({
          centerChunkX,
          centerChunkZ,
          activeChunks,
          origin: renderOrigin,
          renderDistancePreset: renderDistancePolicy.id,
          surfacePolicy: generation.surfacePolicy,
          stats: generation.stats,
          target: localRoot,
          ownedGeometries: generation.ownedGeometries,
          generation,
        }));
        applyLocalTerrainOwnerHandoff(generation, activeDataKeys, renderedKeys);
        positionGenerationForOrigin(generation, renderOrigin);
      } catch (error) {
        disposeGeneration(generation);
        localTerrainRejectionCount += 1;
        localTerrainLastRejectionReason = 'build-error';
        localTerrainLastSyncDurationMs = (globalThis.performance?.now?.() ?? Date.now())
          - localSyncStartedAt;
        throw error;
      } finally {
        stagingLocalTerrainRootId = null;
      }
      if (disposed || requestedEpoch !== localTerrainSyncEpoch
        || !transitionIsCurrent(acceptedTransition)) {
        disposeGeneration(generation);
        localTerrainStaleDiscardCount += 1;
        return reject(disposed ? 'disposed-during-build' : 'stale-after-build');
      }
      const previous = activeLocalTerrainGeneration;
      if (generation.reusedMidgroundGeometry) {
        previous?.ownedGeometries.delete(generation.reusedMidgroundGeometry);
        generation.ownedGeometries.add(generation.reusedMidgroundGeometry);
      }
      const localRootSwapStartedAt = globalThis.performance?.now?.() ?? Date.now();
      const publication = publishLocalTerrainGeneration(generation, previous);
      generation.stats.publicationScope = publication.publicationScope;
      activeLocalTerrainGeneration = generation;
      refreshMacroCoarseWorldPresentation(renderOrigin);
      committedLocalTerrainEpoch = requestedEpoch;
      localTerrainCommitCount += 1;
      localTerrainLastRootSwapDurationMs = (globalThis.performance?.now?.() ?? Date.now())
        - localRootSwapStartedAt;
      localTerrainLastSyncDurationMs = (globalThis.performance?.now?.() ?? Date.now())
        - localSyncStartedAt;
      return Object.freeze({
        committed: true,
        reused: false,
        coverageEpoch: requestedEpoch,
        reason: null,
        missingOwnerKeys: Object.freeze([]),
        activeRootId: generation.root.name,
      });
    },
    async syncLocalTerrainPreset({
      coverageEpoch,
      transitionContract = null,
      activeDataKeys,
      renderedKeys,
      getChunkData,
      renderOrigin,
      centerChunkX,
      centerChunkZ,
      renderDistancePreset = W8_DEFAULT_RENDER_DISTANCE_PRESET,
      deferPublication = false,
    } = {}) {
      const startedAt = globalThis.performance?.now?.() ?? Date.now();
      localTerrainLastRootSwapDurationMs = 0;
      localTerrainLastMaximumSliceMs = 0;
      localTerrainLastSliceCount = 0;
      const requestedEpoch = Number(coverageEpoch);
      const reject = (reason, missingOwnerKeys = []) => {
        localTerrainRejectionCount += 1;
        localTerrainLastRejectionReason = reason;
        localTerrainLastMissingOwnerKeys = Object.freeze(sortedKeyList(missingOwnerKeys));
        localTerrainLastSyncDurationMs = (globalThis.performance?.now?.() ?? Date.now()) - startedAt;
        return Object.freeze({
          committed: false,
          reused: false,
          coverageEpoch: requestedEpoch,
          reason,
          missingOwnerKeys: localTerrainLastMissingOwnerKeys,
          activeRootId: activeLocalTerrainGeneration?.root?.name ?? null,
        });
      };
      if (!Number.isSafeInteger(requestedEpoch) || requestedEpoch < 1) {
        throw new TypeError('coverageEpoch must be a positive safe integer');
      }
      if (!Array.isArray(activeDataKeys) || !Array.isArray(renderedKeys)
        || typeof getChunkData !== 'function') {
        throw new TypeError('Local terrain preset sync requires active/rendered keys and ChunkData');
      }
      const acceptedTransition = validateTransitionCoverage(transitionContract, {
        activeDataKeys,
        renderedKeys,
        centerChunkX,
        centerChunkZ,
      });
      localTerrainLastRequestedEpoch = requestedEpoch;
      localTerrainLastActiveKeyCount = activeDataKeys.length;
      localTerrainLastRenderedKeyCount = renderedKeys.length;
      localTerrainLastResolvedChunkCount = 0;
      localTerrainLastMidgroundOwnerCount = 0;
      localTerrainLastMissingOwnerKeys = Object.freeze([]);
      localTerrainLastRejectionReason = null;
      if (disposed) return reject('disposed');
      if (!acceptCommittedRenderOrigin(renderOrigin)) return reject('stale-render-origin');
      if (requestedEpoch < localTerrainSyncEpoch) return reject('stale-epoch');
      const renderDistancePolicy = resolveW8RenderDistancePolicy(renderDistancePreset);
      const activeKeys = new Set(activeDataKeys);
      const rendered = new Set(renderedKeys);
      if (activeDataKeys.length !== 25 || activeKeys.size !== 25) {
        return reject('active-key-count');
      }
      if (renderedKeys.length !== 9 || rendered.size !== 9) {
        return reject('rendered-key-count');
      }
      if ([...rendered].some(key => !activeKeys.has(key))) {
        return reject('rendered-owner-outside-active');
      }
      if (!acceptRuntimeTransitionContract(acceptedTransition)) {
        localTerrainStaleDiscardCount += 1;
        return reject('stale-transition');
      }
      localTerrainSyncEpoch = requestedEpoch;
      const activeChunks = new Map();
      const missingOwnerKeys = [];
      for (const key of activeDataKeys) {
        const [chunkX, chunkZ] = key.split(',').map(Number);
        const chunk = getChunkData(chunkX, chunkZ);
        if (!chunk || chunk.chunkX !== chunkX || chunk.chunkZ !== chunkZ) {
          missingOwnerKeys.push(key);
        } else activeChunks.set(key, chunk);
      }
      localTerrainLastResolvedChunkCount = activeChunks.size;
      if (missingOwnerKeys.length) return reject('missing-chunk-data', missingOwnerKeys);
      const midgroundOwnerKeys = new Set([...activeKeys].filter(key => !rendered.has(key)));
      localTerrainLastMidgroundOwnerCount = midgroundOwnerKeys.size;
      if (midgroundOwnerKeys.size !== 16) return reject('midground-owner-count');
      const previous = activeLocalTerrainGeneration;
      if (!previous
        || previous.centerChunkX !== centerChunkX
        || previous.centerChunkZ !== centerChunkZ
        || !equalKeySets(previous.activeKeys, activeKeys)
        || !equalKeySets(previous.renderedKeys, rendered)) {
        return reject('coverage-changed-during-preset-sync');
      }
      if (previous.renderDistancePreset === renderDistancePolicy.id) {
        positionGenerationForOrigin(previous, renderOrigin);
        applyLocalTerrainOwnerHandoff(previous, activeDataKeys, renderedKeys);
        assignTransitionContract(previous, acceptedTransition);
        committedLocalTerrainEpoch = requestedEpoch;
        localTerrainLastSyncDurationMs = (globalThis.performance?.now?.() ?? Date.now()) - startedAt;
        return Object.freeze({
          committed: true,
          reused: true,
          coverageEpoch: requestedEpoch,
          reason: null,
          missingOwnerKeys: Object.freeze([]),
          activeRootId: previous.root.name,
        });
      }
      const reusableMidgroundMesh = previous.root.children?.find(child => (
        child.name === 'w8-midground-outer-sixteen-terrain'
      ));
      if (!reusableMidgroundMesh) return reject('midground-source-missing');

      currentCanonicalSurfacePolicy = surfacePolicyForChunks(activeChunks.values());
      currentCanonicalSurfacePolicy = Object.freeze({
        ...currentCanonicalSurfacePolicy,
        riverCorridors: Object.freeze(riverSurfaceCorridorsForClipmap(
          centerChunkX,
          centerChunkZ,
          currentCanonicalSurfacePolicy,
          renderDistancePolicy.terrainCoverageDistanceMeters,
        )),
      });
      const localRoot = new Group();
      localRoot.name = `w8-local-terrain-coverage-epoch-${requestedEpoch}`;
      localRoot.userData = {
        presentationOnly: true,
        localTerrainCoverage: true,
        coverageEpoch: requestedEpoch,
        renderDistancePreset: renderDistancePolicy.id,
      };
      stagingLocalTerrainRootId = localRoot.name;
      const generation = {
        epoch: requestedEpoch,
        root: localRoot,
        ownedGeometries: new Set(),
        ownedMaterials: new Set(),
        stats: createStats(),
        activeKeys,
        renderedKeys: rendered,
        midgroundOwnerKeys,
        centerChunkX,
        centerChunkZ,
        renderDistancePreset: renderDistancePolicy.id,
        renderDistancePolicy,
        buildOriginChunkX: renderOrigin.renderOriginChunkX,
        buildOriginChunkZ: renderOrigin.renderOriginChunkZ,
        currentOriginChunkX: renderOrigin.renderOriginChunkX,
        currentOriginChunkZ: renderOrigin.renderOriginChunkZ,
        surfacePolicy: currentCanonicalSurfacePolicy,
      };
      assignTransitionContract(generation, acceptedTransition);
      generation.stats.midgroundChunkCount = 16;
      const midgroundMesh = new Mesh(
        reusableMidgroundMesh.geometry,
        reusableMidgroundMesh.material,
      );
      midgroundMesh.name = reusableMidgroundMesh.name;
      midgroundMesh.castShadow = reusableMidgroundMesh.castShadow;
      midgroundMesh.receiveShadow = reusableMidgroundMesh.receiveShadow;
      midgroundMesh.userData = { ...(reusableMidgroundMesh.userData ?? {}) };
      localRoot.add(midgroundMesh);
      generation.localTerrainMesh = midgroundMesh;
      generation.currentVisibleMidgroundOwnerKeys = new Set(
        midgroundMesh.userData.visibleOwnerKeys ?? [],
      );
      applyLocalTerrainOwnerHandoff(generation, activeDataKeys, renderedKeys);
      const assertCurrent = () => {
        if (disposed || requestedEpoch !== localTerrainSyncEpoch
          || !transitionIsCurrent(acceptedTransition)) throw LOCAL_SYNC_CANCELLED;
      };
      try {
        localTerrainLastMaximumSliceMs = await createClipmapIncrementally({
          centerChunkX,
          centerChunkZ,
          activeChunks,
          origin: renderOrigin,
          renderDistancePreset: renderDistancePolicy.id,
          surfacePolicy: generation.surfacePolicy,
          stats: generation.stats,
          target: localRoot,
          ownedGeometries: generation.ownedGeometries,
          generation,
        }, assertCurrent);
        assertCurrent();
        positionGenerationForOrigin(generation, renderOrigin);
      } catch (error) {
        disposeGeneration(generation);
        if (stagingLocalTerrainRootId === localRoot.name) stagingLocalTerrainRootId = null;
        if (error === LOCAL_SYNC_CANCELLED) {
          localTerrainStaleDiscardCount += 1;
          return reject(disposed ? 'disposed-during-build' : 'stale-after-build');
        }
        localTerrainLastRejectionReason = 'build-error';
        localTerrainLastSyncDurationMs = (globalThis.performance?.now?.() ?? Date.now()) - startedAt;
        throw error;
      }
      if (stagingLocalTerrainRootId === localRoot.name) stagingLocalTerrainRootId = null;
      if (deferPublication) {
        if (preparedRenderDistanceLocalTerrain) {
          disposeGeneration(preparedRenderDistanceLocalTerrain.generation);
        }
        preparedRenderDistanceLocalTerrain = {
          generation,
          previous,
          reusableMidgroundMesh,
          requestedEpoch,
        };
        localTerrainLastSyncDurationMs = (globalThis.performance?.now?.() ?? Date.now()) - startedAt;
        return Object.freeze({
          committed: false,
          prepared: true,
          reused: false,
          coverageEpoch: requestedEpoch,
          reason: null,
          missingOwnerKeys: Object.freeze([]),
          activeRootId: previous.root.name,
        });
      }
      previous.ownedGeometries.delete(reusableMidgroundMesh.geometry);
      generation.ownedGeometries.add(reusableMidgroundMesh.geometry);
      const swapStartedAt = globalThis.performance?.now?.() ?? Date.now();
      const publication = publishLocalTerrainGeneration(generation, previous);
      generation.stats.publicationScope = publication.publicationScope;
      activeLocalTerrainGeneration = generation;
      refreshMacroCoarseWorldPresentation(renderOrigin);
      committedLocalTerrainEpoch = requestedEpoch;
      localTerrainCommitCount += 1;
      localTerrainLastRootSwapDurationMs = (globalThis.performance?.now?.() ?? Date.now())
        - swapStartedAt;
      localTerrainLastSyncDurationMs = (globalThis.performance?.now?.() ?? Date.now()) - startedAt;
      return Object.freeze({
        committed: true,
        reused: false,
        coverageEpoch: requestedEpoch,
        reason: null,
        missingOwnerKeys: Object.freeze([]),
        activeRootId: generation.root.name,
      });
    },
    async sync({
      transitionContract = null,
      activeDataKeys,
      renderedKeys,
      getChunkData,
      renderOrigin,
      centerChunkX,
      centerChunkZ,
      quality = 'high',
      renderDistancePreset = W8_DEFAULT_RENDER_DISTANCE_PRESET,
      playerLogicalX = (centerChunkX + 0.5) * LOGICAL_CHUNK_SIZE_METERS,
      playerLogicalZ = (centerChunkZ + 0.5) * LOGICAL_CHUNK_SIZE_METERS,
      deferPublication = false,
      preserveStaticNatural = false,
    }) {
      if (disposed) throw new Error('distant presentation is disposed');
      const syncStartedAt = globalThis.performance?.now?.() ?? Date.now();
      const requestedRenderDistancePreset = normalizeW8RenderDistancePreset(
        renderDistancePreset,
      );
      const acceptedTransition = validateTransitionCoverage(transitionContract, {
        activeDataKeys,
        renderedKeys,
        centerChunkX,
        centerChunkZ,
      });
      recordDiagnosticEvent('distant-sync-requested', {
        syncEpoch: syncEpoch + 1,
        transitionGeneration: acceptedTransition?.generation ?? null,
        renderDistancePreset: requestedRenderDistancePreset,
        preserveStaticNatural,
      });
      if (!commitRuntimePresentationState({
        transitionContract: acceptedTransition,
        activeDataKeys,
        renderedKeys,
        renderOrigin,
        quality,
        playerLogicalX,
        playerLogicalZ,
      })) return false;
      const epoch = ++syncEpoch;
      beginRoadLifecycle({
        syncEpoch: epoch,
        transitionGeneration: acceptedTransition?.generation ?? null,
        playerX: playerLogicalX,
        playerZ: playerLogicalZ,
      });
      pendingFarSyncEpochs.add(epoch);
      cancelCanonicalChunkRequests?.({
        consumerId: 'distant-owner-query',
        beforeEpoch: epoch,
      });
      const assertCurrent = () => {
        if (disposed || epoch !== syncEpoch
          || !transitionIsCurrent(acceptedTransition)) throw SYNC_CANCELLED;
      };
      const rendered = new Set(renderedKeys);
      const activeKeys = new Set(activeDataKeys);
      const activeChunks = new Map();
      measure('distant-collect', () => {
        for (const key of activeDataKeys) {
          const [chunkX, chunkZ] = key.split(',').map(Number);
          const chunk = getChunkData(chunkX, chunkZ);
          if (chunk) activeChunks.set(key, chunk);
        }
      });
      currentCanonicalSurfacePolicy = surfacePolicyForChunks(activeChunks.values());
      const centerWorldX = (centerChunkX + 0.5) * LOGICAL_CHUNK_SIZE_METERS;
      const centerWorldZ = (centerChunkZ + 0.5) * LOGICAL_CHUNK_SIZE_METERS;
      const independentRoadPresentation = incrementalStaticTreePages
        && deferPublication !== true;
      const independentRoadContext = independentRoadPresentation ? {
        lifecycleEpoch: epoch,
        transitionContract: acceptedTransition,
        activeChunks,
        activeKeys,
        renderedKeys: rendered,
        renderOrigin,
        quality,
        renderDistancePreset: requestedRenderDistancePreset,
        playerLogicalX,
        playerLogicalZ,
      } : null;
      if (independentRoadContext) stageIndependentRoadContext(independentRoadContext);
      let far;
      try {
        far = await prepareCanonicalFarChunks({
          centerWorldX: playerLogicalX,
          centerWorldZ: playerLogicalZ,
          quality,
          renderDistancePreset: requestedRenderDistancePreset,
          activeKeys,
          consumerEpoch: epoch,
          assertCurrent,
          independentRoadPresentation,
          independentRoadContext,
        });
        recordDiagnosticEvent('distant-query-ready', {
          syncEpoch: epoch,
          transitionGeneration: acceptedTransition?.generation ?? null,
          renderDistancePreset: requestedRenderDistancePreset,
          buildingOwnerCount: far.buildingOwnerChunkCount,
          settlementCandidateCount: far.candidateCount,
        });
        if (diagnosticsEnabled) recordDiagnosticWork('legacy-distant-query', {
          calls: 1,
          buildingOwnersQueried: far.buildingOwnerChunkCount,
          settlementCandidatesEnumerated: far.candidateCount,
        });
      } catch (error) {
        if (error !== SYNC_CANCELLED) {
          pendingFarSyncEpochs.delete(epoch);
          throw error;
        }
        staleEpochDiscardCount += 1;
        activeGeneration && (activeGeneration.stats.syncCancelledDuringQueryCount += 1);
        cancelRoadLifecycle(epoch, disposed ? 'disposed-during-query' : 'superseded-during-query');
        pendingFarSyncEpochs.delete(epoch);
        return false;
      }
      if (disposed || epoch !== syncEpoch || !transitionIsCurrent(acceptedTransition)) {
        staleEpochDiscardCount += 1;
        cancelRoadLifecycle(epoch, disposed ? 'disposed-after-query' : 'superseded-after-query');
        pendingFarSyncEpochs.delete(epoch);
        return false;
      }
      currentCanonicalSurfacePolicy = surfacePolicyForChunks([
        ...activeChunks.values(),
        ...far.chunks.map(value => value.chunk),
      ], far.riverProjections.map(projection => projection.surfaceCorridor));
      rememberRiverCorridorWindow({
        centerChunkX,
        centerChunkZ,
        terrainRiverExtentMeters:
          resolveW8RenderDistancePolicy(requestedRenderDistancePreset).terrainCoverageDistanceMeters,
        corridors: far.riverProjections
          .map(projection => projection.surfaceCorridor)
          .filter(Boolean),
      });

      if (incrementalStaticTreePages && !preserveStaticNatural) {
        if (!persistentTreeGeneration
          || persistentTreeGeneration.quality !== quality
          || persistentTreeGeneration.renderDistancePreset !== requestedRenderDistancePreset) {
          const previousOwnerKeys = new Set(persistentTreePages.keys());
          if (persistentTreeGeneration) {
            if (persistentNaturalVisibilityRetainedGeneration) {
              deferGenerationDispose(persistentTreeGeneration);
            } else if (previousOwnerKeys.size > 0) {
              persistentNaturalVisibilityRetainedGeneration = persistentTreeGeneration;
            } else {
              deferGenerationDispose(persistentTreeGeneration);
            }
          }
          persistentTreeGeneration = createPersistentNaturalGeneration({
            quality,
            renderDistancePreset: requestedRenderDistancePreset,
            renderOrigin,
            attach: persistentNaturalVisibilityRetainedGeneration === null,
          });
          persistentTreeGeneration.visibilityBaselineOwnerKeys = previousOwnerKeys;
          persistentTreePages.clear();
          pendingPersistentTreePages.clear();
          pendingPersistentTreePublications.clear();
          persistentNaturalDetailAvailableOwners.clear();
          persistentTreePublishedOwners.clear();
          persistentTreeDisposeOwners.length = 0;
          persistentTreeDesiredResourceKinds.clear();
          persistentTreeVisibilityDirty = true;
          persistentNaturalVisibilityJob = null;
          persistentNaturalVisibilityCompletedInputKey = null;
          persistentNaturalVisibilityDirtyStableIds.clear();
          persistentNaturalVisibilityFullScanPending = true;
          persistentNaturalVisibilityObjectRevision += 1;
          persistentNaturalVisibilityCoverageBarrier = null;
        }
        persistentTreeGeneration.playerX = playerLogicalX;
        persistentTreeGeneration.playerZ = playerLogicalZ;
        persistentTreeGeneration.activeKeys = new Set(activeDataKeys);
        persistentTreeGeneration.renderedKeys = new Set(renderedKeys);
        positionGenerationForOrigin(persistentTreeGeneration, renderOrigin);
        // PresentationOwner is the sole Natural visual source. Gameplay Full
        // availability must never seed or replace the persistent owner page.
        // This keeps the first compact Presentation page from colliding with
        // an untracked Full-derived Stable ID in canonicalObjects.
        startPersistentNaturalVisibilityJob(
          persistentTreeGeneration,
          readNearVisibleSnapshotState(),
          { reason: 'sync-baseline', force: true, baseline: true },
        );
        if (!persistentNaturalVisibilityRetainedGeneration) {
          persistentTreeGeneration.visibilityBaselineOwnerKeys = new Set(
            persistentTreePages.keys(),
          );
        }
      }

      const stagingRoot = new Group();
      stagingRoot.name = `w8-distant-presentation-epoch-${epoch}`;
      stagingRoot.userData = {
        presentationOnly: true,
        epoch,
        renderDistancePreset: requestedRenderDistancePreset,
        treePathId: null,
        treeNaturalExcluded: true,
        staticNaturalExcluded: true,
        buildingPublicationSource,
        settlementRoadPublicationSource,
        settlementMetadataPublicationSource,
      };
      const presentationBuildOrigin = activeGeneration && persistentDistantRoot
        ? Object.freeze({
          renderOriginChunkX: activeGeneration.buildOriginChunkX,
          renderOriginChunkZ: activeGeneration.buildOriginChunkZ,
          rebaseCount: renderOrigin.rebaseCount,
        })
        : renderOrigin;
      const generation = {
        epoch,
        root: stagingRoot,
        excludeTreeNatural: true,
        excludeNatural: true,
        persistentDistant: incrementalStaticTreePages,
        // A deferred Render Distance generation owns a detached staging root.
        // Reusing a live persistent mesh here would leave the staged bucket with
        // only a reuse key and no mesh to own after the atomic preset commit.
        // Materialize detached meshes instead; ordinary live syncs keep the
        // persistent slot-reuse path below.
        allowPersistentDistantMeshReuse: deferPublication !== true,
        independentRoadPresentation,
        ownedGeometries: new Set(),
        ownedMaterials: new Set(),
        stats: createStats(),
        canonicalBuckets: new Map(),
        canonicalObjects: new Map(),
        activeKeys,
        renderedKeys: rendered,
        quality,
        renderDistancePreset: requestedRenderDistancePreset,
        renderDistancePolicy: resolveW8RenderDistancePolicy(requestedRenderDistancePreset),
        settlementPresentationPolicy: resolveW8SettlementPresentationPolicy(
          quality,
          requestedRenderDistancePreset,
        ),
        localFullHandoffMaterials: new Map(),
        naturalLodMaterials: new Map(),
        naturalLodPolicies: new Map(),
        naturalReveal: 1,
        naturalRevealInnerMeters: 0,
        naturalRevealStartedAt: null,
        horizonBuildingSilhouetteMaterial: null,
        remoteHorizonSilhouetteMaterial: null,
        buildOriginChunkX: presentationBuildOrigin.renderOriginChunkX,
        buildOriginChunkZ: presentationBuildOrigin.renderOriginChunkZ,
        currentOriginChunkX: renderOrigin.renderOriginChunkX,
        currentOriginChunkZ: renderOrigin.renderOriginChunkZ,
        playerX: playerLogicalX,
        playerZ: playerLogicalZ,
        queryCandidateCount: far.candidateCount,
        queryTemplateSuccessCount: far.templateSuccessCount,
        queryRemoteCandidateCount: far.remoteCandidateCount,
        queryRemoteSelectedCount: far.remoteSelectedCount,
        queryRemoteHorizonMaterializedCount: far.remoteHorizonMaterializedCount,
        queryRemoteSettlementLimit: far.remoteSettlementLimit,
        queryRemoteBuildingLimitPerSettlement: far.remoteBuildingLimitPerSettlement,
        queryRemotePartLimit: far.remotePartLimit,
        remoteHorizonStartMeters: far.remoteHorizonStartMeters,
        remoteHorizonFadeStartMeters: far.remoteFadeStartMeters,
        remoteHorizonFadeEndMeters: far.remoteFadeEndMeters,
        remoteHorizonHiddenDistanceMeters: far.remoteHiddenDistanceMeters,
        remoteHorizonFogEnabled: far.remoteFogEnabled,
        remoteHorizonAtmosphereMode: far.remoteAtmosphereMode,
        remoteHorizonFogIntegrationEndMeters: far.remoteFogIntegrationEndMeters,
        settlementMetadataQueryDistanceMeters: far.settlementMetadataQueryDistanceMeters,
        queryOwnerChunkCount: far.ownerChunkCount,
        queryOwnerChunkKeys: far.ownerChunkKeys,
        queryNaturalOwnerChunkCount: 0,
        queryNaturalOwnerChunkKeys: Object.freeze([]),
        queryInnerNaturalOwnerChunkCount: 0,
        queryUltraOwnerChunkCount: 0,
        queryUltraOnlyOwnerChunkCount: 0,
        queryUltraOwnerChunkKeys: Object.freeze([]),
        queryBuildingOwnerChunkCount: far.buildingOwnerChunkCount,
        queryBuildingOwnerChunkKeys: far.buildingOwnerChunkKeys,
        queryRoadOwnerChunkCount: far.roadOwnerChunkCount,
        queryRoadOwnerChunkKeys: far.roadOwnerChunkKeys,
        queryRemoteHorizonOwnerChunkCount: far.remoteHorizonOwnerChunkCount,
        queryExcludedActiveNaturalOwnerCount: 0,
        queryNaturalCandidateCount: 0,
        queryFarOwnerChunkCacheHits: far.farOwnerChunkCacheHits,
        queryFarOwnerChunkCacheMisses: far.farOwnerChunkCacheMisses,
        queryFarOwnerChunkCacheEvictions: far.farOwnerChunkCacheEvictions,
        queryUltraOwnerChunkCacheHits: 0,
        queryUltraOwnerChunkCacheMisses: 0,
        queryUltraOwnerChunkCacheEvictions: 0,
        innerWarmDurationMs: far.innerWarmDurationMs,
        ultraWarmDurationMs: 0,
        queryPreparationDurationMs: far.queryPreparationDurationMs,
        templateResolutionDurationMs: far.templateResolutionDurationMs,
        queryCanonicalChunkSuccessCount: far.canonicalChunkSuccessCount,
        querySettlementFeatureCount: far.settlementFeatureCount,
        queryMajorRoadFeatureCount: far.majorRoadFeatureCount,
        queryLandmarkCount: far.landmarkCount,
        queryRadius: far.queryRadius,
        visibilityMeters: far.visibilityMeters,
        roadVisibilityMeters: far.roadVisibilityMeters,
        roadQueryRadius: far.roadQueryRadius,
        naturalVisibilityMeters: 0,
        canonicalFarTreeVisibilityMeters: 0,
        naturalQueryRadius: 0,
        activeLocalSettlementId: far.activeLocalSettlementId,
        additionalLocalSettlementIds: Object.freeze([...far.additionalLocalSettlementIds]),
        localSettlementIds: new Set(far.localSettlementIds),
        localSettlementLimit: far.localSettlementLimit,
        settlementSelections: far.settlementSelections,
        remotePartBudgetRemaining: far.remotePartLimit,
        nearVisibleStableIds: new Set(),
        nearVisibleStableSignature: '',
        nearVisibleSettlementIds: new Set(),
        nearVisibleSettlementSignature: '',
        surfacePolicy: currentCanonicalSurfacePolicy,
      };
      assignTransitionContract(generation, acceptedTransition);
      const chunks = [...activeChunks.values()].sort((left, right) => (
        left.chunkZ - right.chunkZ || left.chunkX - right.chunkX
      ));
      const priorityRoadEligible = !independentRoadPresentation
        && incrementalStaticTreePages
        && activeGeneration !== null
        && persistentDistantRoot !== null
        && deferPublication !== true;
      if (priorityRoadEligible) {
        try {
          await buildAndPublishPriorityRoadGeneration({
            baseGeneration: generation,
            activeChunks,
            far,
            presentationBuildOrigin,
            renderOrigin,
            playerLogicalX,
            playerLogicalZ,
            assertCurrent,
          });
        } catch (error) {
          disposeGeneration(generation);
          if (error === SYNC_CANCELLED) {
            staleEpochDiscardCount += 1;
            cancelRoadLifecycle(
              epoch,
              disposed ? 'disposed-during-priority-road-build'
                : 'superseded-during-priority-road-build',
            );
            pendingFarSyncEpochs.delete(epoch);
            return false;
          }
          pendingFarSyncEpochs.delete(epoch);
          throw error;
        }
      }
      const context = {
        target: stagingRoot,
        ownedGeometries: generation.ownedGeometries,
        stats: generation.stats,
        generation,
        surfacePolicy: generation.surfacePolicy,
      };
      const scheduler = createSliceScheduler({ assertCurrent });
      try {
        for (const chunk of chunks) {
          await addCanonicalChunk({
            chunk,
            origin: presentationBuildOrigin,
            coveredSettlementIds: far.settlementIds,
            coveredRoadSettlementIds: far.roadSettlementIds,
            includeNatural: false,
            farNaturalEligible: false,
            includeNearDetails: true,
            includeRoadRecords: true,
            includeNonRoadRecords: true,
            context,
            scheduler,
          });
        }
        await scheduler.checkpoint({ force: true });
        for (const source of far.chunks) {
          await addCanonicalChunk({
            chunk: source.chunk,
            origin: presentationBuildOrigin,
            farEligibleSettlementIds: source.settlementIds,
            farEligibleRoadSettlementIds: source.roadSettlementIds,
            includeNatural: false,
            farNaturalEligible: false,
            includeRoadRecords: !independentRoadPresentation,
            includeNonRoadRecords: true,
            queryCenter: far.queryCenter,
            queryRadius: far.queryRadius,
            roadQueryRadius: far.roadQueryRadius,
            context,
            scheduler,
          });
        }
        for (const remote of far.remoteHorizons) {
          await addRemoteSettlementHorizon({
            remote, origin: presentationBuildOrigin, context, scheduler,
          });
        }
        generation.stats.remoteSettlementCandidateCount = far.remoteCandidateCount;
        generation.stats.remoteSettlementSelectedCount = far.remoteSelectedCount;
        await scheduler.checkpoint({ force: true });
        await finalizeCanonicalMeshesIncrementally(context, scheduler);
        await scheduler.checkpoint({ force: true });
        await createFarRiverPresentation({
          projections: far.riverProjections, origin: presentationBuildOrigin, context, scheduler,
        });
        await scheduler.checkpoint({ force: true });
        markRoadLifecycleRegistered(generation);
        positionGenerationForOrigin(generation, renderOrigin);
        const dirtyBuckets = updateCanonicalVisibility(
          generation,
          playerLogicalX,
          playerLogicalZ,
          { compose: false },
        );
        await scheduler.checkpoint({ force: true });
        if (dirtyBuckets.size) {
          await composeCanonicalMeshesIncrementally(generation, dirtyBuckets, scheduler);
        }
        const sliceSnapshot = scheduler.finish();
        generation.maximumSliceMs = sliceSnapshot.maximumSliceMs;
        generation.sliceCount = sliceSnapshot.sliceCount;
        farLastMaximumSliceMs = sliceSnapshot.maximumSliceMs;
        farLastSliceCount = sliceSnapshot.sliceCount;
      } catch (error) {
        const sliceSnapshot = scheduler.snapshot();
        farLastMaximumSliceMs = sliceSnapshot.maximumSliceMs;
        farLastSliceCount = sliceSnapshot.sliceCount;
        disposeGeneration(generation);
        if (error === SYNC_CANCELLED) {
          staleEpochDiscardCount += 1;
          cancelRoadLifecycle(epoch, disposed ? 'disposed-during-build' : 'superseded-during-build');
          pendingFarSyncEpochs.delete(epoch);
          return false;
        }
        pendingFarSyncEpochs.delete(epoch);
        throw error;
      }
      if (disposed || epoch !== syncEpoch || !transitionIsCurrent(acceptedTransition)) {
        disposeGeneration(generation);
        staleEpochDiscardCount += 1;
        cancelRoadLifecycle(epoch, disposed ? 'disposed-after-build' : 'superseded-after-build');
        pendingFarSyncEpochs.delete(epoch);
        return false;
      }
      // Re-read Near ownership and feature damage after the last asynchronous
      // slice. A Tree destroyed while this staging generation was composing
      // must never publish a stale Full/Forest/Atmospheric/Horizon instance.
      const commitDirtyBuckets = updateCanonicalVisibility(
        generation,
        playerLogicalX,
        playerLogicalZ,
        { compose: false },
      );
      if (commitDirtyBuckets.size) composeCanonicalMeshes(generation, commitDirtyBuckets);
      const previous = activeGeneration;
      generation.staticPublicationTickets = Object.freeze([]);
      const rootSwapStartedAt = globalThis.performance?.now?.() ?? Date.now();
      committedEpoch = epoch;
      if (deferPublication) {
        if (preparedRenderDistanceDistant) disposeGeneration(
          preparedRenderDistanceDistant.generation,
        );
        markRoadLifecyclePublicationQueued(generation);
        preparedRenderDistanceDistant = { generation, previous };
        generation.syncDurationMs = (globalThis.performance?.now?.() ?? Date.now()) - syncStartedAt;
        pendingFarSyncEpochs.delete(epoch);
        return true;
      }
      markRoadLifecyclePublicationQueued(generation);
      if (incrementalStaticTreePages && previous && persistentDistantRoot) {
        beginPersistentDistantPublication(generation, previous);
      } else {
        root.add(generation.root);
        activeGeneration = generation;
        markRoadLifecyclePublished(generation);
        recordDistantPublication(generation);
        retireGeneration(previous);
        if (incrementalStaticTreePages) {
          persistentDistantRoot = generation.root;
          persistentDistantPublishedGeneration = generation;
          liveDistantEntries.clear();
          for (const [key, entry] of directCanonicalMeshEntries(generation)) {
            liveDistantEntries.set(key, entry);
          }
          for (const [key, entry] of directAuxiliaryMeshEntries(generation)) {
            liveDistantEntries.set(key, entry);
          }
        }
      }
      if (independentRoadPresentation) requestIndependentRoadPublication();
      generation.rootSwapDurationMs = (globalThis.performance?.now?.() ?? Date.now())
        - rootSwapStartedAt;
      recordDiagnosticEvent('distant-publication-queued', {
        syncEpoch: epoch,
        transitionGeneration: acceptedTransition?.generation ?? null,
        renderDistancePreset: requestedRenderDistancePreset,
        persistentPublication: incrementalStaticTreePages && previous && persistentDistantRoot
          ? true : false,
        rootAttached: generation.root.parent === root,
        naturalExcluded: generation.excludeNatural === true,
        coverageSignature: acceptedTransition?.coverageSignature ?? null,
        buildingPublicationSource,
        settlementRoadPublicationSource,
        settlementMetadataPublicationSource,
        settlementPublicationPlanId,
        settlementPublicationRevision,
      });
      generation.syncDurationMs = (globalThis.performance?.now?.() ?? Date.now()) - syncStartedAt;
      pendingFarSyncEpochs.delete(epoch);
      return true;
    },
    setTreeLodDiagnosticsEnabled(enabled) {
      treeLodDiagnosticsEnabled = enabled === true;
      if (!activeGeneration) return treeLodDiagnosticsEnabled;
      if (treeLodDiagnosticsEnabled && !activeGeneration.treeLodDiagnostics) {
        createTreeLodDiagnostics(activeGeneration);
      } else if (activeGeneration.treeLodDiagnostics) {
        if (treeLodDiagnosticsEnabled) updateTreeLodDiagnostics(activeGeneration);
        else disposeTreeLodDiagnostics(activeGeneration);
      }
      return treeLodDiagnosticsEnabled;
    },
    invalidatePendingLocalTerrainSync() {
      localTerrainSyncEpoch += 1;
      return localTerrainSyncEpoch;
    },
    invalidatePendingFarSync() {
      syncEpoch += 1;
      cancelCanonicalChunkRequests?.({
        consumerId: 'distant-owner-query',
        beforeEpoch: syncEpoch + 1,
      });
      return syncEpoch;
    },
    stageStaticNaturalRenderDistancePreset(renderDistancePreset) {
      stagedPersistentNaturalRenderDistancePreset = normalizeW8RenderDistancePreset(
        renderDistancePreset,
      );
      return stagedPersistentNaturalRenderDistancePreset;
    },
    isStaticNaturalCoverageReady(ownerKeys = []) {
      return Array.isArray(ownerKeys) && ownerKeys.every(ownerKey => (
        persistentTreePublishedOwners.has(ownerKey)
          && !pendingPersistentTreePages.has(ownerKey)
          && !pendingPersistentTreePublications.has(ownerKey)
      ));
    },
    commitPreparedRenderDistancePreset(renderDistancePreset) {
      const preset = normalizeW8RenderDistancePreset(renderDistancePreset);
      const distant = preparedRenderDistanceDistant;
      const localTerrain = preparedRenderDistanceLocalTerrain;
      if (!distant || !localTerrain
        || distant.generation.renderDistancePreset !== preset
        || localTerrain.generation.renderDistancePreset !== preset
        || stagedPersistentNaturalRenderDistancePreset !== preset
        || distant.previous !== activeGeneration
        || localTerrain.previous !== activeLocalTerrainGeneration) return false;
      const distantGeneration = distant.generation;
      // Commit is an atomic root swap. Every canonical bucket in the prepared
      // generation must therefore own a concrete mesh before any live state is
      // mutated; persistent reuse markers are valid only for incremental live
      // publication, not for detached preset staging.
      assertPreparedDistantGenerationMaterialized(distantGeneration);
      root.add(distantGeneration.root);
      activeGeneration = distantGeneration;
      markRoadLifecyclePublished(distantGeneration);
      recordDistantPublication(distantGeneration);
      retireGeneration(distant.previous);
      persistentDistantRoot = distantGeneration.root;
      persistentDistantPublishedGeneration = distantGeneration;
      liveDistantEntries.clear();
      for (const [key, entry] of directCanonicalMeshEntries(distantGeneration)) {
        liveDistantEntries.set(key, entry);
      }
      for (const [key, entry] of directAuxiliaryMeshEntries(distantGeneration)) {
        liveDistantEntries.set(key, entry);
      }
      const localGeneration = localTerrain.generation;
      localTerrain.previous.ownedGeometries.delete(
        localTerrain.reusableMidgroundMesh.geometry,
      );
      localGeneration.ownedGeometries.add(localTerrain.reusableMidgroundMesh.geometry);
      const localPublication = publishLocalTerrainGeneration(
        localGeneration,
        localTerrain.previous,
      );
      localGeneration.stats.publicationScope = localPublication.publicationScope;
      activeLocalTerrainGeneration = localGeneration;
      refreshMacroCoarseWorldPresentation();
      committedLocalTerrainEpoch = localTerrain.requestedEpoch;
      localTerrainCommitCount += 1;
      applyPersistentNaturalRenderDistancePreset(preset);
      localTerrainLastRootSwapDurationMs = 0;
      preparedRenderDistanceDistant = null;
      preparedRenderDistanceLocalTerrain = null;
      return true;
    },
    discardPreparedRenderDistancePreset() {
      if (preparedRenderDistanceDistant) disposeGeneration(
        preparedRenderDistanceDistant.generation,
      );
      if (preparedRenderDistanceLocalTerrain) disposeGeneration(
        preparedRenderDistanceLocalTerrain.generation,
      );
      preparedRenderDistanceDistant = null;
      preparedRenderDistanceLocalTerrain = null;
      stagedPersistentNaturalRenderDistancePreset = null;
    },
    applyStaticTreePlan({
      coverageGeneration,
      planRevision,
      planId,
      destructionRevision = null,
      quality = 'high',
      renderDistancePreset = W8_DEFAULT_RENDER_DISTANCE_PRESET,
      renderOrigin,
      playerLogicalX,
      playerLogicalZ,
      activeDataKeys = [],
      renderedKeys = [],
      retainedOwnerKeys = [],
      resourceKindEntries = [],
      policyResourceCoverage = [],
      readyPages = [],
    } = {}) {
      if (!incrementalStaticTreePages || disposed) return false;
      const requestedPreset = normalizeW8RenderDistancePreset(renderDistancePreset);
      const reset = !persistentTreeGeneration
        || persistentTreeGeneration.quality !== quality
        || persistentTreeGeneration.renderDistancePreset !== requestedPreset;
      if (reset) {
        const previousOwnerKeys = new Set([...persistentTreePages.entries()].flatMap(
          ([ownerKey, page]) => page.ownerKeys ?? [ownerKey],
        ));
        if (persistentNaturalVisibilityRetainedGeneration) {
          if (persistentTreeGeneration) deferGenerationDispose(persistentTreeGeneration);
        } else if (persistentTreeGeneration && previousOwnerKeys.size > 0) {
          persistentNaturalVisibilityRetainedGeneration = persistentTreeGeneration;
        } else if (persistentTreeGeneration) {
          deferGenerationDispose(persistentTreeGeneration);
        }
        persistentTreeGeneration = createPersistentNaturalGeneration({
          quality,
          renderDistancePreset: requestedPreset,
          renderOrigin,
          attach: persistentNaturalVisibilityRetainedGeneration === null,
        });
        persistentTreeGeneration.visibilityBaselineOwnerKeys = previousOwnerKeys;
        persistentTreePages.clear();
        pendingPersistentTreePages.clear();
        pendingPersistentTreePublications.clear();
        persistentNaturalDetailAvailableOwners.clear();
        persistentTreePublishedOwners.clear();
        persistentTreeDisposeOwners.length = 0;
        persistentTreeDesiredResourceKinds.clear();
        persistentTreeRetainedOwnerKeys = new Set();
        persistentTreeVisibilityDirty = true;
        persistentNaturalVisibilityJob = null;
        persistentNaturalVisibilityCompletedInputKey = null;
        persistentNaturalVisibilityDirtyStableIds.clear();
        persistentNaturalVisibilityFullScanPending = true;
        persistentNaturalVisibilityObjectRevision += 1;
        persistentNaturalVisibilityCoverageBarrier = null;
        persistentTreeRootResetCount += 1;
      }
      persistentTreeCoverageGeneration = coverageGeneration;
      persistentTreePlanRevision = planRevision;
      persistentTreePlanId = planId;
      applyPersistentNaturalPolicyCoverage(
        persistentTreeGeneration,
        policyResourceCoverage,
      );
      const retained = new Set(retainedOwnerKeys);
      persistentTreeRetainedOwnerKeys = retained;
      persistentTreeGeneration.visibilityPlanApplied = true;
      if (persistentNaturalVisibilityRetainedGeneration) {
        persistentTreeGeneration.visibilityBaselineOwnerKeys = new Set(
          [...persistentTreeGeneration.visibilityBaselineOwnerKeys]
            .filter(ownerKey => retained.has(ownerKey)),
        );
      }
      persistentTreeDesiredResourceKinds.clear();
      for (const entry of resourceKindEntries) {
        if (!Array.isArray(entry) || entry.length !== 2 || !retained.has(entry[0])) continue;
        if (entry[1] !== 'presentation') continue;
        persistentTreeDesiredResourceKinds.set(entry[0], entry[1]);
      }
      for (let index = persistentTreeDisposeOwners.length - 1; index >= 0; index -= 1) {
        const ownerKey = persistentTreeDisposeOwners[index];
        if (isPersistentTreePageRetained(
          ownerKey,
          persistentTreePages.get(ownerKey) ?? pendingPersistentTreePages.get(ownerKey),
          retained,
        )) {
          persistentTreeDisposeOwners.splice(index, 1);
        }
      }
      for (const [ownerKey, page] of persistentTreePages) {
        if (!isPersistentTreePageRetained(ownerKey, page, retained)
          && !persistentTreeDisposeOwners.includes(ownerKey)) {
          persistentTreeDisposeOwners.push(ownerKey);
        }
      }
      for (const [ownerKey, pending] of pendingPersistentTreePages) {
        if (!isPersistentTreePageRetained(ownerKey, pending, retained)
          || (persistentTreeDesiredResourceKinds.has(ownerKey)
            && persistentTreeDesiredResourceKinds.get(ownerKey) !== pending.resourceKind)) {
          pendingPersistentTreePages.delete(ownerKey);
          persistentTreeStalePageDiscardCount += 1;
        }
      }
      for (const ownerKey of persistentNaturalDetailAvailableOwners) {
        if (!retained.has(ownerKey)) persistentNaturalDetailAvailableOwners.delete(ownerKey);
      }
      persistentNaturalCoverageApplyCount += 1;
      const advanced = advancePersistentNaturalFrame({
        coverageGeneration,
        planRevision,
        planId,
        destructionRevision,
        playerLogicalX,
        playerLogicalZ,
        activeDataKeys,
        renderedKeys,
        readyPages,
      });
      if (reset && persistentNaturalVisibilityRetainedGeneration) {
        startPersistentNaturalVisibilityJob(
          persistentTreeGeneration,
          readNearVisibleSnapshotState(),
          { reason: 'plan-reset-baseline', force: true, baseline: true },
        );
      }
      return advanced;
    },
    applyStaticNaturalPlan(options) {
      return this.applyStaticTreePlan(options);
    },
    advanceStaticNaturalFrame(options) {
      return advancePersistentNaturalFrame(options);
    },
    releaseStaticNaturalRetainedOwners(ownerKeys = []) {
      if (!persistentTreeGeneration || !Array.isArray(ownerKeys)) return false;
      const retained = new Set(ownerKeys);
      persistentTreeRetainedOwnerKeys = retained;
      for (const ownerKey of persistentTreeDesiredResourceKinds.keys()) {
        if (!retained.has(ownerKey)) persistentTreeDesiredResourceKinds.delete(ownerKey);
      }
      for (const [ownerKey, page] of persistentTreePages) {
        if (!isPersistentTreePageRetained(ownerKey, page, retained)
          && !persistentTreeDisposeOwners.includes(ownerKey)) {
          persistentTreeDisposeOwners.push(ownerKey);
        }
      }
      for (const [ownerKey, page] of pendingPersistentTreePages) {
        if (!isPersistentTreePageRetained(ownerKey, page, retained)) {
          pendingPersistentTreePages.delete(ownerKey);
          persistentTreeStalePageDiscardCount += 1;
        }
      }
      for (const ownerKey of persistentNaturalDetailAvailableOwners) {
        if (!retained.has(ownerKey)) persistentNaturalDetailAvailableOwners.delete(ownerKey);
      }
      return true;
    },
    commitRuntimeState(state) {
      if (disposed) return false;
      const committed = commitRuntimePresentationState(state);
      if (committed && persistentTreeGeneration) {
        persistentTreeGeneration.activeKeys = new Set(state.activeDataKeys ?? []);
        persistentTreeGeneration.renderedKeys = new Set(state.renderedKeys ?? []);
        persistentTreeVisibilityDirty = true;
      }
      return committed;
    },
    update(
      playerLogicalX,
      playerLogicalZ,
      renderOrigin,
      { velocityX = 0, velocityZ = 0 } = {},
    ) {
      if (disposed) return;
      if (!acceptCommittedRenderOrigin(renderOrigin)) return false;
      updateIndependentRoadTargetPosition(playerLogicalX, playerLogicalZ, renderOrigin);
      const frameStartedAt = monotonicNow();
      if (enableMacroCoarseWorld) {
        ensureMacroCoarseWorldPresentation(
          playerLogicalX,
          playerLogicalZ,
        );
        const macroCenter = logicalWorldToMacroCell(playerLogicalX, playerLogicalZ);
        const macroFrame = macroCoarseWorldController.advanceFrame({
          playerX: playerLogicalX,
          playerZ: playerLogicalZ,
          velocityX,
          velocityZ,
          context: Object.freeze({
            surfaceWindowPromise: ensureMacroSurfaceWindow(
              macroCenter.macroX,
              macroCenter.macroZ,
            ),
          }),
        });
        if (diagnosticsEnabled) recordDiagnosticWork('macro-coarse-world', {
          calls: 1,
          requestedCells: macroFrame.requestedCellKeys.length,
          publishedCells: macroFrame.publishedCellKeys.length,
          retiredCells: macroFrame.retiredCellKeys.length,
          visibleMissingCells: macroFrame.visibleMissingCellKeys.length,
        });
      }
      const handoffFrame = processRuntimePresentationHandoff();
      const remainingFrameBudgetMs = () => Math.max(
        0,
        RUNTIME_PRESENTATION_FRAME_BUDGET_MS - (monotonicNow() - frameStartedAt),
      );
      const publicationFrame = handoffFrame.meshUpdates > 0
        ? Object.freeze({ admissions: 0, bytes: 0 })
        : processPersistentDistantPublication(remainingFrameBudgetMs());
      if (diagnosticsEnabled) recordDiagnosticWork('runtime-presentation-handoff', {
        calls: 1,
        durationMs: handoffFrame.durationMs,
        meshUpdates: handoffFrame.meshUpdates,
        matrixUpdates: handoffFrame.matrixUpdates,
        bufferUpdates: handoffFrame.bufferUpdates,
        uploadBytes: handoffFrame.uploadBytes,
        localTerrainHandoffs: handoffFrame.localTerrainHandoffs,
        distantAdmissions: publicationFrame.admissions,
        distantUploadBytes: publicationFrame.bytes,
      });
      positionGenerationForOrigin(activeLocalTerrainGeneration, renderOrigin);
      recordContinuousTerrainCoverageFrame(playerLogicalX, playerLogicalZ);
      if (persistentTreeGeneration) {
        positionGenerationForOrigin(persistentTreeGeneration, renderOrigin);
        persistentTreeGeneration.playerX = playerLogicalX;
        persistentTreeGeneration.playerZ = playerLogicalZ;
        enqueueNextRetainedDirectCanonicalTreeBatch();
        reconcilePersistentCoarseTreeSubmission(
          persistentTreeGeneration,
          playerLogicalX,
          playerLogicalZ,
        );
        processPersistentNaturalWork(Math.min(
          STATIC_TREE_PAGE_FRAME_BUDGET_MS,
          remainingFrameBudgetMs(),
        ));
      }
      if (enableMacroCoarseWorld) {
        updateMacroCoarseWorldPresentation({
          playerLogicalX,
          playerLogicalZ,
          renderOrigin,
        });
      }
      if (activeGeneration) {
        positionGenerationForOrigin(activeGeneration, renderOrigin);
        if (pendingDistantPublication?.generation === activeGeneration
          || pendingRuntimePresentationHandoff?.targetGeneration === activeGeneration) {
          updateNaturalLodPlayerUniforms(activeGeneration, playerLogicalX, playerLogicalZ);
        } else {
          updateCanonicalVisibility(
            activeGeneration,
            playerLogicalX,
            playerLogicalZ,
            { compose: activeGeneration.persistentDistant !== true },
          );
          if (handoffFrame.meshUpdates === 0 && publicationFrame.admissions === 0) {
            processPersistentDistantVisibility(activeGeneration, remainingFrameBudgetMs());
          }
        }
      }
      const disposedResources = processDeferredGenerationDisposals(Math.min(
        STATIC_TREE_DISPOSE_BUDGET_MS,
        remainingFrameBudgetMs(),
      ), 1);
      runtimePresentationHandoffDisposeCount += disposedResources;
      runtimePresentationHandoffMaximumDisposePerFrame = Math.max(
        runtimePresentationHandoffMaximumDisposePerFrame,
        disposedResources,
      );
      if (diagnosticsEnabled) recordDiagnosticWork('deferred-resource-dispose', {
        calls: 1,
        disposedResources,
        backlog: deferredGenerationDisposals.length,
      });
      return true;
    },
    rebase(renderOrigin) {
      if (disposed || !acceptCommittedRenderOrigin(renderOrigin)) return false;
      positionGenerationForOrigin(activeLocalTerrainGeneration, renderOrigin);
      positionGenerationForOrigin(activeGeneration, renderOrigin);
      positionGenerationForOrigin(persistentTreeGeneration, renderOrigin);
      macroCoarseWorldPresentation?.rebase(renderOrigin);
      return true;
    },
    settlementStreamingShadowSnapshot({
      renderDistancePreset = null,
      includePrepared = false,
      frameSequence = null,
      renderDistanceRevision = 0,
      stateRevision = 0,
    } = {}) {
      const requestedPreset = renderDistancePreset === null
        ? null : normalizeW8RenderDistancePreset(renderDistancePreset);
      const preparedGeneration = preparedRenderDistanceDistant?.generation ?? null;
      const generation = includePrepared && preparedGeneration
        && (requestedPreset === null
          || preparedGeneration.renderDistancePreset === requestedPreset)
        ? preparedGeneration : activeGeneration;
      if (!generation) return null;
      settlementShadowSnapshotRequestCount += 1;
      const materialize = () => {
        const diagnosticStartedAt = diagnosticsEnabled ? monotonicNow() : 0;
        settlementShadowSnapshotCount += 1;
        settlementShadowCanonicalObjectScanCount += generation.canonicalObjects.size;
        const stableIds = [];
        const stableIdSet = new Set();
        const settlementIdSet = new Set();
        const settlementOwnerSet = new Set(generation.queryBuildingOwnerChunkKeys ?? []);
        const roadLinkages = [];
        const damageStates = [];
        let duplicateStableIdCount = 0;
        let settlementRecordCount = 0;
        for (const object of generation.canonicalObjects.values()) {
          if (object.settlementId === null || object.settlementId === undefined) continue;
          settlementRecordCount += 1;
          stableIds.push(object.stableId);
          if (stableIdSet.has(object.stableId)) duplicateStableIdCount += 1;
          else stableIdSet.add(object.stableId);
          settlementIdSet.add(object.settlementId);
          settlementOwnerSet.add(object.ownerKey);
          if (object.record?.featureType === 'settlement-road') {
            roadLinkages.push(Object.freeze({
              stableId: object.stableId,
              settlementId: object.settlementId,
              ownerKey: object.ownerKey,
            }));
          }
          if (object.destructible) {
            damageStates.push(Object.freeze({
              stableId: object.stableId,
              destroyed: isFeatureDestroyed(object.stableId) === true,
            }));
          }
        }
        stableIds.sort();
        roadLinkages.sort((left, right) => left.stableId.localeCompare(right.stableId));
        damageStates.sort((left, right) => left.stableId.localeCompare(right.stableId));
        const settlementIds = [...settlementIdSet].sort();
        const buildingOwnerKeys = Object.freeze([
          ...new Set(generation.queryBuildingOwnerChunkKeys ?? []),
        ].sort());
        const settlementOwnerKeys = Object.freeze([...settlementOwnerSet].sort());
        const invalidRoadLinkageCount = roadLinkages.reduce(
          (count, linkage) => count + Number(!settlementIdSet.has(linkage.settlementId)),
          0,
        );
        let coverageHash = appendSettlementSnapshotHash(0x811c9dc5, generation.epoch);
        coverageHash = appendSettlementSnapshotHash(
          coverageHash,
          generation.renderDistancePreset,
        );
        for (const ownerKey of buildingOwnerKeys) {
          coverageHash = appendSettlementSnapshotHash(coverageHash, ownerKey);
        }
        for (const ownerKey of settlementOwnerKeys) {
          coverageHash = appendSettlementSnapshotHash(coverageHash, ownerKey);
        }
        for (const stableId of stableIds) {
          coverageHash = appendSettlementSnapshotHash(coverageHash, stableId);
        }
        for (const settlementId of settlementIds) {
          coverageHash = appendSettlementSnapshotHash(coverageHash, settlementId);
        }
        for (const linkage of roadLinkages) {
          coverageHash = appendSettlementSnapshotHash(coverageHash, linkage.stableId);
          coverageHash = appendSettlementSnapshotHash(coverageHash, linkage.settlementId);
          coverageHash = appendSettlementSnapshotHash(coverageHash, linkage.ownerKey);
        }
        let snapshotHash = coverageHash;
        for (const damageState of damageStates) {
          snapshotHash = appendSettlementSnapshotHash(snapshotHash, damageState.stableId);
          snapshotHash = appendSettlementSnapshotHash(snapshotHash, damageState.destroyed ? 1 : 0);
        }
        settlementShadowStableIdMaterializationCount += stableIds.length;
        if (diagnosticsEnabled) recordDiagnosticWork('settlement-shadow-observation', {
          calls: 1,
          requests: 1,
          cacheMisses: 1,
          canonicalObjectsScanned: generation.canonicalObjects.size,
          settlementRecordsMaterialized: settlementRecordCount,
          stableIdsMaterialized: stableIds.length,
          ownerKeysMaterialized: buildingOwnerKeys.length + settlementOwnerKeys.length,
          roadLinkagesMaterialized: roadLinkages.length,
          damageStatesMaterialized: damageStates.length,
          maximumSynchronousSliceMs: monotonicNow() - diagnosticStartedAt,
        });
        return Object.freeze({
          schemaVersion: 'legacy-building-settlement-observation-1',
          contentHash: `settlement-stream:${snapshotHash.toString(16).padStart(8, '0')}`,
          coverageContentHash:
            `settlement-coverage:${coverageHash.toString(16).padStart(8, '0')}`,
          frameSequence,
          presentationRevision: generation.epoch,
          renderDistanceRevision,
          stateRevision,
          publicationSource: buildingPublicationSource === settlementRoadPublicationSource
            && buildingPublicationSource === settlementMetadataPublicationSource
            ? buildingPublicationSource : 'mixed-exclusive-handoff',
          buildingPublicationSource,
          settlementRoadPublicationSource,
          settlementMetadataPublicationSource,
          publicationPlanId: settlementPublicationPlanId,
          publicationRevision: settlementPublicationRevision,
          renderDistancePreset: generation.renderDistancePreset,
          quality: generation.quality,
          generalVisibilityMeters: generation.visibilityMeters,
          metadataQueryDistanceMeters: generation.settlementMetadataQueryDistanceMeters,
          buildingOwnerKeys,
          settlementOwnerKeys,
          stableIds: Object.freeze(stableIds),
          settlementIds: Object.freeze(settlementIds),
          roadLinkages: Object.freeze(roadLinkages),
          damageStates: Object.freeze(damageStates),
          duplicateStableIdCount,
          duplicateSettlementIdCount: 0,
          invalidRoadLinkageCount,
          canonicalObjectScanCount: generation.canonicalObjects.size,
          settlementRecordCount,
        });
      };
      if (!Number.isSafeInteger(frameSequence) || frameSequence < 0) return materialize();
      const snapshot = settlementStreamingSnapshotCache.read({
        frameSequence,
        presentationRevision: generation.epoch,
        renderDistanceRevision,
        stateRevision,
        materialize,
      });
      if (settlementStreamingSnapshotCache.lastReadReused) {
        settlementShadowSnapshotReuseCount += 1;
        if (diagnosticsEnabled) recordDiagnosticWork('settlement-shadow-observation', {
          requests: 1,
          cacheHits: 1,
        });
      }
      return snapshot;
    },
    canClaimBuildingSettlementPublication(stage, {
      publicationKinds = Object.freeze(['building']),
      observation = stage?.observation ?? null,
      currentObservation = observation,
      stateRevision = null,
      renderDistanceRevision = null,
    } = {}) {
      const preparedGeneration = preparedRenderDistanceDistant?.generation ?? null;
      const generation = preparedGeneration?.renderDistancePreset === stage?.renderDistancePreset
        ? preparedGeneration : activeGeneration;
      if (!generation || !stage || !observation || !currentObservation
        || !Array.isArray(publicationKinds)) {
        return false;
      }
      if (stage.observation !== observation
        || stage.contentHash !== observation.contentHash
        || stage.contentHash !== currentObservation.contentHash
        || stage.originGeneration !== generation.transitionContract?.generation
        || stage.renderDistancePreset !== generation.renderDistancePreset
        || observation.presentationRevision !== generation.epoch
        || observation.renderDistanceRevision !== (
          renderDistanceRevision ?? observation.renderDistanceRevision
        )
        || !isSettlementStreamingSnapshotCurrent(currentObservation, {
          presentationRevision: generation.epoch,
          renderDistanceRevision: renderDistanceRevision ?? currentObservation.renderDistanceRevision,
          stateRevision: stateRevision ?? currentObservation.stateRevision,
        })) return false;
      return true;
    },
    claimBuildingSettlementPublication(stage, options = {}) {
      if (!this.canClaimBuildingSettlementPublication(stage, options)) return false;
      const { publicationKinds = Object.freeze(['building']) } = options;
      if (publicationKinds.includes('building')) {
        buildingPublicationSource = 'shared-streaming-plan';
      }
      if (publicationKinds.includes('settlement-road')) {
        settlementRoadPublicationSource = 'shared-streaming-plan';
      }
      if (publicationKinds.includes('metadata-remote')) {
        settlementMetadataPublicationSource = 'shared-streaming-plan';
      }
      settlementPublicationPlanId = stage.planId;
      settlementPublicationRevision = stage.renderDistanceRevision;
      activeGeneration.root.userData.buildingPublicationSource = buildingPublicationSource;
      activeGeneration.root.userData.settlementRoadPublicationSource =
        settlementRoadPublicationSource;
      activeGeneration.root.userData.settlementMetadataPublicationSource =
        settlementMetadataPublicationSource;
      return true;
    },
    useLegacyBuildingSettlementPublication() {
      buildingPublicationSource = 'legacy-distant-root';
      settlementRoadPublicationSource = 'legacy-distant-root';
      settlementMetadataPublicationSource = 'legacy-distant-root';
      settlementPublicationPlanId = null;
      settlementPublicationRevision = 0;
      if (activeGeneration?.root?.userData) {
        activeGeneration.root.userData.buildingPublicationSource = buildingPublicationSource;
        activeGeneration.root.userData.settlementRoadPublicationSource =
          settlementRoadPublicationSource;
        activeGeneration.root.userData.settlementMetadataPublicationSource =
          settlementMetadataPublicationSource;
      }
      return true;
    },
    snapshot({
      includeRemoteHorizonAtmospheres = false,
      includeSettlementSelectionDetails = false,
    } = {}) {
      const stats = activeGeneration?.stats ?? emptyStats;
      const localTerrainStats = activeLocalTerrainGeneration?.stats ?? emptyStats;
      const persistentTreeStats = persistentTreeGeneration?.stats ?? emptyStats;
      const naturalDiagnosticGeneration = persistentTreeGeneration ?? activeGeneration;
      const activeStaticNaturalIds = new Set(activeGeneration
        ? [...activeGeneration.canonicalObjects.values()]
          .filter(object => object.naturalKind !== null)
          .map(object => object.stableId)
        : []);
      const persistentStaticNaturalIds = new Set(persistentTreeGeneration
        ? [...persistentTreeGeneration.canonicalObjects.values()]
          .filter(object => object.naturalKind !== null)
          .map(object => object.stableId)
        : []);
      const persistentNaturalSummary = {
        recordCount: 0,
        vegetationCount: 0,
        treeCount: 0,
        shrubCount: 0,
        grassCount: 0,
        rockCount: 0,
        farCount: 0,
        midCount: 0,
        nearCount: 0,
        hiddenCount: 0,
        destroyedCount: 0,
        visibleVegetationCount: 0,
        visibleTreeCount: 0,
        visibleShrubCount: 0,
        visibleGrassCount: 0,
        visibleRockCount: 0,
        visibleFullTreeCount: 0,
        visibleSilhouetteTreeCount: 0,
        visibleUltraTreeCount: 0,
        visibleTreePartInstanceCount: 0,
      };
      let staticTreeCoarsePrewarmResidentOwnerCount = 0;
      let staticTreeCoarsePrewarmPublishedOwnerCount = 0;
      for (const [ownerKey, page] of persistentTreePages) {
        if (page.coarseFillBand !== 2) continue;
        staticTreeCoarsePrewarmResidentOwnerCount += 1;
        staticTreeCoarsePrewarmPublishedOwnerCount += Number(
          persistentTreePublishedOwners.has(ownerKey),
        );
      }
      for (const object of persistentTreeGeneration?.canonicalObjects.values?.() ?? []) {
        const kind = object.naturalKind;
        if (kind === null) continue;
        persistentNaturalSummary.recordCount += 1;
        if (kind === W8_VEGETATION_LOD_KINDS.ROCK) persistentNaturalSummary.rockCount += 1;
        else persistentNaturalSummary.vegetationCount += 1;
        if (kind === W8_VEGETATION_LOD_KINDS.TREE) persistentNaturalSummary.treeCount += 1;
        else if (kind === W8_VEGETATION_LOD_KINDS.BUSH) persistentNaturalSummary.shrubCount += 1;
        else if (kind === W8_VEGETATION_LOD_KINDS.GRASS) persistentNaturalSummary.grassCount += 1;
        const statusKey = `${object.visibleLod}Count`;
        if (statusKey in persistentNaturalSummary) persistentNaturalSummary[statusKey] += 1;
        if (!['far', 'mid', 'near'].includes(object.visibleLod)) continue;
        if (kind === W8_VEGETATION_LOD_KINDS.ROCK) {
          persistentNaturalSummary.visibleRockCount += 1;
        } else {
          persistentNaturalSummary.visibleVegetationCount += 1;
        }
        if (kind === W8_VEGETATION_LOD_KINDS.BUSH) {
          persistentNaturalSummary.visibleShrubCount += 1;
        } else if (kind === W8_VEGETATION_LOD_KINDS.GRASS) {
          persistentNaturalSummary.visibleGrassCount += 1;
        } else if (kind === W8_VEGETATION_LOD_KINDS.TREE) {
          persistentNaturalSummary.visibleTreeCount += 1;
          const tier = object.visibleLod === 'near'
            ? 'full' : object.naturalBlend?.dominantTier;
          if (tier === 'forest') persistentNaturalSummary.visibleSilhouetteTreeCount += 1;
          else if (tier === 'atmospheric' || tier === 'horizon') {
            persistentNaturalSummary.visibleUltraTreeCount += 1;
          } else persistentNaturalSummary.visibleFullTreeCount += 1;
          persistentNaturalSummary.visibleTreePartInstanceCount += object.instances.length;
        }
      }
      const overlappingStaticNaturalIds = [...persistentStaticNaturalIds]
        .filter(stableId => activeStaticNaturalIds.has(stableId));
      const residentNaturalStableIds = new Set([...persistentTreePages.values()]
        .flatMap(page => page.stableIds));
      const persistentNaturalBucketUsage = Object.freeze([
        ...(persistentTreeGeneration?.canonicalBuckets.values?.() ?? []),
      ].map(bucket => Object.freeze({
        key: bucket.key,
        kind: parseNaturalLodBucket(bucket)?.kind ?? null,
        mode: parseNaturalLodBucket(bucket)?.mode ?? null,
        usedSlots: bucket.items.length,
        capacity: bucket.capacity ?? bucket.items.length,
      })).sort((left, right) => left.key.localeCompare(right.key)));
      const persistentNaturalTierPageCounts = {
        farOnly: 0,
        exact: persistentTreePages.size,
      };
      const persistentNaturalInstanceSlotCount = persistentNaturalBucketUsage.reduce(
        (sum, bucket) => sum + bucket.usedSlots,
        0,
      );
      const persistentNaturalOrphanStableIds = [
        ...(persistentTreeGeneration?.canonicalObjects.keys?.() ?? []),
      ].filter(stableId => !residentNaturalStableIds.has(stableId));
      const persistentNaturalOrphanSlotCount = [
        ...(persistentTreeGeneration?.canonicalBuckets.values?.() ?? []),
      ].reduce((sum, bucket) => sum + bucket.items.filter(item => (
        !residentNaturalStableIds.has(item.object.stableId)
      )).length, 0);
      const remoteAtmospheres = includeRemoteHorizonAtmospheres
        ? snapshotRemoteHorizonAtmospheres(activeGeneration)
        : emptyRemoteHorizonAtmospheres;
      const terrainSchedulerSnapshot = terrainScheduler.snapshot();
      const macroCoarseWorldSnapshot = enableMacroCoarseWorld
        ? Object.freeze({
          ...(macroCoarseWorldController?.snapshot() ?? { enabled: false }),
          presentation: macroCoarseWorldPresentation?.snapshot() ?? null,
          surfaceWindowCacheSize: macroSurfaceWindowCache.size,
          surfaceWindowQueryCount: macroSurfaceWindowQueryCount,
          surfaceWindowReuseCount: macroSurfaceWindowReuseCount,
          surfacePolicyBuildCount: macroSurfacePolicyBuildCount,
          surfaceWindowMaximumQueryMs: macroSurfaceWindowMaximumQueryMs,
          canonicalTreeDirectSupply: directCanonicalTreeSupply,
          canonicalTreePreparedCellCount: directCanonicalTreeCells.size,
          canonicalTreePreparedOwnerCount: directCanonicalTreeOwnerKeys.size,
          canonicalTreePreparedRecordCount: [...directCanonicalTreeCells.values()]
            .reduce((sum, cell) => sum + (cell.trees?.length ?? 0), 0),
          canonicalTreeResidentCellCount: [...persistentTreePages.entries()]
            .filter(([ownerKey, page]) => isDirectCanonicalTreePage(ownerKey, page)).length,
          canonicalTreePendingCellCount: [...pendingPersistentTreePages.entries()]
            .filter(([ownerKey, page]) => isDirectCanonicalTreePage(ownerKey, page)).length
            + [...pendingPersistentTreePublications.entries()]
              .filter(([ownerKey, pending]) => isDirectCanonicalTreePage(
                ownerKey,
                pending?.page,
              )).length,
        })
        : Object.freeze({ enabled: false });
      return Object.freeze({
        schemaVersion: 'w8-distant-presentation-snapshot-1',
        macroCoarseWorld: macroCoarseWorldSnapshot,
        terrainScheduler: terrainSchedulerSnapshot,
        terrainSliceCount: terrainSchedulerSnapshot.terrainSliceCount,
        terrainSliceCpuMs: terrainSchedulerSnapshot.terrainSliceCpuMs,
        terrainSliceP50Ms: terrainSchedulerSnapshot.terrainSliceP50Ms,
        terrainSliceP95Ms: terrainSchedulerSnapshot.terrainSliceP95Ms,
        terrainSliceMaxMs: terrainSchedulerSnapshot.terrainSliceMaxMs,
        terrainResumeWaitP50Ms: terrainSchedulerSnapshot.terrainResumeWaitP50Ms,
        terrainResumeWaitP95Ms: terrainSchedulerSnapshot.terrainResumeWaitP95Ms,
        terrainResumeWaitMaxMs: terrainSchedulerSnapshot.terrainResumeWaitMaxMs,
        terrainDeadlineMissCount: terrainSchedulerSnapshot.terrainDeadlineMissCount,
        terrainDeadlineMissMaxMs: terrainSchedulerSnapshot.terrainDeadlineMissMaxMs,
        terrainGenerationCpuMs: terrainSchedulerSnapshot.terrainGenerationCpuMs,
        terrainGenerationYieldWaitMs:
          terrainSchedulerSnapshot.terrainGenerationYieldWaitMs,
        terrainGenerationWallMs: terrainSchedulerSnapshot.terrainGenerationWallMs,
        presentationSchedulerTerrainSlices:
          terrainSchedulerSnapshot.presentationSchedulerTerrainSlices,
        presentationSchedulerNaturalSlices,
        presentationSchedulerRoadSlices,
        ...stats,
        ...(incrementalStaticTreePages ? {
          canonicalRecordCount:
            stats.canonicalBuildingRecordCount
            + persistentNaturalSummary.recordCount
            + stats.canonicalLandmarkRecordCount
            + stats.canonicalRoadRecordCount
            + stats.canonicalWorldDetailRecordCount
            + stats.remoteHorizonSyntheticBuildingCount
            + stats.remoteHorizonSyntheticLandmarkCount,
          canonicalFarObjectCount:
            stats.canonicalFarObjectCount + persistentNaturalSummary.farCount,
          canonicalMidObjectCount:
            stats.canonicalMidObjectCount + persistentNaturalSummary.midCount,
          canonicalNearObjectCount:
            stats.canonicalNearObjectCount + persistentNaturalSummary.nearCount,
          canonicalHiddenObjectCount:
            stats.canonicalHiddenObjectCount + persistentNaturalSummary.hiddenCount,
          canonicalDestroyedObjectCount:
            stats.canonicalDestroyedObjectCount
            + persistentNaturalSummary.destroyedCount,
          canonicalVegetationRecordCount:
            persistentNaturalSummary.vegetationCount,
          canonicalTreeRecordCount: persistentNaturalSummary.treeCount,
          canonicalShrubRecordCount: persistentNaturalSummary.shrubCount,
          canonicalGrassRecordCount: persistentNaturalSummary.grassCount,
          canonicalRockRecordCount: persistentNaturalSummary.rockCount,
          visibleCanonicalVegetationCount:
            persistentNaturalSummary.visibleVegetationCount,
          visibleCanonicalTreeCount: persistentNaturalSummary.visibleTreeCount,
          visibleCanonicalShrubCount: persistentNaturalSummary.visibleShrubCount,
          visibleCanonicalGrassCount: persistentNaturalSummary.visibleGrassCount,
          visibleCanonicalRockCount: persistentNaturalSummary.visibleRockCount,
          visibleCanonicalFullTreeCount: persistentNaturalSummary.visibleFullTreeCount,
          visibleCanonicalSilhouetteTreeCount:
            persistentNaturalSummary.visibleSilhouetteTreeCount,
          visibleCanonicalUltraTreeCount: persistentNaturalSummary.visibleUltraTreeCount,
          visibleCanonicalTreePartInstanceCount:
            persistentNaturalSummary.visibleTreePartInstanceCount,
          visibleCanonicalForestInstanceCount:
            persistentTreeStats.visibleCanonicalForestInstanceCount,
          visibleCanonicalAtmosphericInstanceCount:
            persistentTreeStats.visibleCanonicalAtmosphericInstanceCount,
          visibleCanonicalFarTreeInstanceCount:
            persistentTreeStats.visibleCanonicalFarTreeInstanceCount,
        } : {}),
        incrementalStaticTreePages,
        incrementalStaticNaturalPages: incrementalStaticTreePages,
        staticNaturalCoverageGeneration: persistentTreeCoverageGeneration,
        staticNaturalPlanRevision: persistentTreePlanRevision,
        staticNaturalCoverageApplyCount: persistentNaturalCoverageApplyCount,
        staticNaturalFrameAdvanceCount: persistentNaturalFrameAdvanceCount,
        staticNaturalCurrentPublishedOwnerCount: persistentTreePublishedOwners.size,
        staticNaturalResidentOwnerCount: persistentTreePages.size,
        staticNaturalPendingOwnerCount: pendingPersistentTreePages.size
          + pendingPersistentTreePublications.size
          + persistentTreeBuildQueuedCount,
        staticNaturalDisposeOwnerCount: persistentTreeDisposeOwners.length,
        staticNaturalDuplicatePageQueueCount: persistentTreeDuplicatePageQueueCount,
        staticNaturalStalePageDiscardCount: persistentTreeStalePageDiscardCount,
        staticNaturalMaximumAdmissionsPerFrame: persistentTreeMaximumAdmissionsPerFrame,
        staticNaturalFrameBudgetMs: STATIC_TREE_PAGE_FRAME_BUDGET_MS,
        staticTreeCoverageGeneration: persistentTreeCoverageGeneration,
        staticTreePlanRevision: persistentTreePlanRevision,
        staticTreePublishedOwnerCount: persistentTreePublishedOwnerCount,
        staticTreeCurrentPublishedOwnerCount: persistentTreePublishedOwners.size,
        staticTreeResidentOwnerCount: persistentTreePages.size,
        staticTreeCoarsePrewarmResidentOwnerCount,
        staticTreeCoarsePrewarmPublishedOwnerCount,
        staticTreePreparePendingOwnerCount: pendingPersistentTreePages.size,
        staticTreeBuildInFlightCount: persistentTreeBuildActiveCount,
        staticTreeBuildQueuedOwnerCount: persistentTreeBuildQueuedCount,
        staticTreePublicationPendingOwnerCount: pendingPersistentTreePublications.size,
        staticTreePendingOwnerCount: pendingPersistentTreePages.size
          + pendingPersistentTreePublications.size
          + persistentTreeBuildQueuedCount,
        staticTreeDisposeOwnerCount: persistentTreeDisposeOwners.length,
        staticTreeMatrixUpdateCount: persistentTreeMatrixUpdateCount,
        staticTreeAttributeUpdateCount: persistentTreeAttributeUpdateCount,
        staticTreeMaximumSliceMs: persistentTreeMaximumSliceMs,
        staticTreeLastPublicationWaitMs: persistentTreeLastPublicationWaitMs,
        staticTreeMaximumPublicationWaitMs: persistentTreeMaximumPublicationWaitMs,
        staticTreeOwnerBuildCount: persistentTreeOwnerBuildCount,
        staticTreeFarOnlyOwnerBuildCount: 0,
        staticTreeExactOwnerBuildCount: persistentTreeExactOwnerBuildCount,
        staticTreePromotionOwnerBuildCount: 0,
        staticTreeFarOnlyResidentOwnerCount: persistentNaturalTierPageCounts.farOnly,
        staticTreeExactResidentOwnerCount: persistentNaturalTierPageCounts.exact,
        staticTreeCanonicalRecordCount: persistentNaturalSummary.treeCount,
        staticTreeInstanceSlotCount: persistentNaturalInstanceSlotCount,
        staticTreePromotionPendingOwnerCount: 0,
        staticTreePromotionRequestCount: 0,
        staticTreePromotionReuseCount: 0,
        staticTreePromotionDiscardCount: 0,
        staticNaturalDetailAvailableOwnerCount: persistentNaturalDetailAvailableOwners.size,
        staticTreeLightweightOwnerPublicationCount:
          persistentTreeLightweightOwnerPublicationCount,
        staticTreeSmallFarOwnerPublicationCount: persistentTreeSmallFarOwnerPublicationCount,
        staticTreeSmallFarPageSlotLimit: STATIC_NATURAL_SMALL_PAGE_SLOT_LIMIT,
        staticTreeSmallFarOwnerPublicationLimit:
          STATIC_NATURAL_PUBLICATION_BUDGET_UNITS / STATIC_NATURAL_SMALL_PUBLICATION_COST,
        staticTreeOwnerReuseCount: persistentTreeOwnerReuseCount,
        staticTreeOwnerRebuildCount: persistentTreeOwnerRebuildCount,
        staticTreeOwnerDisposeCount: persistentTreeOwnerDisposeCount,
        staticTreeDuplicatePageQueueCount: persistentTreeDuplicatePageQueueCount,
        staticTreeStalePageDiscardCount: persistentTreeStalePageDiscardCount,
        staticTreeOlderCoveragePageCount: persistentTreeOlderCoveragePageCount,
        staticTreeRootResetCount: persistentTreeRootResetCount,
        staticTreeMaximumVisibilitySliceMs: persistentTreeMaximumVisibilitySliceMs,
        naturalVisibilityFrameBudgetMs: NATURAL_VISIBILITY_FRAME_BUDGET_MS,
        naturalVisibilitySequence: persistentNaturalVisibilitySequence,
        naturalVisibilityCompletedSequence: persistentNaturalVisibilityCompletedSequence,
        naturalVisibilityQueueLength: persistentNaturalVisibilityQueueLength(
          persistentNaturalVisibilityJob,
        ),
        naturalVisibilityMaximumQueueLength: persistentNaturalVisibilityMaximumQueueLength,
        naturalVisibilityMaximumSliceMs: persistentNaturalVisibilityMaximumSliceMs,
        naturalVisibilityMaximumUnitMs: persistentNaturalVisibilityMaximumUnitMs,
        naturalVisibilityMaximumCoverageWaitFrames:
          persistentNaturalVisibilityMaximumCoverageWaitFrames,
        naturalVisibilityMaximumEnteringWaitFrames:
          persistentNaturalVisibilityMaximumEnteringWaitFrames,
        naturalVisibilityMaximumLeavingWaitFrames:
          persistentNaturalVisibilityMaximumLeavingWaitFrames,
        naturalVisibilitySupersededDiscardCount:
          persistentNaturalVisibilitySupersededDiscardCount,
        naturalVisibilityStaleDiscardCount: persistentNaturalVisibilityStaleDiscardCount,
        naturalVisibilityStaleApplicationCount:
          persistentNaturalVisibilityStaleApplicationCount,
        naturalVisibilityStarvationCount: persistentNaturalVisibilityStarvationCount,
        naturalVisibilityCoverageGapCount: persistentNaturalVisibilityCoverageGapCount,
        naturalVisibilityBaselinePending:
          persistentNaturalVisibilityJob?.baseline === true,
        naturalVisibilityBaselineComplete:
          persistentTreeGeneration?.visibilityBaselineComplete === true,
        naturalVisibilityBaselineStartedCount:
          persistentNaturalVisibilityBaselineStartedCount,
        naturalVisibilityBaselineCompletedCount:
          persistentNaturalVisibilityBaselineCompletedCount,
        naturalVisibilityBaselineSynchronousScanCount:
          persistentNaturalVisibilityBaselineSynchronousScanCount,
        naturalVisibilityRetainedGenerationPending:
          persistentNaturalVisibilityRetainedGeneration !== null,
        naturalVisibilityRetainedGenerationReleaseCount:
          persistentNaturalVisibilityRetainedGenerationReleaseCount,
        naturalVisibilityCoverageBarrierLength:
          persistentNaturalVisibilityCoverageBarrier?.stableIds.size ?? 0,
        naturalVisibilityCoverageBarrierReleasedCount:
          persistentNaturalVisibilityCoverageBarrierReleasedCount,
        naturalVisibilityCoverageBarrierSupersededCount:
          persistentNaturalVisibilityCoverageBarrierSupersededCount,
        naturalVisibilityCoverageBarrierSupersededDiscardCount:
          persistentNaturalVisibilityCoverageBarrierSupersededDiscardCount,
        naturalVisibilityCoverageBarrierMaximumLength:
          persistentNaturalVisibilityCoverageBarrierMaximumLength,
        naturalVisibilityCoverageBarrierMaximumHeldFrames:
          persistentNaturalVisibilityCoverageBarrierMaximumHeldFrames,
        staticTreeMaximumDisposeSliceMs: persistentTreeMaximumDisposeSliceMs,
        staticTreeAllocatedObjectCount: persistentTreeAllocatedObjectCount,
        staticTreeAllocatedInstanceCount: persistentTreeAllocatedInstanceCount,
        staticTreeAllocatedBucketCount: persistentTreeAllocatedBucketCount,
        staticTreeBufferRangeUpdateCount: persistentTreeBufferRangeUpdateCount,
        staticTreeBufferUploadByteCount: persistentTreeBufferUploadByteCount,
        staticTreeOwnerAdmissionLimit: persistentTreeLastBuildQueueTarget,
        staticTreeOwnerAdmissionMaximum: NATURAL_OWNER_BUILD_QUEUE_MAXIMUM,
        staticTreeMaximumBuildQueueTarget: persistentTreeMaximumBuildQueueTarget,
        staticTreeOwnerDisposeLimit: STATIC_TREE_OWNER_DISPOSE_LIMIT,
        staticTreeOwnerPublicationLimit:
          STATIC_NATURAL_PUBLICATION_BUDGET_UNITS / STATIC_NATURAL_HEAVY_PUBLICATION_COST,
        staticTreeFrameBudgetMs: STATIC_TREE_PAGE_FRAME_BUDGET_MS,
        staticTreeMaximumAdmissionsPerFrame: persistentTreeMaximumAdmissionsPerFrame,
        staticTreeAdmissionLimitViolationCount: persistentTreeAdmissionLimitViolationCount,
        staticTreeCompactionMoveCount: persistentTreeCompactionMoveCount,
        staticTreeVisibilityMatrixInvalidationCount:
          persistentTreeVisibilityMatrixInvalidationCount,
        staticTreeSubmissionScanCount: persistentCoarseTreeSubmissionScanCount,
        staticTreeSubmissionObjectScanCount:
          persistentCoarseTreeSubmissionObjectScanCount,
        staticTreeSubmissionToggleCount: persistentCoarseTreeSubmissionToggleCount,
        staticTreeSubmissionEarlyOutCount: persistentCoarseTreeSubmissionEarlyOutCount,
        markFirstDrawCanonicalObjectScanCount,
        markFirstDrawReceiptEarlyOutCount,
        staticTreeFrameSampleCapacity: persistentTreeFrameSampleCapacity,
        staticTreeFrameSamples: Object.freeze(persistentTreeFrameSamples.map(sample => (
          Object.freeze({ ...sample })
        ))),
        staticNaturalActiveLegacyRecordCount: activeStaticNaturalIds.size,
        staticNaturalPersistentRecordCount: persistentStaticNaturalIds.size,
        staticNaturalOverlappingStableIdCount: overlappingStaticNaturalIds.length,
        staticNaturalBucketUsage: persistentNaturalBucketUsage,
        staticNaturalOrphanObjectCount: persistentNaturalOrphanStableIds.length,
        staticNaturalOrphanSlotCount: persistentNaturalOrphanSlotCount,
        runtimePresentationFrameBudgetMs: RUNTIME_PRESENTATION_FRAME_BUDGET_MS,
        roadPresentationFrameBudgetMs: ROAD_PRESENTATION_FRAME_BUDGET_MS,
        roadPresentationQueueLength:
          settlementRoadWorkRemaining(pendingRuntimePresentationHandoff?.bucketWork?.roadWork)
          + (pendingRuntimePresentationHandoff?.coverageBarrier?.roadWorks ?? [])
            .reduce((total, work) => total + settlementRoadWorkRemaining(work), 0),
        roadPresentationMaximumQueueLength,
        roadPresentationMaximumWaitFrames,
        roadPresentationMaximumSliceMs,
        roadPresentationMaximumUnitMs,
        roadPresentationOwnerWorkCount,
        roadPresentationBucketComposeCount,
        roadPresentationRecordComposeCount,
        roadPresentationSupersededDiscardCount,
        roadPresentationStalePublishCount,
        roadPresentationStarvationCount,
        roadPresentationOrphanGeometryCount,
        roadPresentationDoubleDisposeCount,
        roadPriorityPublicationCount,
        roadPriorityReplacementCount,
        roadPriorityRemovalCount,
        roadPriorityPublishedEpoch: publishedRoadGeneration?.epoch ?? null,
        runtimePresentationHandoffPending: pendingRuntimePresentationHandoff !== null,
        runtimePresentationHandoffStage: pendingRuntimePresentationHandoff?.stage ?? null,
        runtimePresentationHandoffSequence,
        runtimePresentationHandoffRequestedCount,
        runtimePresentationHandoffCompletedCount,
        runtimePresentationHandoffSupersededCount,
        runtimePresentationHandoffLocalTerrainCount,
        runtimePresentationHandoffMatrixUpdateCount,
        runtimePresentationHandoffBufferUpdateCount,
        runtimePresentationHandoffDisposeCount,
        runtimePresentationHandoffMaximumSliceMs,
        runtimePresentationHandoffMaximumMatrixUpdatesPerFrame,
        runtimePresentationHandoffMaximumBufferUpdatesPerFrame,
        runtimePresentationHandoffMaximumDisposePerFrame,
        runtimePresentationCoverageBarrierPending: Boolean(
          pendingRuntimePresentationHandoff?.coverageBarrier?.released === false,
        ),
        runtimePresentationCoverageBarrierHeldOwnerKeys: Object.freeze(sortedKeyList(
          pendingRuntimePresentationHandoff?.coverageBarrier?.released === false
            ? pendingRuntimePresentationHandoff.coverageBarrier.ownerKeys : [],
        )),
        runtimePresentationCoverageBarrierRequestedCount,
        runtimePresentationCoverageBarrierReleasedCount,
        runtimePresentationCoverageBarrierSupersededCount,
        runtimePresentationCoverageBarrierRetryCount,
        runtimePresentationCoverageBarrierMaximumHeldMs,
        runtimePresentationCoverageBarrierBlankFrameCount,
        runtimePresentationCoverageBarrierDuplicateFrameCount,
        runtimePresentationCoverageBarrierLastRelease,
        runtimePresentationHandoffDirtyBucketCount:
          pendingRuntimePresentationHandoff?.dirtyBuckets.length ?? 0,
        runtimePresentationHandoffDirtyBucketIndex:
          pendingRuntimePresentationHandoff?.dirtyBucketIndex ?? 0,
        deferredGenerationDisposeCount: deferredGenerationDisposals.length,
        midgroundChunkCount: localTerrainStats.midgroundChunkCount,
        midgroundSampleCount: localTerrainStats.midgroundSampleCount,
        midgroundNewSampleCount: localTerrainStats.midgroundNewSampleCount,
        midgroundReusedSampleCount: localTerrainStats.midgroundReusedSampleCount,
        midgroundDiscardedSampleCount: localTerrainStats.midgroundDiscardedSampleCount,
        midgroundNewOwnerCount: localTerrainStats.midgroundNewOwnerCount,
        midgroundReusedOwnerCount: localTerrainStats.midgroundReusedOwnerCount,
        midgroundDiscardedOwnerCount: localTerrainStats.midgroundDiscardedOwnerCount,
        midgroundSampleReuseRatio: localTerrainStats.midgroundSampleReuseRatio,
        midgroundGeometryAllocationCount: localTerrainStats.midgroundGeometryAllocationCount,
        midgroundGeometryReuseCount: localTerrainStats.midgroundGeometryReuseCount,
        terrainPublicationScope: localTerrainStats.publicationScope ?? null,
        terrainStripRingPublicationCount,
        terrainInitialRootPublicationCount,
        clipmapMeshCount: localTerrainStats.clipmapMeshCount,
        maximumInnerBoundaryErrorMeters: localTerrainStats.maximumInnerBoundaryErrorMeters,
        maximumInnerBoundaryColorDifference: localTerrainStats.maximumInnerBoundaryColorDifference,
        clipmapDeterministicChecksum: localTerrainStats.clipmapDeterministicChecksum,
        clipmapSampleCount: localTerrainStats.clipmapSampleCount,
        clipmapNewlySampledCount: localTerrainStats.clipmapNewlySampledCount,
        clipmapReusedSampleCount: localTerrainStats.clipmapReusedSampleCount,
        clipmapSampleReuseRatio: localTerrainStats.clipmapSampleReuseRatio,
        clipmapSurfaceRefreshCount: localTerrainStats.clipmapSurfaceRefreshCount,
        clipmapSourceSlotReuseCount: localTerrainStats.clipmapSourceSlotReuseCount,
        clipmapCacheReuseCount: localTerrainStats.clipmapCacheReuseCount,
        clipmapVertexWriteCount: localTerrainStats.clipmapVertexWriteCount,
        clipmapVertexComponentWriteCount: localTerrainStats.clipmapVertexComponentWriteCount,
        clipmapDirtySlotCount: localTerrainStats.clipmapDirtySlotCount,
        clipmapUpdateRangeCount: localTerrainStats.clipmapUpdateRangeCount,
        clipmapBufferUploadBytes: localTerrainStats.clipmapBufferUploadBytes,
        clipmapGeometryAllocationCount: localTerrainStats.clipmapGeometryAllocationCount,
        clipmapIndexAllocationCount: localTerrainStats.clipmapIndexAllocationCount,
        clipmapBuildDurationMs: localTerrainStats.clipmapBuildDurationMs,
        clipmapExtentMeters: activeLocalTerrainGeneration?.renderDistancePolicy
          ?.terrainCoverageDistanceMeters
          ?? resolveW8RenderDistancePolicy().terrainCoverageDistanceMeters,
        renderDistancePreset: activeGeneration?.renderDistancePreset
          ?? activeLocalTerrainGeneration?.renderDistancePreset
          ?? W8_DEFAULT_RENDER_DISTANCE_PRESET,
        distantRenderDistancePreset: activeGeneration?.renderDistancePreset ?? null,
        localTerrainRenderDistancePreset:
          activeLocalTerrainGeneration?.renderDistancePreset ?? null,
        staticNaturalRenderDistancePreset:
          persistentTreeGeneration?.renderDistancePreset ?? null,
        preparedDistantRenderDistancePreset:
          preparedRenderDistanceDistant?.generation?.renderDistancePreset ?? null,
        preparedLocalTerrainRenderDistancePreset:
          preparedRenderDistanceLocalTerrain?.generation?.renderDistancePreset ?? null,
        stagedStaticNaturalRenderDistancePreset:
          stagedPersistentNaturalRenderDistancePreset,
        buildingPublicationSource,
        settlementRoadPublicationSource,
        settlementMetadataPublicationSource,
        settlementPublicationPlanId,
        settlementPublicationRevision,
        settlementShadowSnapshotRequestCount,
        settlementShadowSnapshotReuseCount,
        settlementShadowSnapshotCount,
        settlementShadowCanonicalObjectScanCount,
        settlementShadowStableIdMaterializationCount,
        settlementStreamingSnapshotCache: settlementStreamingSnapshotCache.snapshot(),
        quality: activeGeneration?.quality ?? null,
        distantTownProxyCount: 0,
        distantNaturalProxyLimit: DISTANT_ROCK_PROXY_LIMIT,
        distantRockProxyLimit: DISTANT_ROCK_PROXY_LIMIT,
        distantTownProxyLimit: 0,
        visibilityMeters: activeGeneration?.visibilityMeters ?? null,
        roadVisibilityMeters: activeGeneration?.roadVisibilityMeters ?? null,
        naturalVisibilityMeters: activeGeneration?.naturalVisibilityMeters ?? null,
        canonicalFarTreeVisibilityMeters:
          activeGeneration?.canonicalFarTreeVisibilityMeters ?? null,
        naturalQueryRadius: activeGeneration?.naturalQueryRadius ?? null,
        queryRadius: activeGeneration?.queryRadius ?? null,
        roadQueryRadius: activeGeneration?.roadQueryRadius ?? null,
        queryCandidateCount: activeGeneration?.queryCandidateCount ?? 0,
        queryTemplateSuccessCount: activeGeneration?.queryTemplateSuccessCount ?? 0,
        queryRemoteCandidateCount: activeGeneration?.queryRemoteCandidateCount ?? 0,
        queryRemoteSelectedCount: activeGeneration?.queryRemoteSelectedCount ?? 0,
        queryRemoteHorizonMaterializedCount:
          activeGeneration?.queryRemoteHorizonMaterializedCount ?? 0,
        queryRemoteSettlementLimit: activeGeneration?.queryRemoteSettlementLimit ?? 0,
        queryRemoteBuildingLimitPerSettlement:
          activeGeneration?.queryRemoteBuildingLimitPerSettlement ?? 0,
        queryRemotePartLimit: activeGeneration?.queryRemotePartLimit ?? 0,
        queryRemoteHorizonOwnerChunkCount:
          activeGeneration?.queryRemoteHorizonOwnerChunkCount ?? 0,
        remoteHorizonStartMeters: activeGeneration?.remoteHorizonStartMeters ?? null,
        remoteHorizonFadeStartMeters: activeGeneration?.remoteHorizonFadeStartMeters ?? null,
        remoteHorizonFadeEndMeters: activeGeneration?.remoteHorizonFadeEndMeters ?? null,
        remoteHorizonHiddenDistanceMeters:
          activeGeneration?.remoteHorizonHiddenDistanceMeters ?? null,
        remoteHorizonFogEnabled: activeGeneration?.remoteHorizonFogEnabled ?? null,
        remoteHorizonAtmosphereMode:
          activeGeneration?.remoteHorizonAtmosphereMode ?? null,
        remoteHorizonFogIntegrationEndMeters:
          activeGeneration?.remoteHorizonFogIntegrationEndMeters ?? null,
        remoteHorizonSettlementAtmospheres: remoteAtmospheres.settlements,
        remoteHorizonBuildingAtmospheres: remoteAtmospheres.buildings,
        remoteHorizonAtmosphereShaderEnabled: Boolean(
          activeGeneration?.remoteHorizonSilhouetteMaterial
            ?.userData?.remoteBuildingAtmosphere,
        ),
        remoteHorizonPlayerLocalXZ: activeGeneration?.remoteHorizonSilhouetteMaterial
          ? Object.freeze({
            ...activeGeneration.remoteHorizonSilhouetteMaterial
              .userData.remoteAtmosphereUniforms.w8RemotePlayerLocalXZ.value,
          })
          : null,
        remoteHorizonMaterialCount:
          activeGeneration?.remoteHorizonSilhouetteMaterial ? 1 : 0,
        remoteHorizonMeshCount: [...(activeGeneration?.canonicalBuckets?.values() ?? [])]
          .filter(bucket => bucket.name.startsWith('remote-horizon')).length,
        remoteHorizonVisibleMeshCount: [...(activeGeneration?.canonicalBuckets?.values() ?? [])]
          .filter(bucket => bucket.name.startsWith('remote-horizon') && bucket.mesh?.count > 0)
          .length,
        localBuildingHandoffMaterialCount: [...(activeGeneration?.ownedMaterials ?? [])]
          .filter(material => material.userData?.localBuildingHandoff === true).length,
        localBuildingHandoffMeshCount: [...(activeGeneration?.canonicalBuckets?.values() ?? [])]
          .filter(bucket => bucket.localHandoffOpacityAttribute).length,
        localBuildingHandoffVisibleMeshCount:
          [...(activeGeneration?.canonicalBuckets?.values() ?? [])]
            .filter(bucket => bucket.localHandoffOpacityAttribute && bucket.mesh?.count > 0)
            .length,
        naturalLodShaderEnabled: Boolean(naturalDiagnosticGeneration?.naturalLodMaterials?.size)
          && [...naturalDiagnosticGeneration.naturalLodMaterials.values()]
            .every(material => material.userData?.naturalLod === true),
        naturalLodMaterialCount: naturalDiagnosticGeneration?.naturalLodMaterials?.size ?? 0,
        naturalLodMeshCount: [...(naturalDiagnosticGeneration?.canonicalBuckets?.values() ?? [])]
          .filter(bucket => bucket.naturalLod).length,
        naturalLodVisibleMeshCount: [...(naturalDiagnosticGeneration?.canonicalBuckets?.values() ?? [])]
          .filter(bucket => bucket.naturalLod && bucket.mesh?.count > 0).length,
        naturalLodGeometryCount: [...(naturalDiagnosticGeneration?.canonicalBuckets?.values() ?? [])]
          .filter(bucket => bucket.naturalLod && bucket.mesh?.geometry).length,
        naturalLodInstanceCapacity: [...(naturalDiagnosticGeneration?.canonicalBuckets?.values() ?? [])]
          .filter(bucket => bucket.naturalLod)
          .reduce((sum, bucket) => sum + bucket.items.length, 0),
        naturalLodVisibleInstanceCount:
          [...(naturalDiagnosticGeneration?.canonicalBuckets?.values() ?? [])]
          .filter(bucket => bucket.naturalLod)
          .reduce((sum, bucket) => sum + (
            bucket.mesh?.userData?.canonicalOpacities?.filter(opacity => opacity > 0).length
              ?? 0
          ), 0),
        naturalLodDrawCallEquivalent:
          [...(naturalDiagnosticGeneration?.canonicalBuckets?.values() ?? [])]
          .filter(bucket => bucket.naturalLod && bucket.mesh?.count > 0).length,
        canonicalFarTreeMaterialCount:
          [...(naturalDiagnosticGeneration?.naturalLodMaterials?.values() ?? [])]
          .filter(material => material.userData?.canonicalCoarseTree === true).length,
        canonicalFarTreeMeshCount:
          [...(naturalDiagnosticGeneration?.canonicalBuckets?.values() ?? [])]
          .filter(isPersistentCoarseTreeBucket).length,
        canonicalFarTreeVisibleMeshCount:
          [...(naturalDiagnosticGeneration?.canonicalBuckets?.values() ?? [])]
            .filter(bucket => isPersistentCoarseTreeBucket(bucket)
              && bucket.mesh?.count > 0).length,
        canonicalFarTreeDrawCallEquivalent:
          [...(naturalDiagnosticGeneration?.canonicalBuckets?.values() ?? [])]
            .filter(bucket => isPersistentCoarseTreeBucket(bucket)
              && bucket.mesh?.count > 0)
            .reduce((sum, bucket) => sum + (
              Array.isArray(bucket.mesh?.material)
                ? Math.max(1, bucket.mesh.geometry?.groups?.length ?? 0) : 1
            ), 0),
        canonicalFarTreeGeometryCount: new Set(
          [...(naturalDiagnosticGeneration?.canonicalBuckets?.values() ?? [])]
            .filter(isPersistentCoarseTreeBucket)
            .map(bucket => bucket.mesh?.geometry)
            .filter(Boolean),
        ).size,
        canonicalFarTreeTriangleCount:
          [...(naturalDiagnosticGeneration?.canonicalBuckets?.values() ?? [])]
            .filter(isPersistentCoarseTreeBucket)
            .reduce((sum, bucket) => sum + (
              (bucket.mesh?.count ?? 0)
                * (bucket.mesh?.geometry?.userData?.canonicalFarTreeTriangleCount ?? 0)
            ), 0),
        canonicalFarTreeInstanceCapacity:
          [...(naturalDiagnosticGeneration?.canonicalBuckets?.values() ?? [])]
            .filter(isPersistentCoarseTreeBucket)
            .reduce((sum, bucket) => sum + bucket.items.length, 0),
        canonicalFarTreeVisibleInstanceCount:
          [...(naturalDiagnosticGeneration?.canonicalBuckets?.values() ?? [])]
            .filter(isPersistentCoarseTreeBucket)
            .reduce((sum, bucket) => sum + (bucket.mesh?.count ?? 0), 0),
        naturalLodReveal: naturalDiagnosticGeneration?.naturalReveal ?? 1,
        naturalLodRevealInnerMeters: naturalDiagnosticGeneration?.naturalRevealInnerMeters ?? 0,
        naturalLodRevealPreservedStableIdCount: 0,
        naturalLodRevealDurationMs: NATURAL_STREAM_REVEAL_MS,
        naturalLodPlayerLocalXZ: (() => {
          const material = naturalDiagnosticGeneration?.naturalLodMaterials
            ?.values?.().next?.().value;
          const value = material?.userData?.naturalLodUniforms
            ?.w8NaturalPlayerLocalXZ?.value;
          return value ? Object.freeze({ ...value }) : null;
        })(),
        settlementMetadataQueryDistanceMeters:
          activeGeneration?.settlementMetadataQueryDistanceMeters ?? null,
        queryOwnerChunkCount: activeGeneration?.queryOwnerChunkCount ?? 0,
        queryOwnerChunkKeys: Object.freeze([
          ...(activeGeneration?.queryOwnerChunkKeys ?? []),
        ]),
        queryNaturalOwnerChunkCount: activeGeneration?.queryNaturalOwnerChunkCount ?? 0,
        queryNaturalOwnerChunkKeys: Object.freeze([
          ...(activeGeneration?.queryNaturalOwnerChunkKeys ?? []),
        ]),
        staticPublicationTicketCount:
          activeGeneration?.staticPublicationTickets?.length ?? 0,
        queryInnerNaturalOwnerChunkCount:
          activeGeneration?.queryInnerNaturalOwnerChunkCount ?? 0,
        queryUltraOwnerChunkCount: activeGeneration?.queryUltraOwnerChunkCount ?? 0,
        queryUltraOnlyOwnerChunkCount:
          activeGeneration?.queryUltraOnlyOwnerChunkCount ?? 0,
        queryUltraOwnerChunkKeys: Object.freeze([
          ...(activeGeneration?.queryUltraOwnerChunkKeys ?? []),
        ]),
        queryBuildingOwnerChunkCount: activeGeneration?.queryBuildingOwnerChunkCount ?? 0,
        queryBuildingOwnerChunkKeys: Object.freeze([
          ...(activeGeneration?.queryBuildingOwnerChunkKeys ?? []),
        ]),
        queryRoadOwnerChunkCount: activeGeneration?.queryRoadOwnerChunkCount ?? 0,
        queryRoadOwnerChunkKeys: Object.freeze([
          ...(activeGeneration?.queryRoadOwnerChunkKeys ?? []),
        ]),
        queryExcludedActiveNaturalOwnerCount:
          activeGeneration?.queryExcludedActiveNaturalOwnerCount ?? 0,
        queryNaturalCandidateCount: activeGeneration?.queryNaturalCandidateCount ?? 0,
        queryFarOwnerChunkCacheHits: activeGeneration?.queryFarOwnerChunkCacheHits ?? 0,
        queryFarOwnerChunkCacheMisses: activeGeneration?.queryFarOwnerChunkCacheMisses ?? 0,
        queryFarOwnerChunkCacheEvictions: activeGeneration?.queryFarOwnerChunkCacheEvictions ?? 0,
        queryUltraOwnerChunkCacheHits: activeGeneration?.queryUltraOwnerChunkCacheHits ?? 0,
        queryUltraOwnerChunkCacheMisses: activeGeneration?.queryUltraOwnerChunkCacheMisses ?? 0,
        queryUltraOwnerChunkCacheEvictions: activeGeneration?.queryUltraOwnerChunkCacheEvictions ?? 0,
        innerWarmDurationMs: activeGeneration?.innerWarmDurationMs ?? 0,
        ultraWarmDurationMs: activeGeneration?.ultraWarmDurationMs ?? 0,
        queryPreparationDurationMs: activeGeneration?.queryPreparationDurationMs ?? 0,
        templateResolutionDurationMs: activeGeneration?.templateResolutionDurationMs ?? 0,
        syncDurationMs: activeGeneration?.syncDurationMs ?? 0,
        rootSwapDurationMs: activeGeneration?.rootSwapDurationMs ?? 0,
        presentationSliceBudgetMs: PRESENTATION_SLICE_BUDGET_MS,
        terrainPresentationStagingSliceBudgetMs:
          TERRAIN_PRESENTATION_STAGING_SLICE_BUDGET_MS,
        farLastMaximumSliceMs,
        farLastSliceCount,
        queryCanonicalChunkSuccessCount:
          activeGeneration?.queryCanonicalChunkSuccessCount ?? 0,
        querySettlementFeatureCount: activeGeneration?.querySettlementFeatureCount ?? 0,
        queryMajorRoadFeatureCount: activeGeneration?.queryMajorRoadFeatureCount ?? 0,
        queryLandmarkCount: activeGeneration?.queryLandmarkCount ?? 0,
        activeLocalSettlementId: activeGeneration?.activeLocalSettlementId ?? null,
        additionalLocalSettlementIds: Object.freeze([
          ...(activeGeneration?.additionalLocalSettlementIds ?? []),
        ]),
        localSettlementIds: Object.freeze(sortedKeyList(
          activeGeneration?.localSettlementIds ?? [],
        )),
        localSettlementLimit: activeGeneration?.localSettlementLimit ?? null,
        settlementSelections: includeSettlementSelectionDetails
          ? snapshotSettlementSelections(activeGeneration)
          : Object.freeze([]),
        activeLocalSettlementNearVisible: activeGeneration?.activeLocalSettlementId
          ? activeGeneration.nearVisibleSettlementIds.has(
            activeGeneration.activeLocalSettlementId,
          )
          : false,
        distantVisibleStableIdCount: activeGeneration?.distantVisibleStableIds?.size ?? 0,
        templateCacheSize: templateCache.size,
        templateCacheCapacity: TEMPLATE_CACHE_CAPACITY,
        farOwnerChunkCacheSize: farOwnerChunkCache.size,
        farOwnerChunkCacheCapacity: FAR_OWNER_CHUNK_CACHE_CAPACITY,
        farOwnerChunkCacheHits,
        farOwnerChunkCacheMisses,
        farOwnerChunkCacheEvictions,
        ultraOwnerChunkCacheSize: 0,
        ultraOwnerChunkCacheCapacity: 0,
        ultraOwnerChunkCacheHits: 0,
        ultraOwnerChunkCacheMisses: 0,
        ultraOwnerChunkCacheEvictions: 0,
        treeLodDiagnosticsEnabled,
        queryConcurrencyLimit: CANONICAL_QUERY_CONCURRENCY,
        maximumObservedQueryConcurrency,
        runtimeTransitionGeneration:
          committedRuntimeTransitionContract?.generation ?? null,
        runtimeCoverageSignature:
          committedRuntimeTransitionContract?.coverageSignature ?? null,
        localTerrainTransitionGeneration:
          activeLocalTerrainGeneration?.transitionContract?.generation ?? null,
        localTerrainCoverageSignature:
          activeLocalTerrainGeneration?.transitionContract?.coverageSignature ?? null,
        farTransitionGeneration:
          activeGeneration?.transitionContract?.generation ?? null,
        farCoverageSignature:
          activeGeneration?.transitionContract?.coverageSignature ?? null,
        presentationCoverageAligned: Boolean(
          committedRuntimeTransitionContract
          && activeLocalTerrainGeneration?.transitionContract
          && activeGeneration?.transitionContract
          && committedRuntimeTransitionContract.coverageSignature
            === activeLocalTerrainGeneration.transitionContract.coverageSignature
          && committedRuntimeTransitionContract.coverageSignature
            === activeGeneration.transitionContract.coverageSignature
          && committedRuntimeTransitionContract.generation
            === activeLocalTerrainGeneration.transitionContract.generation
          && committedRuntimeTransitionContract.generation
            === activeGeneration.transitionContract.generation
        ),
        syncEpoch,
        committedEpoch,
        staleEpochDiscardCount,
        committedRenderOrigin,
        staleRenderOriginRejectCount,
        farSyncPending: pendingFarSyncEpochs.size > 0,
        farSyncPendingCount: pendingFarSyncEpochs.size,
        distantPersistentPublicationPending: pendingDistantPublication !== null,
        distantPersistentPublicationBacklog:
          pendingDistantPublication?.queue.length ?? 0,
        distantPersistentLiveMeshCount: liveDistantEntries.size,
        distantPersistentPublicationCount,
        distantPersistentReusedMeshCount,
        distantPersistentCreatedMeshCount,
        distantPersistentNewCanonicalMeshCount,
        distantPersistentNewAuxiliaryMeshCount,
        distantPersistentRemovedMeshCount,
        distantPersistentUploadByteCount,
        distantPersistentMaximumUploadBytesPerFrame,
        distantPersistentUploadBudgetBytes: DISTANT_PERSISTENT_UPLOAD_BUDGET_BYTES,
        distantPersistentBoundsRecalculationCount,
        distantPersistentMatrixUpdateCount,
        distantPersistentMaximumMatrixUpdatesPerFrame,
        distantPersistentBufferUpdateCount,
        distantPersistentMaximumBufferUpdatesPerFrame,
        distantPersistentMaximumMeshAdmissionsPerFrame,
        distantPersistentMeshAdmissionLimit: DISTANT_PERSISTENT_MESH_ADMISSION_LIMIT,
        distantPersistentAdmissionLimitViolationCount,
        distantPersistentOverBudgetUploadCount,
        distantPersistentMaximumSliceMs,
        localTerrainSyncEpoch,
        committedLocalTerrainEpoch,
        localTerrainLastRequestedEpoch,
        localTerrainCommitCount,
        localTerrainRejectionCount,
        localTerrainStaleDiscardCount,
        localTerrainCoverageCenter: activeLocalTerrainGeneration ? Object.freeze({
          chunkX: activeLocalTerrainGeneration.centerChunkX,
          chunkZ: activeLocalTerrainGeneration.centerChunkZ,
        }) : null,
        localTerrainActiveKeyCount: localTerrainLastActiveKeyCount,
        localTerrainResolvedChunkCount: localTerrainLastResolvedChunkCount,
        localTerrainRenderedKeyCount: localTerrainLastRenderedKeyCount,
        localTerrainMidgroundOwnerCount: localTerrainLastMidgroundOwnerCount,
        localTerrainMidgroundOwnerKeys: Object.freeze(sortedKeyList(
          activeLocalTerrainGeneration?.midgroundOwnerKeys ?? [],
        )),
        localTerrainHandoffOwnerCount:
          activeLocalTerrainGeneration?.currentVisibleMidgroundOwnerKeys?.size ?? 0,
        localTerrainHandoffOwnerKeys: Object.freeze(sortedKeyList(
          activeLocalTerrainGeneration?.currentVisibleMidgroundOwnerKeys ?? [],
        )),
        localTerrainStoredOwnerCount:
          activeLocalTerrainGeneration?.localTerrainMesh?.userData?.ownerKeys?.length ?? 0,
        localTerrainMissingOwnerKeys: localTerrainLastMissingOwnerKeys,
        localTerrainLastRejectionReason,
        localTerrainLastSyncDurationMs,
        localTerrainLastRootSwapDurationMs,
        localTerrainLastMaximumSliceMs,
        localTerrainLastSliceCount,
        activeLocalTerrainRootId: activeLocalTerrainGeneration?.root?.name ?? null,
        stagingLocalTerrainRootId,
        terrainPresentationGenerationStagedCount:
          preparedTerrainPresentationGenerations.size,
        terrainPresentationGenerationStagedLimit:
          TERRAIN_PRESENTATION_STAGED_GENERATION_LIMIT,
        terrainPresentationGenerationStagedIdentities: Object.freeze(
          [...preparedTerrainPresentationGenerations.keys()].sort(),
        ),
        terrainPresentationGenerationStagedGeometryCount:
          [...preparedTerrainPresentationGenerations.values()].reduce(
            (sum, prepared) => sum + prepared.geometryCount,
            0,
          ),
        terrainPresentationGenerationStagedUploadBytes:
          [...preparedTerrainPresentationGenerations.values()].reduce(
            (sum, prepared) => sum + prepared.uploadBytes,
            0,
          ),
        terrainPresentationGenerationPrepareCount,
        terrainPresentationGenerationClaimCount,
        terrainPresentationGenerationDiscardCount,
        terrainPresentationGenerationStalePublishCount,
        terrainPresentationGenerationMaximumStagedCount,
        terrainPresentationGenerationMaximumGeometryCount,
        terrainPresentationGenerationMaximumUploadBytes,
        terrainPresentationGenerationMaximumSliceMs,
        terrainPresentationGenerationMaximumOldNewOverlapGeometryCount,
        terrainPresentationGenerationMaximumResidentGeometryCount,
        terrainPresentationGenerationMaximumResidentUploadBytes,
        buildOrigin: activeGeneration ? Object.freeze({
          renderOriginChunkX: activeGeneration.buildOriginChunkX,
          renderOriginChunkZ: activeGeneration.buildOriginChunkZ,
        }) : null,
        currentOrigin: activeGeneration ? Object.freeze({
          renderOriginChunkX: activeGeneration.currentOriginChunkX,
          renderOriginChunkZ: activeGeneration.currentOriginChunkZ,
        }) : null,
        playerLogical: activeGeneration ? Object.freeze({
          x: activeGeneration.playerX,
          z: activeGeneration.playerZ,
        }) : null,
        rootAttached: Boolean(
          root.parent === scene && activeGeneration?.root?.parent === root,
        ),
        localTerrainRootAttached: Boolean(
          root.parent === scene && activeLocalTerrainGeneration?.root?.parent === root,
        ),
        clipmapSampleCacheSize: clipmapSampleCache.size,
        clipmapSampleCacheCapacity: CLIPMAP_SAMPLE_CACHE_CAPACITY,
        clipmapSampleCacheHits,
        clipmapSampleCacheMisses,
        clipmapSampleCacheEvictions,
        clipmapSurfaceSampleReuseCount,
        clipmapSurfaceSampleRefreshCount,
        clipmapBuildCount,
        clipmapFullBuildCount,
        clipmapIncrementalBuildCount,
        clipmapTotalSampleCount,
        clipmapTotalNewlySampledCount,
        clipmapTotalReusedSampleCount,
        clipmapTotalVertexWriteCount,
        clipmapTotalBufferUploadBytes,
        clipmapTotalGeometryAllocationCount: clipmapGeometryAllocationCount,
        clipmapTotalIndexAllocationCount: clipmapIndexAllocationCount,
        clipmapGeometryDisposeCount,
        clipmapGeometryPoolSize: [...clipmapGeometryPoolByPreset.values()]
          .reduce((sum, pool) => sum + pool.length, 0),
        clipmapGeometryPoolInUseCount: [...clipmapGeometryPoolByPreset.values()]
          .reduce((sum, pool) => sum + pool.filter(resource => resource.generation !== null).length,
            0),
        clipmapLastBuildDurationMs,
        clipmapMaximumBuildDurationMs,
        midgroundOwnerSampleCacheSize: midgroundOwnerSampleCache.size,
        midgroundOwnerSampleCacheCapacity: MIDGROUND_OWNER_SAMPLE_CACHE_CAPACITY,
        midgroundOwnerSampleCacheHits,
        midgroundOwnerSampleCacheMisses,
        midgroundOwnerSampleCacheEvictions,
        midgroundTotalNewSampleCount,
        midgroundTotalReusedSampleCount,
        midgroundTotalDiscardedSampleCount,
        midgroundGeometryPoolSize: midgroundGeometryPool.length,
        midgroundGeometryPoolInUseCount: midgroundGeometryPool
          .filter(resource => resource.generation !== null).length,
        midgroundTotalGeometryAllocationCount: midgroundGeometryAllocationCount,
        midgroundTotalGeometryReuseCount: midgroundGeometryReuseCount,
        midgroundGeometryDisposeCount,
        continuousTerrainCoverageComplete,
        continuousTerrainCoverageMiss,
        visibleTerrainHoleFrame,
        rootObjectCount: (activeGeneration?.root.children?.length ?? 0)
          + (activeLocalTerrainGeneration?.root.children?.length ?? 0),
        disposed,
      });
    },
    treePathAuditSnapshot: snapshotTreeRenderPaths,
    treeMaterialAuditSnapshot: snapshotTreeMaterials,
    roadVisibilityDiagnosticSnapshot: snapshotRoadVisibilityDiagnostic,
    roadLifecycleDiagnosticSnapshot: snapshotRoadLifecycleDiagnostic,
    visibleRootRevisionSnapshot: snapshotVisibleRootRevisions,
    presenterAuditSnapshot: snapshotPresenterAudit,
    originTransformAuditSnapshot: snapshotOriginTransforms,
    canonicalAuditSnapshot() {
      const objects = [
        ...(activeGeneration ? [...activeGeneration.canonicalObjects.values()] : []),
        ...(persistentTreeGeneration
          ? [...persistentTreeGeneration.canonicalObjects.values()] : []),
      ];
      objects.sort((left, right) => left.stableId.localeCompare(right.stableId));
      const composedCountFor = (object, tier) => [...new Set(object.instances
        .filter(instance => instance.item.visibilityTiers.includes(tier))
        .map(instance => instance.bucket))].reduce((count, bucket) => (
          count + (bucket.mesh?.userData?.canonicalStableIds ?? [])
            .filter(stableId => stableId === object.stableId).length
      ), 0);
      const composedNaturalCountFor = (object, tier) => [...new Set(object.instances
        .filter(instance => instance.bucket.name === `natural-${tier}-${object.naturalKind}`)
        .map(instance => instance.bucket))].reduce((count, bucket) => (
          count + (bucket.mesh?.userData?.canonicalStableIds ?? [])
            .filter(stableId => stableId === object.stableId).length
      ), 0);
      return Object.freeze(objects.map(object => {
        const objectGeneration = persistentTreeGeneration?.canonicalObjects.has(object.stableId)
          ? persistentTreeGeneration : activeGeneration;
        const distanceMeters = Math.hypot(
          object.worldX - objectGeneration.playerX,
          object.worldZ - objectGeneration.playerZ,
        );
        return Object.freeze({
          identity: Object.freeze(structuredClone(object.identity)),
          visibleLod: object.visibleLod,
          presentationTier: object.presentationTier,
          farEligible: object.farEligible,
          instanceCount: object.instances.length,
          composedInstanceCount: object.instances.reduce((count, instance) => (
            count + (instance.bucket.mesh?.userData?.canonicalStableIds ?? [])
              .filter(stableId => stableId === object.stableId).length
          ), 0),
          stableIdHandoff: (
            object.localBuildingHandoff
              || object.remoteHorizon
              || (
                isHorizonRecord(object.record)
                  && object.record.featureType === 'settlement-building'
                  && objectGeneration.localSettlementIds.has(object.record.settlementId)
              )
          )
            ? Object.freeze({
              stableId: object.stableId,
              distanceMeters,
              fullOpacity: object.fullPresentationOpacity,
              horizonOpacity: object.horizonPresentationOpacity,
              remoteOpacity: object.remotePresentationOpacity,
              selectedTier: object.presentationTier,
              fullInstanceCount: composedCountFor(object, 'full'),
              horizonInstanceCount: composedCountFor(object, 'horizon'),
              remoteInstanceCount: composedCountFor(object, 'remote-horizon'),
              owner: object.ownerKey,
              presentationOnly: true,
              gameplayRecord: object.record.remotePresentationOnly !== true,
            })
            : null,
          naturalLod: object.naturalKind ? Object.freeze({
            stableId: object.stableId,
            kind: object.naturalKind,
            distanceMeters,
            fullOpacity: object.naturalBlend?.full ?? 0,
            forestOpacity: object.naturalBlend?.forest ?? 0,
            atmosphericOpacity: object.naturalBlend?.atmospheric ?? 0,
            farOpacity: object.naturalBlend?.far ?? 0,
            totalOpacity: object.naturalBlend?.totalOpacity ?? 0,
            canonicalFarDensityRank:
              object.naturalBlend?.canonicalFarDensityRank
                ?? object.canonicalFarTreeDensityRank ?? null,
            canonicalFarDensityThreshold:
              object.naturalBlend?.canonicalFarDensityThreshold ?? null,
            canonicalFarDensityOpacity:
              object.naturalBlend?.canonicalFarDensityOpacity ?? null,
            canonicalFarDensitySelected:
              object.naturalBlend?.canonicalFarDensitySelected ?? null,
            dominantTier: object.naturalBlend?.dominantTier ?? null,
            crossFade: object.naturalBlend?.crossFade ?? false,
            fullInstanceCount: composedNaturalCountFor(object, 'full'),
            forestInstanceCount: composedNaturalCountFor(object, 'forest'),
            atmosphericInstanceCount: composedNaturalCountFor(object, 'atmospheric'),
            farInstanceCount: composedNaturalCountFor(object, 'far'),
            owner: object.ownerKey,
            presentationOnly: true,
            gameplayRecord: true,
            distanceSource: 'logical-object-position',
          }) : null,
          remoteHorizon: object.remoteHorizon === true,
          ownerKey: object.ownerKey,
          ownerActive: objectGeneration.activeKeys.has(object.ownerKey),
          ownerRendered: objectGeneration.renderedKeys.has(object.ownerKey),
          distanceMeters,
          meshVisible: object.instances.every(instance => instance.bucket.mesh?.visible !== false),
        });
      }));
    },
    markFirstDraw(receipt) {
      if (!isCompletedRenderFrameReceipt(receipt)) return 0;
      const firstDrawAtMs = receipt.completedAtMs;
      const needsTreePathDrawProof = [activeGeneration, persistentTreeGeneration]
        .some(generation => [...treePathIdsForGeneration(generation, { visibleOnly: true })]
          .some(pathId => treePathAuditState.get(pathId)?.firstDrawAtMs === null));
      const needsDistantTelemetryProof = Boolean(streamingTelemetry
        && pendingDistantFirstDraw
        && pendingDistantFirstDraw.epoch === activeGeneration?.epoch);
      const needsStaticTelemetryProof = Boolean(streamingTelemetry
        && pendingStaticTreeFirstDraw.length > 0);
      const roadDrawGeneration = publishedRoadGeneration ?? activeGeneration;
      const needsRoadLifecycleProof = roadLifecycleDiagnosticEnabled
        && lifecycleFor(roadDrawGeneration?.epoch)?.publishedAtMs !== null
        && lifecycleFor(roadDrawGeneration?.epoch)?.firstDrawAtMs === null;
      if (!needsTreePathDrawProof
        && !needsDistantTelemetryProof
        && !needsStaticTelemetryProof
        && !needsRoadLifecycleProof) {
        markFirstDrawReceiptEarlyOutCount += 1;
        return 0;
      }
      const drawableOwnerKeys = generation => {
        const ownerKeys = new Set();
        for (const object of generation?.canonicalObjects?.values?.() ?? []) {
          markFirstDrawCanonicalObjectScanCount += 1;
          for (const { bucket, item } of object.instances) {
            const mesh = bucket.mesh;
            const slot = item.slot;
            if (!Number.isSafeInteger(slot) || slot < 0
              || !Number.isSafeInteger(mesh?.count) || slot >= mesh.count) continue;
            const opacity = mesh.userData?.canonicalOpacities?.[slot] ?? 1;
            const matrixValues = mesh.instanceMatrix?.array;
            const matrixOffset = slot * 16;
            const matrix = matrixValues?.subarray?.(matrixOffset, matrixOffset + 16)
              ?? matrixValues?.slice?.(matrixOffset, matrixOffset + 16)
              ?? mesh.matrices?.[slot]
              ?? null;
            const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
            const materialOpacity = Math.max(0, ...materials.filter(Boolean).map(material => (
              material.visible === false ? 0
                : Number.isFinite(material.opacity) ? material.opacity : 1
            )));
            if (isDrawableInCompletedFrame({
              mesh,
              receipt,
              matrix,
              effectiveOpacity: opacity * materialOpacity,
            })) {
              ownerKeys.add(object.ownerKey);
              break;
            }
          }
        }
        return ownerKeys;
      };
      const activeDrawableOwnerKeys = needsDistantTelemetryProof
        ? drawableOwnerKeys(activeGeneration) : new Set();
      const persistentDrawableOwnerKeys = needsStaticTelemetryProof
        ? drawableOwnerKeys(persistentTreeGeneration) : new Set();
      if (needsTreePathDrawProof) {
        for (const generation of [activeGeneration, persistentTreeGeneration]) {
          for (const pathId of treePathIdsForGeneration(generation, { visibleOnly: true })) {
            const state = treePathAuditState.get(pathId);
            if (state?.firstDrawAtMs !== null) continue;
            const pathHasDrawable = [...generation.canonicalBuckets.values()].some(bucket => (
              (bucket.mesh?.userData?.treePathId ?? treePathIdForBucket(bucket, generation)) === pathId
                && hasDrawableInCompletedFrame({ root: bucket.mesh, receipt })
            ));
            if (pathHasDrawable) recordTreePathAudit(pathId, { firstDrawAtMs });
          }
        }
      }
      let recorded = 0;
      if (needsRoadLifecycleProof && markRoadLifecycleFirstDraw(roadDrawGeneration, receipt)) {
        recorded += 1;
      }
      if (!streamingTelemetry) return recorded;
      if (pendingDistantFirstDraw
        && pendingDistantFirstDraw.epoch === activeGeneration?.epoch) {
        const remaining = [];
        for (const details of pendingDistantFirstDraw.events) {
          if (!activeDrawableOwnerKeys.has(details.ownerKey)) {
            remaining.push(details);
            continue;
          }
          streamingTelemetry.record(WORLD_STREAMING_EVENT.FIRST_DRAW, details);
          recorded += 1;
        }
        pendingDistantFirstDraw = remaining.length > 0
          ? { ...pendingDistantFirstDraw, events: remaining } : null;
      }
      for (let index = pendingStaticTreeFirstDraw.length - 1; index >= 0; index -= 1) {
        const details = pendingStaticTreeFirstDraw[index];
        if (!persistentDrawableOwnerKeys.has(details.ownerKey)) continue;
        streamingTelemetry.record(
          WORLD_STREAMING_EVENT.FIRST_DRAW,
          details,
        );
        pendingStaticTreeFirstDraw.splice(index, 1);
        recorded += 1;
      }
      return recorded;
    },
    dispose() {
      if (disposed) return;
      syncEpoch += 1;
      localTerrainSyncEpoch += 1;
      macroCoarseWorldController?.dispose();
      macroCoarseWorldController = null;
      macroCoarseWorldPresentation?.dispose();
      macroCoarseWorldPresentation = null;
      macroSurfaceWindowCache.clear();
      terrainScheduler.shutdown();
      cancelCanonicalChunkRequests?.({ consumerId: 'distant-owner-query' });
      cancelCanonicalChunkRequests?.({ consumerId: DISTANT_ROAD_OWNER_CONSUMER_ID });
      cancelCanonicalChunkRequests?.({ consumerId: DISTANT_ROAD_COVERAGE_CONSUMER_ID });
      independentRoadTarget = null;
      independentRoadDesiredOwners.clear();
      independentRoadCanonicalOwners.clear();
      independentRoadSettlementOwners.clear();
      independentRoadResolvedOwners.clear();
      independentRoadOwnerLoads.clear();
      independentRoadOwnerFailureRevision.clear();
      independentRoadCoverageAppliedKey = null;
      independentRoadCoverageFailedKey = null;
      independentRoadPublicationDirty = false;
      if (preparedRenderDistanceDistant) {
        disposeGeneration(preparedRenderDistanceDistant.generation);
        preparedRenderDistanceDistant = null;
      }
      if (preparedRenderDistanceLocalTerrain) {
        disposeGeneration(preparedRenderDistanceLocalTerrain.generation);
        preparedRenderDistanceLocalTerrain = null;
      }
      for (const prepared of preparedTerrainPresentationGenerations.values()) {
        disposeGeneration(prepared.generation);
      }
      preparedTerrainPresentationGenerations.clear();
      stagedPersistentNaturalRenderDistancePreset = null;
      disposeGeneration(activeGeneration);
      activeGeneration = null;
      pendingDistantPublication = null;
      liveDistantEntries.clear();
      for (const generation of [...retiredDistantGenerations]) {
        const detachedRoot = generation.stagingRoot;
        for (const child of detachedRoot?.children ?? []) child.dispose?.();
        detachedRoot?.clear?.();
        for (const geometry of generation.ownedGeometries ?? []) geometry.dispose?.();
        generation.ownedGeometries?.clear?.();
        for (const material of generation.ownedMaterials ?? []) material.dispose?.();
        generation.ownedMaterials?.clear?.();
      }
      retiredDistantGenerations.clear();
      persistentDistantRoot = null;
      persistentDistantPublishedGeneration = null;
      pendingDistantFirstDraw = null;
      publishedRoadGeneration = null;
      disposeGeneration(activeLocalTerrainGeneration);
      activeLocalTerrainGeneration = null;
      disposeGeneration(persistentTreeGeneration);
      persistentTreeGeneration = null;
      disposeGeneration(persistentNaturalVisibilityRetainedGeneration);
      persistentNaturalVisibilityRetainedGeneration = null;
      pendingPersistentTreePages.clear();
      pendingPersistentTreePublications.clear();
      persistentNaturalDetailAvailableOwners.clear();
      persistentNaturalVisibilityDirtyStableIds.clear();
      persistentNaturalVisibilityFullScanPending = true;
      persistentTreePublishedOwners.clear();
      persistentTreePages.clear();
      persistentTreeRetainedOwnerKeys.clear();
      directCanonicalTreeCells.clear();
      directCanonicalTreeOwnerKeys.clear();
      pendingStaticTreeFirstDraw.length = 0;
      discardSettlementRoadComposeWork(pendingRuntimePresentationHandoff?.bucketWork?.roadWork);
      discardRuntimePresentationBarrierRoadWork(
        pendingRuntimePresentationHandoff?.coverageBarrier,
      );
      const heldNearOwners = (getNearPresentationHolds() ?? [])
        .map(held => held?.ownerKey)
        .filter(ownerKey => typeof ownerKey === 'string');
      if (heldNearOwners.length > 0) {
        releaseNearPresentationHolds({
          ownerKeys: Object.freeze([...new Set(heldNearOwners)]),
          descriptors: Object.freeze([]),
          reason: 'distant-dispose',
        });
      }
      pendingRuntimePresentationHandoff = null;
      while (deferredGenerationDisposals.length) {
        disposeGeneration(deferredGenerationDisposals.shift().generation);
      }
      committedRuntimeTransitionContract = null;
      pendingFarSyncEpochs.clear();
      scene.remove(root);
      roadGeometry.dispose?.();
      terrainMaterial.dispose?.();
      for (const resource of midgroundGeometryPool) {
        resource.geometry.dispose?.();
        midgroundGeometryDisposeCount += 1;
      }
      midgroundGeometryPool.length = 0;
      for (const pool of clipmapGeometryPoolByPreset.values()) {
        for (const resource of pool) {
          resource.geometry.dispose?.();
          clipmapGeometryDisposeCount += 1;
        }
      }
      clipmapGeometryPoolByPreset.clear();
      midgroundOwnerSampleCache.clear();
      clipmapSampleCache.clear();
      riverCorridorWindowCache.clear();
      templateCache.clear();
      farOwnerChunkCache.clear();
      disposed = true;
    },
  });
}
