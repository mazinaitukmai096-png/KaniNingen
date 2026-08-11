import { ChunkRuntimeManager } from './chunk-runtime-manager.js';
import { ChunkDataService } from './chunk-data-service.js';
import { CHUNK_DATA_PRIORITY } from './chunk-data-service-protocol.js';
import { createInlineChunkGeneratorTransport } from './inline-chunk-generator-transport.js';
import { createWorkerChunkGeneratorTransport } from './worker-chunk-generator-transport.js';
import {
  W1B_SELECTED_RENDER_CHUNK_SIZE,
  describeRenderChunkCandidate,
} from './chunk-size-benchmark.js';
import {
  LOGICAL_CHUNK_SIZE_METERS,
  UNITS_PER_METER,
  decomposeLogicalWorldPosition,
  logicalWorldToRenderLocal,
  squareChunkCoordinates,
} from './chunk-coordinates.js';
import { planRuntimeTerrainReadySet } from './chunk-streaming-plan.js';
import { sameRuntimeTransitionContract } from './runtime-transition-contract.js';
import { ChunkRenderAdapter } from './render/chunk-render-adapter.js';
import {
  createW8ParityChunkGenerator,
  sampleW8SurfaceHeightMeters,
} from './w8-parity-chunk-generator.js';
import { ROAD_GRAPH_V1_GENERATOR_ID } from './road-graph-v1.js';
import { ROAD_GRAPH_V2_GENERATOR_ID } from './road-graph-v2.js';
import { ROAD_GRAPH_V3_GENERATOR_ID } from './road-graph-v3.js';
import { SETTLEMENT_LOT_V1_GENERATOR_ID } from './settlement-lot-v1.js';
import { SETTLEMENT_LOT_V2_GENERATOR_ID } from './settlement-lot-v2.js';
import { PersistentChunkIndex } from './persistent-chunk-index.js';
import { InfiniteGameplayRuntime } from './gameplay-runtime.js';
import {
  W6_INITIAL_SCALE_STAGE_ID,
  W7_NUCLEAR_CONTRACT,
  W8_COMBAT_COMMAND_TYPES,
  createCombatCommand,
  getW6ScaleProfile,
} from './gameplay-contract.js';
import { GameplayRenderAdapter } from './render/gameplay-render-adapter.js';
import {
  PRODUCTION_VISUAL_UNITS_PER_METER,
  createW8ParityVisualAssetLibrary,
} from './render/w8-parity-visual-assets.js';
import {
  InfiniteWorldSaveStore,
  InfiniteWorldState,
  createBrowserSaveStorage,
  isSaveStorageUnavailableError,
} from './world-state-store.js';
import { createInfiniteExperienceShell } from './experience-shell.js';
import { createW8AudioDirector } from './w8-audio.js';
import { createW8DistantPresentation } from './render/w8-distant-presentation.js';
import {
  createW8RuntimeDiagnostics,
  parseW8DiagnosticProfile,
} from './runtime-diagnostics.js';
import {
  WORLD_STREAMING_EVENT,
  WORLD_STREAMING_STREAM,
  WORLD_STREAMING_TARGET,
  collectWorldStreamingAcceptanceMetrics,
  createWorldStreamingTelemetry,
} from './world-streaming-telemetry.js';
import {
  LEGACY_RUNTIME_CHUNK_POLICY_KIND,
  createLegacyRuntimeChunkStreamingPolicy,
} from './world-streaming-plan.js';
import { createWorldStreamingPolicyRegistry } from './world-streaming-policy-registry.js';
import { createWorldStreamingCoordinator } from './world-streaming-coordinator.js';
import {
  STATIC_OBJECT_STREAM_VELOCITY_PREFETCH,
  createCircularStaticStreamingPolicy,
  createStaticObjectStream,
} from './static-object-stream.js';
import {
  NATURAL_RESOURCE_BAND_REVISION,
  createNaturalCoverageKey,
} from './natural-streaming-coverage.js';
import { createStreamingOwnerMetadataCache } from './streaming-owner-metadata.js';
import { resolveNaturalOwnerBuildQueueTarget } from './streaming-capacity-budget.js';
import {
  W8_VEGETATION_LOD_KINDS,
  resolveW8VegetationVisibilityContract,
} from './vegetation-lod-policy.js';
import {
  W8_DEFAULT_RENDER_DISTANCE_PRESET,
  W8_RENDER_FOG_COLOR_HEX,
  W8_RENDER_DISTANCE_PRESETS,
  normalizeW8RenderDistancePreset,
  resolveW8RenderDistancePolicy,
} from './render-distance-policy.js';
import {
  W8_BUILDING_STREAM_POLICY_KIND,
  W8_SETTLEMENT_STREAM_POLICY_KIND,
  compareW8BuildingSettlementShadow,
  createW8BuildingSettlementShadowPolicies,
} from './settlement-stream-policy.js';
import {
  BUILDING_SETTLEMENT_STREAM_MODE,
  createBuildingSettlementStream,
} from './building-settlement-stream.js';
import { createWebGLRenderDiagnostics } from './webgl-render-diagnostics.js';

export const SANDBOX_BOOT_TIMEOUT_MS = 30_000;
const HUD_DIAGNOSTIC_STAGE_NAMES = Object.freeze([
  'chunk-transition',
  'chunk-prefetch',
  'distant-sync',
  'gameplay-sync',
  'gameplay-update',
  'save-total',
  'render',
  'distant-clear',
  'distant-midground-terrain',
  'distant-midground-features',
  'distant-clipmap',
  'distant-feature-proxies',
]);
export const SANDBOX_RUNTIME_BUILD_IDENTITY = Object.freeze({
  schemaVersion: 'infinite-world-runtime-build-identity-1',
  sourceRevision: 'w8-real-webgl-draw-audit-1',
  requiredAncestorCommits: Object.freeze(['28e0a22', '638703d', 'a06e278']),
  htmlEntry: 'infinite-world-sandbox.html',
  moduleEntry: 'src/infinite-world/sandbox-entry.js?v=w8-finite-parity',
});

export function createOriginTransformDiagnosticRing({
  preFrameCapacity = 30,
  postFrameCapacity = 30,
  incidentCapacity = 4,
} = {}) {
  for (const [name, value] of Object.entries({
    preFrameCapacity, postFrameCapacity, incidentCapacity,
  })) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new RangeError(`${name} must be a positive safe integer`);
    }
  }
  const preFrames = [];
  const incidents = [];
  let activeIncident = null;
  let latest = null;
  const freezeSample = sample => Object.freeze({
    ...sample,
    anomalyCodes: Object.freeze([...(sample.anomalyCodes ?? [])]),
    roots: Object.freeze([...(sample.roots ?? [])]),
    buildingSlots: Object.freeze([...(sample.buildingSlots ?? [])]),
  });
  const finishIncident = () => {
    if (!activeIncident) return;
    incidents.push(Object.freeze({
      triggerFrameSequence: activeIncident.triggerFrameSequence,
      anomalyCodes: Object.freeze([...activeIncident.anomalyCodes]),
      frames: Object.freeze([...activeIncident.frames]),
    }));
    while (incidents.length > incidentCapacity) incidents.shift();
    activeIncident = null;
  };
  return Object.freeze({
    record(sample) {
      const frozen = freezeSample(sample);
      latest = frozen;
      if (activeIncident) {
        activeIncident.frames.push(frozen);
        for (const code of frozen.anomalyCodes) activeIncident.anomalyCodes.add(code);
        if (frozen.anomalyCodes.length) activeIncident.remainingPostFrames = postFrameCapacity;
        else activeIncident.remainingPostFrames -= 1;
        if (activeIncident.remainingPostFrames <= 0) finishIncident();
      } else if (frozen.anomalyCodes.length) {
        activeIncident = {
          triggerFrameSequence: frozen.frameSequence,
          anomalyCodes: new Set(frozen.anomalyCodes),
          frames: [...preFrames, frozen],
          remainingPostFrames: postFrameCapacity,
        };
      }
      preFrames.push(frozen);
      while (preFrames.length > preFrameCapacity) preFrames.shift();
      return frozen;
    },
    reset() {
      preFrames.length = 0;
      incidents.length = 0;
      activeIncident = null;
      latest = null;
    },
    snapshot() {
      const pending = activeIncident ? Object.freeze({
        triggerFrameSequence: activeIncident.triggerFrameSequence,
        anomalyCodes: Object.freeze([...activeIncident.anomalyCodes]),
        frames: Object.freeze([...activeIncident.frames]),
        remainingPostFrames: activeIncident.remainingPostFrames,
      }) : null;
      return Object.freeze({
        schemaVersion: 'origin-transform-diagnostic-ring-1',
        buildIdentity: SANDBOX_RUNTIME_BUILD_IDENTITY,
        latest,
        incidents: Object.freeze([...incidents]),
        pendingIncident: pending,
        preFrameCapacity,
        postFrameCapacity,
        incidentCapacity,
      });
    },
  });
}

export function createTerrainLagSpikeDiagnosticCapture({
  enabled = false,
  preWindowMs = 5_000,
  postWindowMs = 5_000,
} = {}) {
  for (const [name, value] of Object.entries({ preWindowMs, postWindowMs })) {
    if (!Number.isFinite(value) || value < 1_000) {
      throw new RangeError(`${name} must be at least 1000ms`);
    }
  }
  const preFrames = [];
  const postFrames = [];
  const markers = new Map();
  let triggerAtMs = null;
  let frozenAtMs = null;
  let frozen = false;
  const freezeFrame = frame => Object.freeze({ ...frame });
  const recordMarker = frame => {
    for (const threshold of [4, 8, 16]) {
      if (frame.lagChunks < threshold || markers.has(threshold)) continue;
      markers.set(threshold, Object.freeze({
        threshold,
        timestampMs: frame.timestampMs,
        frameSequence: frame.frameSequence,
        lagChunks: frame.lagChunks,
      }));
    }
  };
  return Object.freeze({
    record(frame) {
      if (!enabled || frozen || !Number.isFinite(frame?.timestampMs)) return false;
      const sample = freezeFrame(frame);
      if (triggerAtMs === null) {
        preFrames.push(sample);
        while (preFrames.length > 1
          && preFrames[0].timestampMs < sample.timestampMs - preWindowMs) preFrames.shift();
        if (sample.lagChunks >= 4) {
          triggerAtMs = sample.timestampMs;
          recordMarker(sample);
        }
        return true;
      }
      postFrames.push(sample);
      recordMarker(sample);
      if (sample.timestampMs - triggerAtMs >= postWindowMs) {
        frozen = true;
        frozenAtMs = sample.timestampMs;
      }
      return true;
    },
    reset() {
      preFrames.length = 0;
      postFrames.length = 0;
      markers.clear();
      triggerAtMs = null;
      frozenAtMs = null;
      frozen = false;
    },
    isFrozen() {
      return frozen;
    },
    snapshot() {
      return Object.freeze({
        schemaVersion: 'terrain-lag-spike-diagnostic-capture-1',
        enabled,
        triggered: triggerAtMs !== null,
        frozen,
        triggerAtMs,
        frozenAtMs,
        preWindowMs,
        postWindowMs,
        markers: Object.freeze([...markers.values()]),
        preFrames: Object.freeze([...preFrames]),
        postFrames: Object.freeze([...postFrames]),
        frameCount: preFrames.length + postFrames.length,
      });
    },
  });
}

export function shouldDeferAutosaveForStreaming(streamingState, { force = false } = {}) {
  if (force) return false;
  return streamingState?.transitionPending === true
    || streamingState?.preparationPending === true
    || Number(streamingState?.pendingPrefetchCount ?? 0) > 0;
}

const FINITE_TO_INFINITE_RENDER_SCALE = UNITS_PER_METER / PRODUCTION_VISUAL_UNITS_PER_METER;
const finiteVisualToRender = value => value * FINITE_TO_INFINITE_RENDER_SCALE;
const W8_GAMEPLAY_CAMERA_FAR = finiteVisualToRender(35_000);
const W8_GAMEPLAY_FOG_NEAR = finiteVisualToRender(3_000);
const defaultRenderDistancePolicy = resolveW8RenderDistancePolicy();

function defaultClock() {
  return globalThis.performance?.now?.() ?? Date.now();
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function number(value) {
  return Number(value ?? 0).toFixed(2);
}

function normalizeAngle(value) {
  let result = value % (Math.PI * 2);
  if (result <= -Math.PI) result += Math.PI * 2;
  if (result > Math.PI) result -= Math.PI * 2;
  return result;
}

function parseMeasurementViewport(value) {
  if (!value) return null;
  const match = /^(\d{3,5})x(\d{3,5})$/.exec(String(value));
  if (!match) throw new RangeError('measurementViewport must use WIDTHxHEIGHT');
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (width < 320 || height < 240 || width > 8192 || height > 8192) {
    throw new RangeError('measurementViewport is outside the supported range');
  }
  return Object.freeze({ width, height });
}

function parseMeasurementMode(value) {
  if (!value) return null;
  if (!['steady', 'crossing'].includes(value)) {
    throw new RangeError('measurementMode must be steady or crossing');
  }
  return value;
}

function parseMeasurementQuality(value) {
  if (!value) return null;
  if (!['high', 'medium', 'low'].includes(value)) {
    throw new RangeError('measurementQuality must be high, medium, or low');
  }
  return value;
}

export function parseSettlementRoadGraphGeneratorId(value) {
  if (value === null || value === '' || value === 'legacy-migrated-v1') return null;
  if (value === ROAD_GRAPH_V1_GENERATOR_ID) return ROAD_GRAPH_V1_GENERATOR_ID;
  if (value === ROAD_GRAPH_V2_GENERATOR_ID) return ROAD_GRAPH_V2_GENERATOR_ID;
  if (value === ROAD_GRAPH_V3_GENERATOR_ID) return ROAD_GRAPH_V3_GENERATOR_ID;
  throw new RangeError(`unsupported experimental Settlement Road Graph: ${value}`);
}

export function parseSettlementLotMode(value) {
  if (value === null || value === '') return null;
  if (value === SETTLEMENT_LOT_V1_GENERATOR_ID) return SETTLEMENT_LOT_V1_GENERATOR_ID;
  if (value === SETTLEMENT_LOT_V2_GENERATOR_ID) return SETTLEMENT_LOT_V2_GENERATOR_ID;
  throw new RangeError(`unsupported experimental Settlement Lot mode: ${value}`);
}

export function gatePlayerMovementByTerrainCoverage({
  horizontalMovement,
  startX,
  startZ,
  sampleCanonicalTerrainHeight,
  sampleFallbackTerrainHeight = () => null,
  fallbackTerrainHeightMeters = null,
  isTerrainCoveragePublished,
}) {
  if (!Number.isFinite(horizontalMovement?.x) || !Number.isFinite(horizontalMovement?.z)) {
    throw new Error('Player horizontal movement resolver returned a non-finite position');
  }
  if (typeof sampleCanonicalTerrainHeight !== 'function') {
    throw new TypeError('Player terrain coverage gate requires a canonical Terrain sampler');
  }
  if (typeof isTerrainCoveragePublished !== 'function') {
    throw new TypeError('Player terrain coverage gate requires a publication predicate');
  }
  if (typeof sampleFallbackTerrainHeight !== 'function') {
    throw new TypeError('Player terrain coverage gate fallback sampler must be a function');
  }
  const owner = decomposeLogicalWorldPosition(horizontalMovement.x, horizontalMovement.z);
  const terrainCoveragePublished = isTerrainCoveragePublished(owner);
  const candidateTerrainHeightMeters = sampleCanonicalTerrainHeight(
    horizontalMovement.x,
    horizontalMovement.z,
  );
  const collisionCoverageMiss = !Number.isFinite(candidateTerrainHeightMeters);
  let terrainHeightMeters = candidateTerrainHeightMeters;
  let terrainHeightSource = 'canonical';
  if (!Number.isFinite(terrainHeightMeters)) {
    terrainHeightMeters = sampleFallbackTerrainHeight(
      horizontalMovement.x,
      horizontalMovement.z,
    );
    terrainHeightSource = 'coarse-presentation';
  }
  const retainedOwner = decomposeLogicalWorldPosition(startX, startZ);
  if (!Number.isFinite(terrainHeightMeters)) {
    terrainHeightMeters = sampleCanonicalTerrainHeight(startX, startZ);
    terrainHeightSource = 'retained-canonical';
  }
  if (!Number.isFinite(terrainHeightMeters)) {
    terrainHeightMeters = sampleFallbackTerrainHeight(startX, startZ);
    terrainHeightSource = 'retained-coarse-presentation';
  }
  if (!Number.isFinite(terrainHeightMeters) && Number.isFinite(fallbackTerrainHeightMeters)) {
    terrainHeightMeters = fallbackTerrainHeightMeters;
    terrainHeightSource = 'last-safe';
  }
  if (!Number.isFinite(terrainHeightMeters)) {
    throw new Error(`no safe Terrain height is available for Player Chunk ${retainedOwner.key}`);
  }
  return Object.freeze({
    ...horizontalMovement,
    terrainHeightMeters,
    terrainHeightSource,
    terrainCoverageBlocked: false,
    movementBlockedByTerrain: false,
    terrainPresentationFallback: !terrainCoveragePublished,
    terrainCoveragePublished,
    collisionCoverageMiss,
    terrainCoverageOwner: owner,
  });
}

export function terrainPresentationWorldCoverageComplete(coverage) {
  return coverage?.worldCoverageComplete ?? coverage?.complete === true;
}

export function isW8GameplaySimulationEnabled(measurementMode, runPhase, paused = false) {
  return measurementMode !== null || (runPhase === 'playing' && paused !== true);
}

export function w8CloudDeltaSeconds({
  deltaSeconds,
  measurementMode,
  runPhase,
  paused,
  hitStopped,
}) {
  const running = measurementMode || ['playing', 'dying'].includes(runPhase);
  if (!running || (paused && !measurementMode) || hitStopped) return 0;
  return deltaSeconds * (runPhase === 'dying' ? 0.15 : 1);
}

function parseDiagnosticRunNumber(value) {
  if (!value) return 1;
  const runNumber = Number(value);
  if (!Number.isSafeInteger(runNumber) || runNumber < 1 || runNumber > 999) {
    throw new RangeError('diagnosticRun must be an integer from 1 to 999');
  }
  return runNumber;
}

function appendElement(parent, child) {
  if (typeof parent?.append === 'function') parent.append(child);
  else if (typeof parent?.appendChild === 'function') parent.appendChild(child);
  else throw new TypeError('sandbox viewport cannot append the renderer canvas');
}

function countSceneObjects(root) {
  if (!root) return 0;
  let count = 1;
  for (const child of root.children ?? []) count += countSceneObjects(child);
  return count;
}

function timeoutError(stage, timeoutMs) {
  const error = new Error(`${stage} did not complete within ${timeoutMs}ms`);
  error.name = 'SandboxBootTimeoutError';
  return error;
}

async function settleWithin(promise, { stage, timeoutMs, setTimeoutFn, clearTimeoutFn }) {
  let timer = null;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeoutFn(() => reject(timeoutError(stage, timeoutMs)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== null) clearTimeoutFn(timer);
  }
}

export function createSandboxBootState({ clock = defaultClock } = {}) {
  const startedAt = clock();
  return {
    schemaVersion: 'w6-sandbox-boot-state-1',
    status: 'booting',
    stage: 'DOMContentLoaded',
    bootStartedAt: startedAt,
    bootCompletedAt: null,
    bootDurationMs: null,
    stageDurations: {},
    bootError: null,
    initializationComplete: false,
    loopStarted: false,
    initialChunkCount: 0,
    initialRenderedChunkCount: 0,
    initialPrefetchedChunkCount: 0,
    initialSettlementCount: 0,
    initialSceneObjectCount: 0,
    macroRegionsEvaluated: 0,
    rawSettlementCandidateCount: 0,
    acceptedSettlementCandidateCount: 0,
    materializedSettlementCount: 0,
    chunkGenerationMs: 0,
    settlementGenerationMs: 0,
    renderProjectionMs: 0,
    startupSurveyExecuted: false,
    startupBenchmarkExecuted: false,
    initialSimulationChunkCount: 0,
    initialGameplayEntityCount: 0,
    saveLoaded: false,
    saveAvailable: false,
    saveError: null,
  };
}

export function snapshotSandboxBootState(state) {
  return Object.freeze({
    ...state,
    stageDurations: Object.freeze({ ...state.stageDurations }),
    bootError: state.bootError ? Object.freeze({ ...state.bootError }) : null,
  });
}

export function renderSandboxBootStatus(hud, state) {
  if (!hud) return;
  const badge = '<span id="badge">W8 / FINITE EXPERIENCE PARITY</span>';
  if (state.status === 'failed') {
    hud.innerHTML = `${badge}\n<span id="error">起動失敗: ${escapeHtml(state.stage)}</span>\n${escapeHtml(state.bootError?.message ?? 'unknown error')}`;
    return;
  }
  hud.innerHTML = `${badge}\n起動中: ${escapeHtml(state.stage)}`;
}

export function recordSandboxBootFailure({ state, hud, error, clock = defaultClock }) {
  if (state.status !== 'failed') {
    state.status = 'failed';
    state.bootCompletedAt = clock();
    state.bootDurationMs = state.bootCompletedAt - state.bootStartedAt;
    state.bootError = {
      name: error?.name ?? 'Error',
      message: error?.message ?? String(error),
      stage: state.stage,
    };
  }
  renderSandboxBootStatus(hud, state);
  return error;
}

export function createSandboxEntryController({
  documentObject,
  state,
  hud,
  runSandboxBoot,
  handleBootFailure = error => recordSandboxBootFailure({ state, hud, error }),
} = {}) {
  if (!documentObject || typeof documentObject.addEventListener !== 'function') {
    throw new TypeError('sandbox entry requires a document event target');
  }
  if (!state || typeof state !== 'object') throw new TypeError('sandbox entry requires boot state');
  if (typeof runSandboxBoot !== 'function') throw new TypeError('runSandboxBoot must be a function');
  if (typeof handleBootFailure !== 'function') throw new TypeError('handleBootFailure must be a function');

  let sandboxBootPromise = null;
  let bootExecutionCount = 0;
  let installed = false;
  let resolveOutcome;
  const outcomePromise = new Promise(resolve => { resolveOutcome = resolve; });

  function startSandboxOnce() {
    if (sandboxBootPromise) return sandboxBootPromise;
    bootExecutionCount += 1;
    state.stage = 'Legacy Core';
    renderSandboxBootStatus(hud, state);
    sandboxBootPromise = Promise.resolve()
      .then(runSandboxBoot)
      .then(sandbox => Object.freeze({ ok: true, sandbox }))
      .catch(error => {
        handleBootFailure(error);
        return Object.freeze({
          ok: false,
          error: Object.freeze({
            name: error?.name ?? 'Error',
            message: error?.message ?? String(error),
            stack: error?.stack ?? `${error?.name ?? 'Error'}: ${error?.message ?? String(error)}`,
          }),
        });
      });
    sandboxBootPromise.then(resolveOutcome);
    return sandboxBootPromise;
  }

  function install() {
    if (installed) return outcomePromise;
    installed = true;
    if (documentObject.readyState === 'loading') {
      documentObject.addEventListener('DOMContentLoaded', () => {
        void startSandboxOnce();
      }, { once: true });
    } else {
      void startSandboxOnce();
    }
    return outcomePromise;
  }

  return Object.freeze({
    install,
    startSandboxOnce,
    promise: outcomePromise,
    snapshot: () => Object.freeze({
      installed,
      documentReadyState: documentObject.readyState,
      bootExecutionCount,
      bootStarted: sandboxBootPromise !== null,
    }),
  });
}

function createRuntimeRenderProfile() {
  const profile = describeRenderChunkCandidate(W1B_SELECTED_RENDER_CHUNK_SIZE);
  return Object.freeze({
    schemaVersion: 'w1b-runtime-render-profile-1',
    benchmarkExecuted: false,
    selectedRenderChunkSize: profile.renderChunkSize,
    selectedUnitsPerMeter: profile.unitsPerMeter,
    profile,
  });
}

export function createW8ScenePresentation({
  THREE,
  scene,
  visualAssets,
  cloudAnchor = { x: 0, z: 0 },
}) {
  const cloudAnchorX = Number.isFinite(cloudAnchor?.x) ? cloudAnchor.x : 0;
  const cloudAnchorZ = Number.isFinite(cloudAnchor?.z) ? cloudAnchor.z : 0;
  const cloudBaseCount = 70;
  const cloudInstances = [];
  const cloudRoll = (index, salt) => {
    let value = Math.imul(index + 1, 0x45d9f3b) ^ Math.imul(salt + 1, 0x119de1f3);
    value ^= value >>> 16; value = Math.imul(value, 0x45d9f3b); value ^= value >>> 16;
    return (value >>> 0) / 0x1_0000_0000;
  };
  const appendCloud = ({
    sourceIndex,
    xFinite,
    yFinite,
    zFinite,
    widthFinite,
    heightFinite,
    depthFinite,
    speedFinite,
    opacity,
    warm,
    puff,
  }) => {
    cloudInstances.push({
      sourceIndex,
      logicalX: cloudAnchorX + xFinite / PRODUCTION_VISUAL_UNITS_PER_METER,
      logicalY: yFinite / PRODUCTION_VISUAL_UNITS_PER_METER,
      logicalZ: cloudAnchorZ + zFinite / PRODUCTION_VISUAL_UNITS_PER_METER,
      widthFinite,
      heightFinite,
      depthFinite,
      speedFinite,
      opacity,
      warm,
      puff,
      wrapCount: 0,
    });
  };
  const warmBaseIndices = new Set(
    Array.from({ length: cloudBaseCount }, (_, index) => index)
      .sort((left, right) => cloudRoll(left, 1) - cloudRoll(right, 1))
      .slice(0, Math.round(cloudBaseCount * 0.4)),
  );
  for (let index = 0; index < cloudBaseCount; index += 1) {
    const opacity = 0.55 + cloudRoll(index, 0) * 0.35;
    const warm = warmBaseIndices.has(index);
    const widthFinite = 600 + cloudRoll(index, 2) * 1_400;
    const heightFinite = 100 + cloudRoll(index, 3) * 220;
    const depthFinite = 400 + cloudRoll(index, 4) * 900;
    const xFinite = (cloudRoll(index, 5) - 0.5) * 28_000;
    const yFinite = 1_600 + cloudRoll(index, 6) * 1_900;
    const zFinite = (cloudRoll(index, 7) - 0.5) * 28_000;
    const speedFinite = 1.5 + cloudRoll(index, 8) * 2.5;
    appendCloud({
      sourceIndex: index,
      xFinite,
      yFinite,
      zFinite,
      widthFinite,
      heightFinite,
      depthFinite,
      speedFinite,
      opacity,
      warm,
      puff: false,
    });
    if (index % 10 < 3) appendCloud({
      sourceIndex: index,
      xFinite: xFinite + (cloudRoll(index, 9) - 0.5) * widthFinite * 0.8,
      yFinite: yFinite + (cloudRoll(index, 10) - 0.5) * heightFinite * 0.4,
      zFinite: zFinite + (cloudRoll(index, 11) - 0.5) * depthFinite * 0.8,
      widthFinite: widthFinite * (0.4 + cloudRoll(index, 12) * 0.4),
      heightFinite: heightFinite * (0.6 + cloudRoll(index, 13) * 0.4),
      depthFinite: depthFinite * (0.4 + cloudRoll(index, 14) * 0.4),
      speedFinite,
      opacity,
      warm,
      puff: true,
    });
  }
  const cloudPuffCount = cloudInstances.length - cloudBaseCount;
  const sharedCloudGeometry = visualAssets.geometries.box;
  const cloudGeometry = sharedCloudGeometry.clone?.() ?? sharedCloudGeometry;
  const ownsCloudGeometry = cloudGeometry !== sharedCloudGeometry;
  const SharedCloudMaterial = visualAssets.materials.cloud;
  const cloudMaterial = SharedCloudMaterial.clone?.() ?? SharedCloudMaterial;
  const ownsCloudMaterial = cloudMaterial !== SharedCloudMaterial;
  if (ownsCloudMaterial) cloudMaterial.opacity = 1;
  const InstancedBufferAttribute = THREE.InstancedBufferAttribute;
  if (typeof InstancedBufferAttribute === 'function' && typeof cloudGeometry.setAttribute === 'function') {
    const opacities = new Float32Array(cloudInstances.length);
    for (let index = 0; index < cloudInstances.length; index += 1) {
      opacities[index] = cloudInstances[index].opacity;
    }
    cloudGeometry.setAttribute('instanceOpacity', new InstancedBufferAttribute(opacities, 1));
    cloudMaterial.onBeforeCompile = shader => {
      shader.vertexShader = `attribute float instanceOpacity;
varying float vInstanceOpacity;
${shader.vertexShader}`.replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\nvInstanceOpacity = instanceOpacity;',
      );
      shader.fragmentShader = `varying float vInstanceOpacity;
${shader.fragmentShader}`.replace(
        '#include <color_fragment>',
        '#include <color_fragment>\ndiffuseColor.a *= vInstanceOpacity;',
      );
    };
    cloudMaterial.customProgramCacheKey = () => 'w8-finite-cloud-instance-opacity-v1';
  }
  const cloudRoot = new THREE.InstancedMesh(
    cloudGeometry,
    cloudMaterial,
    cloudInstances.length,
  );
  cloudRoot.name = 'w8-finite-cloud-instance-pool';
  cloudRoot.userData = { presentationOnly: true, cloudBaseCount, cloudPuffCount };
  cloudRoot.visible = true;
  cloudRoot.castShadow = false;
  cloudRoot.receiveShadow = false;
  cloudRoot.frustumCulled = false;
  const cloudTransform = new THREE.Object3D();
  const warmCloudColor = new THREE.Color(0xfff3e0);
  const whiteCloudColor = new THREE.Color(0xffffff);
  let renderOriginChunkX = 0;
  let renderOriginChunkZ = 0;
  let cloudMatrixWriteCount = 0;
  const writeCloudMatrices = renderOrigin => {
    renderOriginChunkX = renderOrigin?.renderOriginChunkX ?? renderOriginChunkX;
    renderOriginChunkZ = renderOrigin?.renderOriginChunkZ ?? renderOriginChunkZ;
    const originMetersX = renderOriginChunkX * LOGICAL_CHUNK_SIZE_METERS;
    const originMetersZ = renderOriginChunkZ * LOGICAL_CHUNK_SIZE_METERS;
    for (let index = 0; index < cloudInstances.length; index += 1) {
      const cloud = cloudInstances[index];
      cloudTransform.position.set(
        (cloud.logicalX - originMetersX) * UNITS_PER_METER,
        cloud.logicalY * UNITS_PER_METER,
        (cloud.logicalZ - originMetersZ) * UNITS_PER_METER,
      );
      cloudTransform.rotation.set(0, 0, 0);
      cloudTransform.scale.set(
        finiteVisualToRender(cloud.widthFinite),
        finiteVisualToRender(cloud.heightFinite),
        finiteVisualToRender(cloud.depthFinite),
      );
      cloudTransform.updateMatrix();
      cloudRoot.setMatrixAt(index, cloudTransform.matrix);
    }
    cloudRoot.instanceMatrix.needsUpdate = true;
    cloudMatrixWriteCount += 1;
  };
  for (let index = 0; index < cloudInstances.length; index += 1) {
    const cloud = cloudInstances[index];
    cloudRoot.setColorAt?.(index, cloud.warm ? warmCloudColor : whiteCloudColor);
  }
  cloudRoot.count = cloudInstances.length;
  if (cloudRoot.instanceColor) cloudRoot.instanceColor.needsUpdate = true;
  writeCloudMatrices({ renderOriginChunkX: 0, renderOriginChunkZ: 0 });
  scene.add(cloudRoot);

  const updateClouds = (deltaSeconds, renderOrigin) => {
    const dtScale = Math.min(Math.max(0, deltaSeconds) * 60, 4);
    if (dtScale > 0) {
      for (let index = 0; index < cloudInstances.length; index += 1) {
        const cloud = cloudInstances[index];
        cloud.logicalX += cloud.speedFinite * dtScale / PRODUCTION_VISUAL_UNITS_PER_METER;
        if ((cloud.logicalX - cloudAnchorX) * PRODUCTION_VISUAL_UNITS_PER_METER
          > 14_000) {
          cloud.logicalX = cloudAnchorX - 14_000 / PRODUCTION_VISUAL_UNITS_PER_METER;
          cloud.wrapCount += 1;
          cloud.logicalZ = cloudAnchorZ + (cloudRoll(
            cloud.sourceIndex,
            1_000 + cloud.wrapCount * 2 + (cloud.puff ? 1 : 0),
          ) - 0.5) * 28_000 / PRODUCTION_VISUAL_UNITS_PER_METER;
        }
      }
    }
    writeCloudMatrices(renderOrigin);
  };

  const titlePresentationRoot = new THREE.Group();
  titlePresentationRoot.name = 'w8-main-world-title-presentation';
  titlePresentationRoot.userData = { presentationOnly: true };
  const titleCrab = visualAssets.createPlayerModel();
  titleCrab.position.set(0, 0, 0);
  titleCrab.rotation.y = Math.atan2(220, 380);
  titleCrab.scale.set(
    finiteVisualToRender(1), finiteVisualToRender(1), finiteVisualToRender(1),
  );
  const titleCrabParts = titleCrab.userData?.presentationParts;
  titlePresentationRoot.add(titleCrab);
  const explosionRoot = new THREE.Group();
  explosionRoot.name = 'w8-title-atomic-presentation';
  explosionRoot.userData = {
    presentationOnly: true, finiteBaseCount: 50, finiteStemCount: 80, finiteCapCount: 200,
  };
  const titleParticleCapacity = 330;
  const titleSmokePool = new THREE.InstancedMesh(
    visualAssets.geometries.box, visualAssets.materials.lobbySmoke, titleParticleCapacity,
  );
  const titleFirePool = new THREE.InstancedMesh(
    visualAssets.geometries.box, visualAssets.materials.lobbyFire, titleParticleCapacity,
  );
  titleSmokePool.name = 'w8-title-mushroom-smoke-pool';
  titleFirePool.name = 'w8-title-mushroom-fire-pool';
  titleSmokePool.castShadow = false; titleFirePool.castShadow = false;
  titleSmokePool.receiveShadow = false; titleFirePool.receiveShadow = false;
  const titleParticleTransform = new THREE.Object3D();
  let titleSmokeCount = 0;
  let titleFireCount = 0;
  const titleParticleRoll = (index, salt) => cloudRoll(index + 400, salt + 50);
  const appendTitleParticle = ({ index, isFire, x, y, z, scaleFinite }) => {
    titleParticleTransform.position.set(
      finiteVisualToRender(x), finiteVisualToRender(y), finiteVisualToRender(z),
    );
    titleParticleTransform.rotation.set(
      titleParticleRoll(index, 7) * Math.PI,
      titleParticleRoll(index, 8) * Math.PI,
      titleParticleRoll(index, 9) * Math.PI,
    );
    const scale = finiteVisualToRender(scaleFinite);
    titleParticleTransform.scale.set(scale, scale, scale);
    titleParticleTransform.updateMatrix();
    const pool = isFire ? titleFirePool : titleSmokePool;
    const poolIndex = isFire ? titleFireCount : titleSmokeCount;
    pool.setMatrixAt(poolIndex, titleParticleTransform.matrix);
    if (isFire) titleFireCount += 1; else titleSmokeCount += 1;
  };
  for (let index = 0; index < 50; index += 1) {
    const angle = titleParticleRoll(index, 0) * Math.PI * 2;
    const distance = 200 + titleParticleRoll(index, 1) * 700;
    appendTitleParticle({
      index,
      isFire: titleParticleRoll(index, 2) < 0.2,
      x: Math.cos(angle) * distance,
      y: titleParticleRoll(index, 3) * 250,
      z: Math.sin(angle) * distance,
      scaleFinite: 150 + titleParticleRoll(index, 4) * 200,
    });
  }
  for (let index = 0; index < 80; index += 1) {
    const particleIndex = index + 50;
    const height = 100 + titleParticleRoll(particleIndex, 0) * 1_000;
    const radius = (40 + titleParticleRoll(particleIndex, 1) * 120) * (1 + height / 1_000);
    const angle = titleParticleRoll(particleIndex, 2) * Math.PI * 2;
    appendTitleParticle({
      index: particleIndex,
      isFire: titleParticleRoll(particleIndex, 3) < 0.4,
      x: Math.cos(angle) * radius,
      y: height,
      z: Math.sin(angle) * radius,
      scaleFinite: 150 + titleParticleRoll(particleIndex, 4) * 200,
    });
  }
  for (let index = 0; index < 200; index += 1) {
    const particleIndex = index + 130;
    const angle = titleParticleRoll(particleIndex, 0) * Math.PI * 2;
    const distance = titleParticleRoll(particleIndex, 1) ** 0.6 * 1_000;
    const height = 1_100 + Math.cos(distance / 1_000 * Math.PI / 2) * 400
      + (titleParticleRoll(particleIndex, 2) - 0.5) * 350;
    appendTitleParticle({
      index: particleIndex,
      isFire: titleParticleRoll(particleIndex, 3) < 0.5,
      x: Math.cos(angle) * distance,
      y: height,
      z: Math.sin(angle) * distance,
      scaleFinite: 200 + distance / 1_000 * 150 + titleParticleRoll(particleIndex, 4) * 200,
    });
  }
  titleSmokePool.count = titleSmokeCount;
  titleFirePool.count = titleFireCount;
  titleSmokePool.instanceMatrix.needsUpdate = true;
  titleFirePool.instanceMatrix.needsUpdate = true;
  titleSmokePool.userData = { presentationOnly: true, role: 'lobby-smoke', count: titleSmokeCount };
  titleFirePool.userData = { presentationOnly: true, role: 'lobby-fire', count: titleFireCount };
  explosionRoot.add(titleSmokePool);
  explosionRoot.add(titleFirePool);
  explosionRoot.position.set(0, 0, finiteVisualToRender(-5_700));
  explosionRoot.scale.set(1.3, 1.3, 1.3);
  titlePresentationRoot.add(explosionRoot);
  scene.add(titlePresentationRoot);
  let disposed = false;
  return Object.freeze({
    titlePresentationRoot, titleCrab, titleCrabParts, explosionRoot, cloudRoot,
    update(deltaSeconds, renderOrigin) {
      if (disposed) return;
      updateClouds(deltaSeconds, renderOrigin);
    },
    rebase(renderOrigin) {
      if (disposed) return;
      writeCloudMatrices(renderOrigin);
    },
    snapshot() {
      let warmBaseCount = 0;
      let minimumCloudY = Infinity;
      let maximumCloudY = -Infinity;
      for (let index = 0; index < cloudInstances.length; index += 1) {
        if (!cloudInstances[index].puff && cloudInstances[index].warm) warmBaseCount += 1;
        minimumCloudY = Math.min(minimumCloudY, cloudInstances[index].logicalY);
        maximumCloudY = Math.max(maximumCloudY, cloudInstances[index].logicalY);
      }
      const instanceOpacity = cloudGeometry.getAttribute?.('instanceOpacity')
        ?? cloudGeometry.attributes?.instanceOpacity;
      return Object.freeze({
        cloudBaseCount,
        cloudPuffCount,
        cloudInstanceCount: cloudInstances.length,
        cloudCapacity: cloudRoot.instanceMatrix?.count ?? cloudInstances.length,
        warmBaseCount,
        cloudMatrixWriteCount,
        cloudAnchorX,
        cloudAnchorZ,
        minimumCloudY,
        maximumCloudY,
        rootAttached: cloudRoot.parent === scene,
        rootVisible: cloudRoot.visible !== false,
        frustumCulled: cloudRoot.frustumCulled,
        renderOrder: cloudRoot.renderOrder ?? 0,
        materialTransparent: cloudMaterial.transparent === true,
        materialOpacity: cloudMaterial.opacity,
        materialDepthWrite: cloudMaterial.depthWrite,
        instanceOpacityAttributeCount:
          instanceOpacity?.count ?? instanceOpacity?.values?.length ?? 0,
        instanceOpacityShaderEnabled:
          typeof cloudMaterial.onBeforeCompile === 'function'
          && cloudMaterial.customProgramCacheKey?.()
            === 'w8-finite-cloud-instance-opacity-v1',
        instanceMatrixVersion: cloudRoot.instanceMatrix?.version ?? null,
        renderOriginChunkX,
        renderOriginChunkZ,
        clouds: Object.freeze(cloudInstances.map(cloud => Object.freeze({
          sourceIndex: cloud.sourceIndex,
          logicalX: cloud.logicalX,
          logicalY: cloud.logicalY,
          logicalZ: cloud.logicalZ,
          widthFinite: cloud.widthFinite,
          heightFinite: cloud.heightFinite,
          depthFinite: cloud.depthFinite,
          speedFinite: cloud.speedFinite,
          opacity: cloud.opacity,
          warm: cloud.warm,
          puff: cloud.puff,
          wrapCount: cloud.wrapCount,
        }))),
      });
    },
    dispose() {
      if (disposed) return;
      scene.remove(cloudRoot);
      scene.remove(titlePresentationRoot);
      titlePresentationRoot.clear?.();
      if (ownsCloudGeometry) cloudGeometry.dispose?.();
      if (ownsCloudMaterial) cloudMaterial.dispose?.();
      disposed = true;
    },
  });
}

export async function bootInfiniteWorldSandbox({
  globalObject = globalThis,
  THREE = globalObject.THREE,
  viewport = globalObject.document?.querySelector?.('#viewport'),
  hud = globalObject.document?.querySelector?.('#hud'),
  requestedSeed = new globalObject.URLSearchParams(globalObject.location?.search ?? '').get('seed')
    ?? 'KaniNingen Infinite Natural World',
  measurementViewport = parseMeasurementViewport(
    new globalObject.URLSearchParams(globalObject.location?.search ?? '').get('measurementViewport'),
  ),
  measurementMode = parseMeasurementMode(
    new globalObject.URLSearchParams(globalObject.location?.search ?? '').get('measurementMode'),
  ),
  measurementQuality = parseMeasurementQuality(
    new globalObject.URLSearchParams(globalObject.location?.search ?? '').get('measurementQuality'),
  ),
  diagnosticProfile = parseW8DiagnosticProfile(
    new globalObject.URLSearchParams(globalObject.location?.search ?? '').get('diagnosticProfile'),
  ),
  diagnosticRunNumber = parseDiagnosticRunNumber(
    new globalObject.URLSearchParams(globalObject.location?.search ?? '').get('diagnosticRun'),
  ),
  terrainLagSpikeDiagnosticsEnabled = new globalObject.URLSearchParams(
    globalObject.location?.search ?? '',
  ).get('terrainLagSpikeDiagnostics') === '1',
  diagnosticsEnabled = measurementMode !== null
    || new globalObject.URLSearchParams(globalObject.location?.search ?? '').get('diagnostics') === '1'
    || terrainLagSpikeDiagnosticsEnabled
    || diagnosticProfile.profileId !== 'baseline',
  forceFirstWebGLDiagnosticIncident = new globalObject.URLSearchParams(
    globalObject.location?.search ?? '',
  ).get('webglDiagnosticForceIncident') === '1',
  streamingTelemetryEnabled = new globalObject.URLSearchParams(
    globalObject.location?.search ?? '',
  ).get('streamingTelemetry') === '1',
  disablePersistentTreePublication = new globalObject.URLSearchParams(
    globalObject.location?.search ?? '',
  ).get('disablePersistentTreePublication') === '1',
  settlementStreamingMode = new globalObject.URLSearchParams(
    globalObject.location?.search ?? '',
  ).get('settlementStreaming') === 'legacy'
    ? BUILDING_SETTLEMENT_STREAM_MODE.LEGACY
    : BUILDING_SETTLEMENT_STREAM_MODE.SHARED,
  settlementRoadGraphGeneratorId = parseSettlementRoadGraphGeneratorId(
    new globalObject.URLSearchParams(
      globalObject.location?.search ?? '',
    ).get('settlementRoadGraph'),
  ),
  settlementLotMode = parseSettlementLotMode(
    new globalObject.URLSearchParams(
      globalObject.location?.search ?? '',
    ).get('settlementLotMode'),
  ),
  streamingTelemetryCapacity = 8192,
  state = createSandboxBootState(),
  generatorFactory = createW8ParityChunkGenerator,
  chunkGeneratorWorkerFactory = null,
  renderAdapterFactory = options => new ChunkRenderAdapter(options),
  runtimeFactory = options => new ChunkRuntimeManager(options),
  chunkIndexFactory = options => new PersistentChunkIndex(options),
  worldStateFactory = options => new InfiniteWorldState(options),
  saveStoreFactory = options => new InfiniteWorldSaveStore(options),
  gameplayRenderAdapterFactory = options => new GameplayRenderAdapter(options),
  gameplayRuntimeFactory = options => new InfiniteGameplayRuntime(options),
  clock = () => globalObject.performance?.now?.() ?? Date.now(),
  requestAnimationFrameFn = globalObject.requestAnimationFrame?.bind(globalObject),
  cancelAnimationFrameFn = globalObject.cancelAnimationFrame?.bind(globalObject) ?? (() => {}),
  setTimeoutFn = globalObject.setTimeout?.bind(globalObject) ?? globalThis.setTimeout.bind(globalThis),
  clearTimeoutFn = globalObject.clearTimeout?.bind(globalObject) ?? globalThis.clearTimeout.bind(globalThis),
  bootTimeoutMs = SANDBOX_BOOT_TIMEOUT_MS,
} = {}) {
  if (!THREE) throw recordSandboxBootFailure({ state, hud, error: new Error('Three.js failed to load'), clock });
  if (!viewport || !hud) throw recordSandboxBootFailure({ state, hud, error: new Error('sandbox DOM is incomplete'), clock });
  if (typeof requestAnimationFrameFn !== 'function') {
    throw recordSandboxBootFailure({ state, hud, error: new Error('requestAnimationFrame is unavailable'), clock });
  }
  if (globalObject.document?.documentElement?.dataset) {
    globalObject.document.documentElement.dataset.infiniteWorldBuild =
      SANDBOX_RUNTIME_BUILD_IDENTITY.sourceRevision;
    globalObject.document.documentElement.dataset.infiniteWorldFlags = [
      `settlement:${settlementStreamingMode}`,
      'incrementalStaticTreePages:true',
      `persistentStaticNatural:${!disablePersistentTreePublication}`,
      `diagnostics:${diagnosticsEnabled}`,
      `terrainLagSpikeDiagnostics:${terrainLagSpikeDiagnosticsEnabled}`,
    ].join(',');
  }

  let generator = null;
  let chunkDataService = null;
  let chunkGeneratorTransport = null;
  let chunkGenerationMs = 0;
  let renderAdapter = null;
  let runtime = null;
  let worldState = null;
  let saveStore = null;
  let gameplayRenderAdapter = null;
  let gameplay = null;
  let experienceShell = null;
  let renderer = null;
  let visualAssets = null;
  let scene = null;
  let scenePresentation = null;
  let distantPresentation = null;
  let localTerrainCoverageEpoch = 0;
  let audioDirector = null;
  let diagnostics = null;
  let webglRenderDiagnostics = null;
  const originTransformDiagnostics = createOriginTransformDiagnosticRing();
  const terrainLagSpikeDiagnostics = createTerrainLagSpikeDiagnosticCapture({
    enabled: terrainLagSpikeDiagnosticsEnabled,
  });
  let streamingTelemetry = null;
  let worldStreamingCoordinator = null;
  let naturalStaticStream = null;
  let streamingOwnerMetadataCache = null;
  let buildingSettlementStream = null;
  let settlementStreamingFrameSequence = 0;
  let latestSettlementStreamingObservation = null;
  let renderDistanceRequestRevision = 0;
  let naturalStaticStreamActivated = false;
  let naturalStaticStreamSuspended = false;
  let latestNaturalCoverageState = null;
  let canonicalWorldSeedHash = null;
  let availableSaveSnapshot = null;
  let experienceSpawn = null;
  let running = false;
  let animationFrameId = null;
  let currentStageStartedAt = null;
  const staticTreeActivationTimeline = {
    schemaVersion: 'static-tree-activation-timeline-1',
    bootStartedAtMs: clock(),
    coordinatorCreatedAtMs: null,
    staticStreamCreatedAtMs: null,
    distantPresentationCreatedAtMs: null,
    firstShadowPlanGeneratedAtMs: null,
    firstDistantTreeVisibleAtMs: null,
    firstDistantTreeVisiblePathIds: null,
    firstDistantTreeVisibleInstanceCount: null,
    firstDistantTreeQueryCandidateCount: null,
    innerWarmStartedAtMs: null,
    innerWarmCompletedAtMs: null,
    outerWarmStartedAtMs: null,
    outerWarmCompletedAtMs: null,
    staticStreamActivatedAtMs: null,
    firstStaticPlanAppliedAtMs: null,
    firstRequiredOwnerRequestAtMs: null,
    firstReadyOwnerAtMs: null,
    firstPersistentTreePublishAtMs: null,
    firstPersistentTreeDrawAtMs: null,
    activationSource: null,
    activationRunPhase: null,
    activationPaused: null,
  };
  const recordStaticTreeActivationTime = (field, atMs = clock()) => {
    if (staticTreeActivationTimeline[field] === null) {
      staticTreeActivationTimeline[field] = atMs;
    }
    return staticTreeActivationTimeline[field];
  };
  const readSettlementStreamingObservation = renderDistancePreset => (
    distantPresentation?.settlementStreamingShadowSnapshot?.({
      renderDistancePreset,
      includePrepared: true,
      frameSequence: settlementStreamingFrameSequence,
      renderDistanceRevision: renderDistanceRequestRevision,
      stateRevision: worldState?.revision ?? 0,
    }) ?? null
  );
  const activateNaturalStaticStream = source => {
    naturalStaticStreamActivated = true;
    if (staticTreeActivationTimeline.staticStreamActivatedAtMs === null) {
      recordStaticTreeActivationTime('staticStreamActivatedAtMs');
      staticTreeActivationTimeline.activationSource = source;
      staticTreeActivationTimeline.activationRunPhase = experienceShell?.getRunPhase?.() ?? null;
      staticTreeActivationTimeline.activationPaused = experienceShell?.isPaused?.() ?? null;
    }
  };
  const invalidateNaturalStreamingCoverage = reason => {
    latestNaturalCoverageState = null;
    worldStreamingCoordinator?.invalidateCoverage?.(reason);
    return naturalStaticStream?.invalidate?.(reason) ?? 0;
  };

  const startStage = stage => {
    state.stage = stage;
    currentStageStartedAt = clock();
    renderSandboxBootStatus(hud, state);
  };
  const finishStage = stage => {
    const duration = Math.max(0, clock() - currentStageStartedAt);
    state.stageDurations[stage] = (state.stageDurations[stage] ?? 0) + duration;
  };
  const runStage = async (stage, operation) => {
    startStage(stage);
    try {
      return await settleWithin(Promise.resolve().then(operation), {
        stage, timeoutMs: bootTimeoutMs, setTimeoutFn, clearTimeoutFn,
      });
    } finally {
      finishStage(stage);
    }
  };

  try {
    diagnostics = createW8RuntimeDiagnostics({
      globalObject,
      clock,
      profile: diagnosticProfile,
      enabled: diagnosticsEnabled,
      runNumber: diagnosticRunNumber,
      environment: {
        viewport: `${measurementViewport?.width ?? globalObject.innerWidth}x${measurementViewport?.height ?? globalObject.innerHeight}`,
        devicePixelRatio: measurementMode ? 1 : (globalObject.devicePixelRatio ?? 1),
        userAgent: globalObject.navigator?.userAgent ?? 'unknown',
        worldSeed: requestedSeed,
        settlementStreamingMode,
        diagnosticsMode: diagnosticsEnabled ? 'on' : 'off',
      },
    });
    const diagnosticMeasure = diagnostics.enabled
      ? (stage, operation) => diagnostics.measure(stage, operation)
      : (_stage, operation) => operation();
    const recordPipelineDiagnosticEvent = diagnostics.enabled
      ? (type, details) => diagnostics.recordEvent(type, details)
      : null;
    streamingTelemetry = createWorldStreamingTelemetry({
      enabled: streamingTelemetryEnabled,
      capacity: streamingTelemetryCapacity,
      clock,
    });
    streamingOwnerMetadataCache = createStreamingOwnerMetadataCache({
      diagnosticsEnabled: () => diagnostics.enabled,
    });
    const worldStreamingPolicyRegistry = createWorldStreamingPolicyRegistry();
    worldStreamingPolicyRegistry.register(createLegacyRuntimeChunkStreamingPolicy({
      ownerMetadataCache: streamingOwnerMetadataCache,
    }));
    const staticNaturalKinds = Object.freeze(Object.values(W8_VEGETATION_LOD_KINDS));
    const staticNaturalPolicyRuntimes = new Map(staticNaturalKinds.map(kind => {
      const distanceProfileResolver = renderDistancePreset => (
        resolveW8VegetationVisibilityContract(renderDistancePreset).byKind[kind]
      );
      const runtime = createCircularStaticStreamingPolicy({
        kind: `natural-${kind}`,
        publicationGroup: 'natural-static',
        maximumRequiredDistanceMeters: Math.max(
          ...Object.keys(W8_RENDER_DISTANCE_PRESETS).map(renderDistancePreset => (
            Math.max(
              distanceProfileResolver(renderDistancePreset).exactDistanceMeters,
              distanceProfileResolver(renderDistancePreset).horizonDistanceMeters ?? 0,
            )
          )),
        ),
        distanceProfileResolver,
        horizonOwnerDensity: 1,
        ownerMetadataCache: streamingOwnerMetadataCache,
      });
      worldStreamingPolicyRegistry.register(runtime.policy);
      return [runtime.policy.kind, Object.freeze({ ...runtime, naturalKind: kind })];
    }));
    for (const policy of createW8BuildingSettlementShadowPolicies({
      readObservation: readSettlementStreamingObservation,
    })) worldStreamingPolicyRegistry.register(policy);
    let naturalPresentationCoverageGeneration = -1;
    let naturalPresentationCoveragePreset = null;
    let naturalPresentationPolicyCoverage = Object.freeze([]);
    const resolveNaturalPresentationPolicyCoverage = ({
      plan,
      policyPlans,
      policyResourceKindEntries,
      coverageGeneration,
    }) => {
      if (naturalPresentationCoverageGeneration === coverageGeneration
        && naturalPresentationCoveragePreset === plan.renderDistancePreset) {
        return naturalPresentationPolicyCoverage;
      }
      const entriesByPolicy = new Map(policyResourceKindEntries.map(entry => (
        [entry.policyKind, entry.resourceKindEntries]
      )));
      naturalPresentationPolicyCoverage = Object.freeze(policyPlans.map(policyPlan => {
        const runtime = staticNaturalPolicyRuntimes.get(policyPlan.kind);
        const resourceKindEntries = entriesByPolicy.get(policyPlan.kind);
        if (!resourceKindEntries) {
          throw new Error(`missing parsed owner metadata for ${policyPlan.kind}`);
        }
        return Object.freeze({
          ...runtime.maximumCoverage(plan.renderDistancePreset),
          schemaVersion: 'static-natural-policy-coverage-1',
          policyKind: policyPlan.kind,
          naturalKind: runtime.naturalKind,
          resourceKindEntries,
        });
      }));
      naturalPresentationCoverageGeneration = coverageGeneration;
      naturalPresentationCoveragePreset = plan.renderDistancePreset;
      return naturalPresentationPolicyCoverage;
    };
    worldStreamingPolicyRegistry.freeze();
    worldStreamingCoordinator = createWorldStreamingCoordinator({
      registry: worldStreamingPolicyRegistry,
      ownerMetadataCache: streamingOwnerMetadataCache,
    });
    recordStaticTreeActivationTime('coordinatorCreatedAtMs');
    const schedulerTerminalCorrelations = new Set();
    const recordGenerationSchedulerEvent = event => {
      if (event?.type !== 'started' && event?.type !== 'terminal') return;
      const envelope = event?.envelope;
      const correlationId = envelope?.correlationId ?? null;
      if (!streamingTelemetry.enabled && !diagnostics.enabled) return;
      const diagnosticCorrelationId = correlationId
        ?? (envelope?.requestId === undefined ? null : `scheduler:${envelope.requestId}`);
      if (!envelope || (correlationId === null && diagnosticCorrelationId === null)) return;
      const details = {
        correlationId,
        target: envelope.target,
        stream: envelope.stream,
        requestId: envelope.requestId,
        metadata: event.type === 'started'
          ? {
            queueTimeMs: event.queueTimeMs,
            startTimeMs: event.startedAtMs,
            terminalState: null,
            cancellationReason: null,
            deadlineMiss: event.deadlineMiss,
            priorityAging: event.priorityAgingSteps,
            backlog: event.backlog,
          }
          : {
            queueTimeMs: event.scheduler?.queueTimeMs ?? event.queueTimeMs ?? null,
            startTimeMs: event.scheduler?.startedAtMs ?? event.startedAtMs ?? null,
            terminalState: event.state,
            cancellationReason: event.cancellationReason ?? null,
            deadlineMiss: event.scheduler?.deadlineMiss ?? event.deadlineMiss ?? false,
            priorityAging: event.scheduler?.priorityAgingSteps
              ?? event.priorityAgingSteps ?? 0,
            backlog: event.backlog,
            name: event.error?.name ?? null,
            message: event.error?.message ?? null,
            terminalAtMs: event.terminalAtMs ?? null,
            executionWallClockMs: Number.isFinite(event.terminalAtMs)
              && Number.isFinite(event.startedAtMs)
              ? event.terminalAtMs - event.startedAtMs : null,
          },
      };
      if (diagnostics.enabled) diagnostics.recordEvent(
        event.type === 'started' ? 'worker-request-started' : 'worker-request-terminal',
        {
          correlationId: diagnosticCorrelationId,
          target: envelope.target,
          stream: envelope.stream,
          requestId: envelope.requestId,
          operationKind: envelope.operationKind,
          queueTimeMs: details.metadata.queueTimeMs,
          startedAtMs: details.metadata.startTimeMs,
          terminalState: details.metadata.terminalState,
          cancellationReason: details.metadata.cancellationReason,
          deadlineMiss: details.metadata.deadlineMiss,
          priorityAging: details.metadata.priorityAging,
          backlog: details.metadata.backlog,
          terminalAtMs: details.metadata.terminalAtMs ?? null,
          executionWallClockMs: details.metadata.executionWallClockMs ?? null,
        },
      );
      if (!streamingTelemetry.enabled || correlationId === null) return;
      if (event.type === 'started') {
        streamingTelemetry.record(WORLD_STREAMING_EVENT.WORKER_START, details);
      } else if (event.type === 'terminal') {
        schedulerTerminalCorrelations.add(correlationId);
        const type = event.state === 'completed'
          ? WORLD_STREAMING_EVENT.WORKER_COMPLETE
          : event.state === 'cancelled'
            ? WORLD_STREAMING_EVENT.CANCELLED
            : WORLD_STREAMING_EVENT.FAILED;
        streamingTelemetry.record(type, details);
      }
    };
    const traceGenerationBoundary = async ({
      target,
      resourceKey,
      ownerKey = null,
      metadata = null,
    }, operation) => {
      if (!streamingTelemetry.enabled) return operation();
      const correlationId = streamingTelemetry.beginRequest({
        target,
        stream: WORLD_STREAMING_STREAM.DISTANT,
        resourceKey,
        ownerKey,
        metadata,
      });
      try {
        const result = await operation({
          telemetryCorrelationId: correlationId,
          telemetryTarget: target,
          telemetryStream: WORLD_STREAMING_STREAM.DISTANT,
        });
        if (!schedulerTerminalCorrelations.has(correlationId)) {
          streamingTelemetry.record(result === null
            ? WORLD_STREAMING_EVENT.CANCELLED
            : WORLD_STREAMING_EVENT.WORKER_COMPLETE, {
            correlationId,
            target,
            stream: WORLD_STREAMING_STREAM.DISTANT,
            resourceKey,
            ownerKey,
            metadata: result === null
              ? { terminalState: 'cancelled', cancellationReason: 'transport-cancelled' }
              : { terminalState: 'completed', cancellationReason: null },
          });
        }
        return result;
      } catch (error) {
        if (!schedulerTerminalCorrelations.has(correlationId)) {
          streamingTelemetry.record(WORLD_STREAMING_EVENT.FAILED, {
            correlationId,
            target,
            stream: WORLD_STREAMING_STREAM.DISTANT,
            resourceKey,
            ownerKey,
            metadata: {
              terminalState: 'failed',
              cancellationReason: null,
              name: error?.name ?? 'Error',
              message: error?.message ?? String(error),
            },
          });
        }
        throw error;
      } finally {
        schedulerTerminalCorrelations.delete(correlationId);
      }
    };
    const generatorMetadata = await runStage('Legacy Core', async () => {
      const workerTransport = createWorkerChunkGeneratorTransport({
        worldSeed: requestedSeed,
        ...(settlementRoadGraphGeneratorId ? { settlementRoadGraphGeneratorId } : {}),
        ...(settlementLotMode ? { settlementLotMode } : {}),
        workerFactory: chunkGeneratorWorkerFactory ?? undefined,
        fallbackTransportFactory: async () => createInlineChunkGeneratorTransport({
          generator: await generatorFactory({
            worldSeed: requestedSeed,
            ...(settlementRoadGraphGeneratorId ? { settlementRoadGraphGeneratorId } : {}),
            ...(settlementLotMode ? { settlementLotMode } : {}),
          }),
          clock,
          onSchedulerEvent: recordGenerationSchedulerEvent,
        }),
        clock,
        onSchedulerEvent: recordGenerationSchedulerEvent,
        onPipelineEvent: recordPipelineDiagnosticEvent,
      });
      chunkGeneratorTransport = Object.freeze({
        initialize: () => workerTransport.initialize(),
        async generateChunk(request) {
          const startedAt = clock();
          try {
            return await diagnostics.measureAsync(
              'chunk-generation',
              () => workerTransport.generateChunk(request),
            );
          } finally { chunkGenerationMs += Math.max(0, clock() - startedAt); }
        },
        cancelGenerationRequest: options =>
          workerTransport.cancelGenerationRequest(options),
        findSettlementsNear: (...args) => workerTransport.findSettlementsNear(...args),
        resolveSettlementPresentationTemplate: (...args) =>
          workerTransport.resolveSettlementPresentationTemplate(...args),
        requestDiagnostics: () => workerTransport.requestDiagnostics(),
        snapshot: () => workerTransport.snapshot(),
        shutdown: () => workerTransport.shutdown(),
      });
      chunkDataService = new ChunkDataService({
        transport: chunkGeneratorTransport,
        cacheCapacity: 81,
        telemetry: streamingTelemetry,
        onPipelineEvent: recordPipelineDiagnosticEvent,
      });
      return chunkDataService.initialize();
    });
    generator = Object.freeze({
      worldSeed: generatorMetadata.worldSeed,
      worldSeedHash: generatorMetadata.worldSeedHash,
      generatorVersion: generatorMetadata.generatorVersion,
      experienceSpawn: generatorMetadata.experienceSpawn,
      reviewSpawn: generatorMetadata.reviewSpawn,
      distributor: Object.freeze({
        findSettlementsNear: (centerWorldX, centerWorldZ, radiusMeters) =>
          traceGenerationBoundary({
            target: WORLD_STREAMING_TARGET.SETTLEMENT,
            resourceKey: `settlement-query:${centerWorldX}:${centerWorldZ}:${radiusMeters}`,
            metadata: { centerWorldX, centerWorldZ, radiusMeters },
          }, schedulerOptions => chunkGeneratorTransport.findSettlementsNear(
            centerWorldX,
            centerWorldZ,
            radiusMeters,
            schedulerOptions,
          )),
      }),
      resolveSettlementPresentationTemplate: request => {
        const settlementId = request?.candidate?.settlementId ?? request?.settlementId ?? 'unknown';
        return traceGenerationBoundary({
          target: WORLD_STREAMING_TARGET.BUILDING,
          resourceKey: `settlement-template:${settlementId}`,
          metadata: { settlementId },
        }, schedulerOptions => chunkGeneratorTransport.resolveSettlementPresentationTemplate({
          ...request,
          ...schedulerOptions,
        }));
      },
      requestDiagnostics: () => chunkGeneratorTransport.requestDiagnostics(),
      snapshot: () => chunkGeneratorTransport.snapshot().generatorSnapshot,
    });
    canonicalWorldSeedHash = generator.worldSeedHash;
    experienceSpawn = generator.experienceSpawn ?? generator.reviewSpawn;
    await runStage('Save State', async () => {
      worldState = worldStateFactory({
        worldSeed: generator.worldSeed,
        worldSeedHash: generator.worldSeedHash,
        playerSpawn: experienceSpawn,
      });
      let storage = null;
      try {
        if (globalObject.window === globalObject) {
          storage = createBrowserSaveStorage({
            indexedDB: globalObject.indexedDB,
            legacyStorage: globalObject.localStorage ?? null,
          });
        }
      } catch { storage = null; }
      saveStore = saveStoreFactory({
        storage,
        worldSeedHash: generator.worldSeedHash,
        measure: (stage, operation) => diagnostics.measureAsync(stage, operation),
      });
      try {
        availableSaveSnapshot = await saveStore.loadSnapshot();
        state.saveAvailable = availableSaveSnapshot !== null;
      } catch (error) {
        state.saveAvailable = false;
        state.saveError = {
          name: error?.name ?? 'Error',
          message: error?.message ?? String(error),
          code: error?.code ?? null,
        };
      }
      if (saveStore.snapshot().storage?.mode === 'unavailable' && !state.saveError) {
        state.saveError = {
          name: 'SaveStorageUnavailableError',
          message: 'Infinite World save storage is unavailable',
          code: 'SAVE_STORAGE_UNAVAILABLE',
        };
      }
      if (measurementMode) {
        worldState.updateExperience({
          settings: { quality: measurementQuality ?? 'medium', showFps: false, fpsCap: 0 },
        });
      }
    });
    const renderProfile = createRuntimeRenderProfile();
    const selectedRenderChunkSize = renderProfile.selectedRenderChunkSize;

    const rendererContext = await runStage('Renderer', () => {
      const viewportWidth = measurementViewport?.width ?? globalObject.innerWidth;
      const viewportHeight = measurementViewport?.height ?? globalObject.innerHeight;
      const nextScene = new THREE.Scene();
      nextScene.background = new THREE.Color(W8_RENDER_FOG_COLOR_HEX);
      nextScene.fog = new THREE.Fog(
        W8_RENDER_FOG_COLOR_HEX,
        W8_GAMEPLAY_FOG_NEAR,
        defaultRenderDistancePolicy.fogFarMeters * UNITS_PER_METER,
      );
      const nextCamera = new THREE.PerspectiveCamera(
        70,
        viewportWidth / viewportHeight,
        finiteVisualToRender(10),
        W8_GAMEPLAY_CAMERA_FAR,
      );
      const nextRenderer = new THREE.WebGLRenderer({
        antialias: availableSaveSnapshot?.experience?.settings?.antialias !== false,
        powerPreference: 'high-performance', logarithmicDepthBuffer: true,
      });
      nextRenderer.setPixelRatio(measurementMode
        ? 1 : Math.min(globalObject.devicePixelRatio ?? 1, 1.5));
      nextRenderer.setSize(viewportWidth, viewportHeight);
      nextRenderer.outputColorSpace = THREE.SRGBColorSpace;
      nextRenderer.shadowMap ??= {};
      nextRenderer.shadowMap.enabled = true;
      nextRenderer.shadowMap.type = THREE.PCFSoftShadowMap;
      appendElement(viewport, nextRenderer.domElement);

      nextScene.add(new THREE.HemisphereLight(0xffcfa0, 0x4a5c2e, 1.3));
      const sun = new THREE.DirectionalLight(0xffeb3b, 1.2);
      sun.position.set(1500, 2500, 1000);
      sun.castShadow = true;
      sun.shadow ??= { camera: {}, mapSize: {} };
      sun.shadow.camera ??= {};
      Object.assign(sun.shadow.camera, { left: -5000, right: 5000, top: 5000, bottom: -5000 });
      sun.shadow.mapSize ??= {};
      Object.assign(sun.shadow.mapSize, { width: 1024, height: 1024 });
      nextScene.add(sun);

      visualAssets = createW8ParityVisualAssetLibrary({ THREE });
      const playerMarker = visualAssets.createPlayerModel();
      for (const child of playerMarker.children ?? []) child.castShadow = true;
      nextScene.add(playerMarker);
      scenePresentation = createW8ScenePresentation({
        THREE,
        scene: nextScene,
        visualAssets,
        cloudAnchor: experienceSpawn,
      });
      return { nextScene, nextCamera, nextRenderer, playerMarker };
    });
    scene = rendererContext.nextScene;
    const camera = rendererContext.nextCamera;
    renderer = rendererContext.nextRenderer;
    const playerMarker = rendererContext.playerMarker;

    const runtimeContext = await runStage('Chunk Runtime', () => {
      renderAdapter = renderAdapterFactory({
        THREE,
        scene,
        renderChunkSize: selectedRenderChunkSize,
        isFeatureDestroyed: stableId => worldState.isFeatureDestroyed(stableId),
        visualAssets,
        telemetry: streamingTelemetry,
      });
      const chunkIndex = chunkIndexFactory({ capacity: 65_536 });
      const logicalPlayer = worldState.player;
      const initialOwner = decomposeLogicalWorldPosition(logicalPlayer.x, logicalPlayer.z);
      let renderProjectionMs = 0;
      const nearTerrainDiagnosticContext = () => {
        if (!diagnostics.enabled || !runtime) return {};
        const snapshot = runtime.getCommittedChunkState?.() ?? runtime.snapshot?.();
        return {
          transitionGeneration: snapshot?.transitionContract?.generation ?? null,
          coverageSignature: snapshot?.transitionContract?.coverageSignature ?? null,
          centerChunkX: snapshot?.centerChunkX ?? null,
          centerChunkZ: snapshot?.centerChunkZ ?? null,
          renderOriginRevision: snapshot?.renderOrigin?.rebaseCount ?? null,
        };
      };
      const measuredRenderAdapter = {
        rebase: origin => diagnostics.measure('chunk-rebase', () => renderAdapter.rebase(origin)),
        async projectChunk(chunkData, origin, options) {
          const startedAt = clock();
          try {
            const projected = await diagnostics.measureAsync(
              'chunk-projection',
              () => renderAdapter.projectChunk(chunkData, origin, options),
            );
            diagnostics.recordEvent('near-terrain-replacement-ready', {
              ...nearTerrainDiagnosticContext(),
              ownerKey: projected?.key ?? null,
              rootName: projected?.group?.name ?? null,
              sceneAttached: projected?.group?.parent !== null,
            });
            return projected;
          }
          finally { renderProjectionMs += Math.max(0, clock() - startedAt); }
        },
        projectTerrainChunk: (chunkData, origin) => (
          renderAdapter.projectTerrainChunk?.(chunkData, origin)
        ),
        loadProjectedTerrain: projected => renderAdapter.loadProjectedTerrain?.(projected),
        loadProjected: projected => {
          const result = diagnostics.measure(
            'chunk-load', () => renderAdapter.loadProjected(projected),
          );
          diagnostics.recordEvent('near-terrain-replacement-attached', {
            ...nearTerrainDiagnosticContext(),
            ownerKey: projected?.key ?? null,
            rootName: projected?.group?.name ?? null,
            sceneAttached: projected?.group?.parent !== null,
          });
          return result;
        },
        unloadChunk: key => {
          diagnostics.recordEvent('near-terrain-old-release-requested', {
            ...nearTerrainDiagnosticContext(),
            ownerKey: key,
          });
          const result = diagnostics.measure(
            'chunk-unload', () => renderAdapter.unloadChunk(key, {
              deferSettlementPresentation: true,
            }),
          );
          diagnostics.recordEvent('near-terrain-old-released', {
            ...nearTerrainDiagnosticContext(),
            ownerKey: key,
          });
          return result;
        },
        discardProjected: projected => diagnostics.measure(
          'chunk-discard', () => renderAdapter.discardProjected?.(projected),
        ),
        retainTerrainChunk: key => renderAdapter.retainTerrainChunk?.(key),
        unloadProvisionalTerrain: key => renderAdapter.unloadProvisionalTerrain?.(key),
        renderCoverageSnapshot: () => renderAdapter.renderCoverageSnapshot?.() ?? null,
        shutdown: () => renderAdapter.shutdown(),
      };
      runtime = runtimeFactory({
        chunkDataService,
        renderAdapter: measuredRenderAdapter,
        cacheCapacity: 81,
        chunkIndex,
        onPipelineEvent: recordPipelineDiagnosticEvent,
      });
      return {
        logicalPlayer,
        initialOwner,
        getChunkGenerationMs: () => chunkGenerationMs,
        getRenderProjectionMs: () => renderProjectionMs,
      };
    });
    const { logicalPlayer, initialOwner } = runtimeContext;

    await runStage('Terrain', () => runtime.initialize(initialOwner.chunkX, initialOwner.chunkZ));
    scenePresentation.rebase(runtime.snapshot().renderOrigin);
    const staticNaturalPolicyKinds = Object.freeze([...staticNaturalPolicyRuntimes.keys()]);
    naturalStaticStream = createStaticObjectStream({
      policyKind: staticNaturalPolicyKinds[0],
      policyKinds: staticNaturalPolicyKinds,
      classifyOwner: ({ ownerKey, owner, plan, policyPlan }) => (
        staticNaturalPolicyRuntimes.get(policyPlan.kind).classifyOwner({
          ownerKey,
          owner,
          plan,
          policyPlan,
        })
      ),
      combineResourceKinds: ({ resourceKinds }) => {
        if (resourceKinds.some(kind => kind !== 'canonical')) {
          throw new Error('Static Natural requires canonical ChunkData for every owner');
        }
        return 'canonical';
      },
      ownerMetadataCache: streamingOwnerMetadataCache,
      clock,
      requestOwner: ({
        ownerKey,
        ownerX,
        ownerZ,
        resourceKind,
        priority,
        required,
        deadlineAtMs,
        epoch,
        planId,
      }) => {
        if (required) recordStaticTreeActivationTime('firstRequiredOwnerRequestAtMs');
        const observeReady = handle => {
          void Promise.resolve(handle?.promise ?? handle).then(value => {
            if (value !== null && value !== undefined) {
              recordStaticTreeActivationTime('firstReadyOwnerAtMs');
            }
          }, () => {});
          return handle;
        };
        const chunkX = ownerX;
        const chunkZ = ownerZ;
        if (!Number.isSafeInteger(chunkX) || !Number.isSafeInteger(chunkZ)) {
          throw new TypeError(`Static Object Stream missing parsed owner metadata: ${ownerKey}`);
        }
        const consumerId = `static-object-stream:natural-static:${ownerKey}`;
        if (resourceKind !== 'canonical') {
          throw new Error(`Static Natural no longer accepts Remote Tree resources: ${resourceKind}`);
        }
        const existing = runtime.getChunkData(chunkX, chunkZ);
        if (existing) return observeReady(Object.freeze({
          promise: Promise.resolve(existing), cancel: () => false,
        }));
        return observeReady(chunkDataService.requestChunk({
          chunkX,
          chunkZ,
          priority,
          required,
          deadlineAtMs,
          consumerId,
          epoch,
          telemetryTarget: WORLD_STREAMING_TARGET.TREE,
          telemetryStream: WORLD_STREAMING_STREAM.DISTANT,
        }));
      },
    });
    recordStaticTreeActivationTime('staticStreamCreatedAtMs');
    distantPresentation = await createW8DistantPresentation({
      THREE,
      scene,
      worldSeedHash: generator.worldSeedHash,
      visualAssets,
      // Persistent buckets survive render-distance publication. Size them for
      // every registered preset so an atomic Short -> Current switch can keep
      // the old presentation alive while the replacement coverage is staged.
      resolveStaticNaturalCapacity: () => Object.freeze(
        [...staticNaturalPolicyRuntimes.values()].map(runtime => Object.freeze({
          naturalKind: runtime.naturalKind,
          maximumCanonicalOwnerCount: Math.max(
            ...Object.keys(W8_RENDER_DISTANCE_PRESETS).map(preset => (
              runtime.maximumCoverage(preset).maximumCanonicalOwnerCount
            )),
          ),
          maximumManifestOwnerCount: Math.max(
            ...Object.keys(W8_RENDER_DISTANCE_PRESETS).map(preset => (
              runtime.maximumCoverage(preset).maximumManifestOwnerCount
            )),
          ),
        })),
      ),
      findSettlementsNear: generator.distributor.findSettlementsNear,
      resolveTemplate: request => generator.resolveSettlementPresentationTemplate(request),
      getCanonicalChunkData: async (chunkX, chunkZ, request = {}) => {
        const ownerKey = `${chunkX},${chunkZ}`;
        const fallback = async () => {
        const existing = runtime.getChunkData(chunkX, chunkZ);
        if (!streamingTelemetry.enabled) {
          return existing ?? chunkDataService.requestChunk({
            chunkX,
            chunkZ,
            priority: request.priority ?? CHUNK_DATA_PRIORITY.DISTANT_OWNER,
            consumerId: request.consumerId ?? 'distant-owner-query',
            epoch: request.epoch ?? 0,
          }).promise;
        }
        const correlationId = streamingTelemetry.beginRequest({
          target: WORLD_STREAMING_TARGET.DISTANT,
          stream: WORLD_STREAMING_STREAM.DISTANT,
          resourceKey: ownerKey,
          ownerKey,
          metadata: {
            consumerId: request.consumerId ?? 'distant-owner-query',
            epoch: request.epoch ?? 0,
          },
        });
        if (existing) {
          streamingTelemetry.record(WORLD_STREAMING_EVENT.CACHE_HIT, {
            correlationId,
            target: WORLD_STREAMING_TARGET.DISTANT,
            stream: WORLD_STREAMING_STREAM.DISTANT,
            resourceKey: ownerKey,
            ownerKey,
            metadata: { cache: 'runtime' },
          });
          return existing;
        }
        return chunkDataService.requestChunk({
          chunkX,
          chunkZ,
          priority: request.priority ?? CHUNK_DATA_PRIORITY.DISTANT_OWNER,
          consumerId: request.consumerId ?? 'distant-owner-query',
          epoch: request.epoch ?? 0,
          telemetryTarget: WORLD_STREAMING_TARGET.DISTANT,
          telemetryStream: WORLD_STREAMING_STREAM.DISTANT,
          telemetryCorrelationId: correlationId,
        }).promise;
        };
        if (naturalStaticStreamSuspended) return fallback();
        return naturalStaticStream.requestOrReuse({
          ownerKey,
          resourceKind: 'canonical',
          fallback,
        });
      },
      cancelCanonicalChunkRequests: options => {
        const cancelled = chunkDataService.cancelConsumer(options);
        return cancelled;
      },
      publishStaticOwnerTickets: ({ ownerKeys }) => {
        const published = naturalStaticStream.publishOwners({ ownerKeys });
        if (published.length > 0) {
          recordStaticTreeActivationTime('firstPersistentTreePublishAtMs');
          activateNaturalStaticStream('publication-ticket');
        }
        return published;
      },
      incrementalStaticTreePages: true,
      isFeatureDestroyed: stableId => worldState.isFeatureDestroyed(stableId),
      getNearVisibleStableIds: () =>
        renderAdapter.visibleStableIdsSnapshot?.() ?? [],
      getNearVisibleSettlementIds: () => renderAdapter.visibleSettlementIdsSnapshot?.() ?? [],
      getNearPresentationHolds: () => renderAdapter.presentationHoldSnapshot?.() ?? [],
      releaseNearPresentationHolds: request => (
        renderAdapter.releaseSettlementPresentationHolds?.(request)
        ?? Object.freeze({ released: true, releasedAtMs: clock() })
      ),
      measure: (stage, operation) => diagnostics.measure(stage, operation),
      telemetry: streamingTelemetry,
      diagnosticsEnabled: diagnostics.enabled,
      recordDiagnosticWork: (route, values) => diagnostics.recordWork(route, values),
      recordDiagnosticEvent: (type, details) => diagnostics.recordEvent(type, details),
      getDiagnosticFrameSequence: () => diagnostics.currentFrameSequence(),
    });
    recordStaticTreeActivationTime('distantPresentationCreatedAtMs');
    const recordDistantTreeVisibility = () => {
      if (staticTreeActivationTimeline.firstDistantTreeVisibleAtMs !== null) return true;
      const treePaths = distantPresentation.treePathAuditSnapshot?.() ?? [];
      const visiblePaths = treePaths.filter(path => path.active && path.instanceCount > 0);
      if (visiblePaths.length === 0) return false;
      const presentationSnapshot = diagnosticMeasure(
        'distant-diagnostics-snapshot',
        () => distantPresentation.snapshot(),
      );
      recordStaticTreeActivationTime('firstDistantTreeVisibleAtMs');
      staticTreeActivationTimeline.firstDistantTreeVisiblePathIds = Object.freeze(
        visiblePaths.map(path => path.pathId),
      );
      staticTreeActivationTimeline.firstDistantTreeVisibleInstanceCount = visiblePaths.reduce(
        (sum, path) => sum + path.instanceCount, 0,
      );
      staticTreeActivationTimeline.firstDistantTreeQueryCandidateCount =
        presentationSnapshot.queryNaturalCandidateCount;
      return true;
    };
    {
      const runtimeSnapshot = runtime.getCommittedChunkState();
      distantPresentation.syncLocalTerrain({
        coverageEpoch: ++localTerrainCoverageEpoch,
        transitionContract: runtimeSnapshot.transitionContract,
        activeDataKeys: runtimeSnapshot.activeDataKeys,
        renderedKeys: runtimeSnapshot.renderedKeys,
        getChunkData: (chunkX, chunkZ) => runtime.getChunkData(chunkX, chunkZ),
        renderOrigin: runtimeSnapshot.renderOrigin,
        centerChunkX: runtimeSnapshot.centerChunkX,
        centerChunkZ: runtimeSnapshot.centerChunkZ,
        renderDistancePreset: worldState.experience.settings.renderDistance,
      });
    }
    if (diagnosticProfile.distant) {
      const runtimeSnapshot = runtime.snapshot();
      await diagnostics.measureAsync('distant-sync', () => distantPresentation.sync({
          transitionContract: runtimeSnapshot.transitionContract,
          activeDataKeys: runtimeSnapshot.activeDataKeys,
          renderedKeys: runtimeSnapshot.renderedKeys,
          getChunkData: (chunkX, chunkZ) => runtime.getChunkData(chunkX, chunkZ),
           renderOrigin: runtimeSnapshot.renderOrigin,
           centerChunkX: runtimeSnapshot.centerChunkX,
           centerChunkZ: runtimeSnapshot.centerChunkZ,
           quality: worldState.experience.settings.quality,
           renderDistancePreset: worldState.experience.settings.renderDistance,
           playerLogicalX: logicalPlayer.x,
           playerLogicalZ: logicalPlayer.z,
           includeFarNatural: false,
           includeUltraNatural: false,
          }));
      recordDistantTreeVisibility();
    }
    buildingSettlementStream = createBuildingSettlementStream({
      initialMode: settlementStreamingMode,
      async buildStage({ observation, isCurrent }) {
        await Promise.resolve();
        if (!isCurrent()) throw new Error('Building/Settlement staging cancelled');
        return {
          sceneAttached: false,
          capacity: observation.settlementOwnerKeys.length,
          ownerKeys: [...observation.settlementOwnerKeys],
          stableIds: [...observation.stableIds],
          roadLinkages: [...observation.roadLinkages],
          damageStates: [...observation.damageStates],
          invalidRoadLinkageCount: observation.invalidRoadLinkageCount,
          dispose() {},
        };
      },
      publishStage: stage => distantPresentation.claimBuildingSettlementPublication?.(
        stage,
        {
          publicationKinds: Object.freeze([
            'building',
            'settlement-road',
            'metadata-remote',
          ]),
          observation: stage.observation,
          currentObservation: latestSettlementStreamingObservation ?? stage.observation,
          renderDistanceRevision: renderDistanceRequestRevision,
        },
      ) === true,
    });
    if (settlementStreamingMode === BUILDING_SETTLEMENT_STREAM_MODE.LEGACY) {
      distantPresentation.useLegacyBuildingSettlementPublication?.();
    }
    webglRenderDiagnostics = createWebGLRenderDiagnostics({
      enabled: diagnostics.enabled,
      THREE,
      renderer,
      scene,
      camera,
      canvas: renderer.domElement,
      buildIdentity: SANDBOX_RUNTIME_BUILD_IDENTITY,
      clock,
      forceFirstIncident: forceFirstWebGLDiagnosticIncident,
      publishProof(frame, ringSnapshot) {
        const dataset = globalObject.document?.documentElement?.dataset;
        if (!dataset) return;
        const firstInstanced = frame.meshDrawState.find(mesh => (
          mesh.count > 0 && mesh.instanceMatrixGpuVersion !== null
        )) ?? frame.meshDrawState.find(mesh => (
          mesh.count > 0 && mesh.instanceMatrixVersion !== null
        ));
        dataset.infiniteWorldWebglProof = JSON.stringify({
          realWebGLRenderer: true,
          frameSequence: frame.frameSequence,
          rendererInfo: frame.rendererInfo,
          rootCount: frame.sceneDrawState.roots.length,
          meshCount: frame.meshDrawState.length,
          allRenderableMainDrawCount: frame.sceneDrawState.allRenderableMainDrawCount,
          roleDrawCounts: frame.sceneDrawState.roleDrawCounts,
          firstInstanced: firstInstanced ? {
            name: firstInstanced.name,
            role: firstInstanced.role,
            count: firstInstanced.count,
            instanceMatrixVersion: firstInstanced.instanceMatrixVersion,
            instanceMatrixGpuVersion: firstInstanced.instanceMatrixGpuVersion,
            actualDrawCount: firstInstanced.actualDrawCount,
            gpuBufferUploadCount: firstInstanced.gpuBufferUploadCount,
            gpuBufferUploadBytes: firstInstanced.gpuBufferUploadBytes,
          } : null,
          anomalyCodes: frame.anomalyCodes,
          screenshot: ringSnapshot.canvasScreenshot ? {
            mimeType: ringSnapshot.canvasScreenshot.mimeType,
            width: ringSnapshot.canvasScreenshot.width,
            height: ringSnapshot.canvasScreenshot.height,
            dataUrlPrefix: ringSnapshot.canvasScreenshot.dataUrl?.slice(0, 32) ?? null,
            dataUrlLength: ringSnapshot.canvasScreenshot.dataUrl?.length ?? 0,
            error: ringSnapshot.canvasScreenshot.error,
          } : null,
        });
      },
    });
    state.chunkGenerationMs = runtimeContext.getChunkGenerationMs();
    state.renderProjectionMs = runtimeContext.getRenderProjectionMs();

    await runStage('Settlement', async () => {
      const runtimeSnapshot = runtime.snapshot();
      const generatorSnapshot = await generator.requestDiagnostics();
      const initialSettlementIds = new Set();
      for (const key of runtimeSnapshot.activeDataKeys) {
        const [chunkX, chunkZ] = key.split(',').map(Number);
        for (const reference of runtime.getChunkData(chunkX, chunkZ)?.settlementReferences ?? []) {
          initialSettlementIds.add(reference.settlementId);
        }
      }
      state.initialChunkCount = runtimeSnapshot.counts.generated;
      state.initialRenderedChunkCount = runtimeSnapshot.renderedCount;
      state.initialPrefetchedChunkCount = runtimeSnapshot.activeDataCount;
      state.initialSettlementCount = initialSettlementIds.size;
      state.macroRegionsEvaluated = generatorSnapshot.distributor.rawCacheSize;
      state.rawSettlementCandidateCount = generatorSnapshot.distributor.rawCandidateCount;
      state.acceptedSettlementCandidateCount = generatorSnapshot.distributor.acceptedSettlementCount;
      state.materializedSettlementCount = generatorSnapshot.templateCacheSize;
      state.settlementGenerationMs = generatorSnapshot.templateGenerationMs;
    });

    await runStage('Gameplay', async () => {
      gameplayRenderAdapter = gameplayRenderAdapterFactory({
        THREE,
        scene,
        renderChunkSize: selectedRenderChunkSize,
        visualAssets,
        telemetry: streamingTelemetry,
      });
      gameplayRenderAdapter.consumePresentationEvents?.([], { playerMarker });
      gameplay = gameplayRuntimeFactory({
        worldSeedHash: generator.worldSeedHash,
        generatorMajor: generator.generatorVersion.major,
        state: worldState,
        renderAdapter: gameplayRenderAdapter,
        featureRenderAdapter: renderAdapter,
        getChunkDataForQuery: (chunkX, chunkZ, {
          consumerId = 'gameplay-tank-terrain', epoch = 0,
        } = {}) => runtime.getChunkData(chunkX, chunkZ) ?? chunkDataService.requestChunk({
          chunkX,
          chunkZ,
          priority: CHUNK_DATA_PRIORITY.GAMEPLAY_REQUIRED,
          consumerId,
          epoch,
          telemetryTarget: WORLD_STREAMING_TARGET.GAMEPLAY,
          telemetryStream: WORLD_STREAMING_STREAM.GAMEPLAY,
        }).promise,
        cancelChunkDataQueries: options => chunkDataService.cancelConsumer(options),
        sampleTerrainHeight: sampleCanonicalTerrainHeightMeters,
        clock,
      });
      const runtimeSnapshot = runtime.snapshot();
      if (diagnosticProfile.gameplaySync) {
        await diagnostics.measureAsync('gameplay-sync', () => gameplay.syncActiveChunks({
          transitionContract: runtimeSnapshot.transitionContract,
          activeDataKeys: runtimeSnapshot.activeDataKeys,
          renderedKeys: runtimeSnapshot.renderedKeys,
          getChunkData: (chunkX, chunkZ) => runtime.getChunkData(chunkX, chunkZ),
          renderOrigin: runtimeSnapshot.renderOrigin,
        }));
      }
      const gameplaySnapshot = gameplay.snapshot();
      state.initialSimulationChunkCount = gameplaySnapshot.activeSimulationChunkCount;
      state.initialGameplayEntityCount = gameplaySnapshot.simulatedEntityCount;
    });

    let transitionTargetKey = null;
    let transitionRetryTimer = null;
    const directionalPrefetchPending = new Set();
    let terrainReadyRequestedSignature = null;
    let transitionError = null;
    let lastTerrainCoverageMissOwnerKey = null;
    let lastSafePlayerTerrainHeightMeters = sampleCanonicalTerrainHeightMeters(
      logicalPlayer.x,
      logicalPlayer.z,
    );
    let terrainFallbackStartedAtMs = null;
    let lastTerrainFallbackOwnerKey = null;
    const terrainMovementDiagnostics = {
      movementBlockedByTerrain: 0,
      movementBlockedByTerrainMs: 0,
      terrainFallbackFrame: 0,
      terrainFallbackMaxDuration: 0,
      fallbackGenerationAge: 0,
      maximumFallbackGenerationAge: 0,
      latestGenerationLagChunks: 0,
      maximumGenerationLagChunks: 0,
      presentationSwapCount: 0,
      preparedMissCount: 0,
      visualBlankFrame: 0,
      visualWorldCoverageMiss: 0,
      collisionCoverageMiss: 0,
      latestVisualCoverage: null,
    };
    let lastTerrainPresentationSwapAtMs = null;
    let terrainLagSpikeCapturePublished = false;
    const publishTerrainLagSpikeCapture = reason => {
      if (!terrainLagSpikeDiagnosticsEnabled || terrainLagSpikeCapturePublished) return false;
      const documentObject = globalObject.document;
      if (!documentObject?.createElement || !documentObject.documentElement) return false;
      const runtimeSnapshot = runtime.snapshot();
      const payload = Object.freeze({
        schemaVersion: 'terrain-lag-spike-browser-capture-1',
        reason,
        publishedAtMs: clock(),
        browser: Object.freeze({
          visibilityState: documentObject.visibilityState ?? null,
          hasFocus: documentObject.hasFocus?.() ?? null,
        }),
        capture: terrainLagSpikeDiagnostics.snapshot(),
        terrainCoverage: Object.freeze({ ...terrainMovementDiagnostics }),
        terrainScheduler: distantPresentation.terrainPresentationSchedulerSnapshot?.() ?? null,
        terrainPresentation: runtimeSnapshot.terrainReady?.terrainPresentationScheduling ?? null,
        terrainDependencies: runtimeSnapshot.terrainReady?.terrainDependencyDiagnostics ?? null,
        chunkData: chunkDataService.snapshot(),
        diagnostics: diagnostics.snapshot(),
      });
      const element = documentObject.createElement('script');
      element.id = 'terrain-lag-spike-capture';
      element.type = 'application/json';
      element.textContent = JSON.stringify(payload);
      documentObject.documentElement.append(element);
      terrainLagSpikeCapturePublished = true;
      return true;
    };
    const recordTerrainLagSpikeFrame = ({ frameNow, rawFrameMs, schedulerFrame }) => {
      if (!terrainLagSpikeDiagnosticsEnabled) return false;
      const runtimeSpike = runtime.terrainLagSpikeDiagnosticSnapshot?.() ?? null;
      const scheduler = distantPresentation.terrainPresentationSchedulerSnapshot?.() ?? null;
      const frameDiagnostics = diagnostics.currentFrameSnapshot?.() ?? null;
      const chunkCounts = chunkDataService.counts ?? {};
      const playerOwner = decomposeLogicalWorldPosition(logicalPlayer.x, logicalPlayer.z);
      const usedHeapBytes = Number(globalObject.performance?.memory?.usedJSHeapSize);
      const activeSchedulerGeneration = scheduler?.activeGenerations?.[0] ?? null;
      const recorded = terrainLagSpikeDiagnostics.record({
        timestampMs: frameNow,
        frameSequence: frameDiagnostics?.sequence ?? settlementStreamingFrameSequence,
        frameMs: rawFrameMs,
        rafIntervalMs: rawFrameMs,
        lagChunks: terrainMovementDiagnostics.latestGenerationLagChunks,
        playerCenter: Object.freeze({
          chunkX: playerOwner.chunkX,
          chunkZ: playerOwner.chunkZ,
          key: playerOwner.key,
        }),
        activeTerrainCenter: terrainMovementDiagnostics.latestVisualCoverage === null
          ? null : Object.freeze({
            chunkX: terrainMovementDiagnostics.latestVisualCoverage.activeCenterChunkX,
            chunkZ: terrainMovementDiagnostics.latestVisualCoverage.activeCenterChunkZ,
          }),
        pendingCenter: runtimeSpike?.pending ?? null,
        inFlightCenter: runtimeSpike?.inFlight ?? null,
        runtimeCenter: runtimeSpike?.runtimeCenter ?? null,
        generation: runtimeSpike?.generation ?? null,
        currentGeneration: activeSchedulerGeneration === null && runtimeSpike?.inFlight === null
          ? null : Object.freeze({
            ...(runtimeSpike?.inFlight ?? {}),
            scheduler: activeSchedulerGeneration,
          }),
        scheduler: scheduler === null ? null : Object.freeze({
          pumpCalled: schedulerFrame !== null,
          pumpResumed: schedulerFrame?.resumed ?? 0,
          pumpAllowance: schedulerFrame?.allowance ?? 0,
          pumpPending: schedulerFrame?.pending ?? 0,
          terrainSliceCount: scheduler.terrainSliceCount,
          resumeWaitP95Ms: scheduler.terrainResumeWaitP95Ms,
          resumeWaitMaxMs: scheduler.terrainResumeWaitMaxMs,
          deadlineMissCount: scheduler.terrainDeadlineMissCount,
          deadlineMissMaxMs: scheduler.terrainDeadlineMissMaxMs,
          frameSequence: scheduler.frameSequence,
        }),
        dependency: Object.freeze({
          ...(runtimeSpike?.dependency ?? {}),
          inFlightDataReadyCount: runtimeSpike?.inFlight?.dataReadyCount ?? null,
          inFlightDataRequiredCount: runtimeSpike?.inFlight?.dataRequiredCount ?? null,
          inFlightRenderReadyCount: runtimeSpike?.inFlight?.renderReadyCount ?? null,
          inFlightRenderRequiredCount: runtimeSpike?.inFlight?.renderRequiredCount ?? null,
          pendingDataReadyCount: runtimeSpike?.pending?.dataReadyCount ?? null,
          pendingDataRequiredCount: runtimeSpike?.pending?.dataRequiredCount ?? null,
          pendingRenderReadyCount: runtimeSpike?.pending?.renderReadyCount ?? null,
          pendingRenderRequiredCount: runtimeSpike?.pending?.renderRequiredCount ?? null,
        }),
        chunkData: Object.freeze({
          queueLength: chunkDataService.queue?.reduce?.(
            (count, entry) => count + Number(entry.state === 'queued'),
            0,
          ) ?? 0,
          pendingCount: chunkDataService.pending?.size ?? 0,
          inFlightCount: Number(chunkDataService.inFlight !== null)
            + Number(chunkDataService.requiredLookahead !== null)
            + (chunkDataService.requiredLookaheadQueue?.length ?? 0),
          cacheSize: chunkDataService.completed?.size ?? 0,
          requests: chunkCounts.requests ?? 0,
          cacheHits: chunkCounts.completedCacheHits ?? 0,
          pendingDedupeHits: chunkCounts.pendingDedupeHits ?? 0,
          completed: chunkCounts.completedOperations ?? 0,
        }),
        presentation: Object.freeze({
          swapCount: terrainMovementDiagnostics.presentationSwapCount,
          lastSwapAtMs: lastTerrainPresentationSwapAtMs,
          fallbackFrames: terrainMovementDiagnostics.terrainFallbackFrame,
          visualCoverageMiss: terrainMovementDiagnostics.visualWorldCoverageMiss,
        }),
        mainThread: frameDiagnostics,
        memory: Object.freeze({
          usedHeapBytes: Number.isFinite(usedHeapBytes) ? usedHeapBytes : null,
        }),
        browser: Object.freeze({
          visibilityState: globalObject.document?.visibilityState ?? null,
          hasFocus: globalObject.document?.hasFocus?.() ?? null,
        }),
      });
      if (terrainLagSpikeDiagnostics.isFrozen()) publishTerrainLagSpikeCapture('lag-threshold');
      else if (measurement.status === 'complete') publishTerrainLagSpikeCapture('measurement-complete');
      return recorded;
    };
    let playerRelocationInProgress = false;
    let lastTelemetryArrival = null;
    const recordPlayerArrival = (owner, arrivedAt) => {
      if (!streamingTelemetry.enabled || !owner?.key
        || owner.key === lastTelemetryArrival?.ownerKey) return;
      const elapsedSeconds = lastTelemetryArrival
        ? Math.max(0, arrivedAt - lastTelemetryArrival.arrivedAt) / 1000 : 0;
      const speedMetersPerSecond = elapsedSeconds > 0
        ? Math.hypot(
          logicalPlayer.x - lastTelemetryArrival.x,
          logicalPlayer.z - lastTelemetryArrival.z,
        ) / elapsedSeconds
        : 0;
      const playerLogical = { x: logicalPlayer.x, z: logicalPlayer.z };
      const targets = [
        [WORLD_STREAMING_STREAM.NEAR, WORLD_STREAMING_TARGET.NEAR],
        [WORLD_STREAMING_STREAM.NEAR, WORLD_STREAMING_TARGET.TREE],
        [WORLD_STREAMING_STREAM.NEAR, WORLD_STREAMING_TARGET.BUSH],
        [WORLD_STREAMING_STREAM.NEAR, WORLD_STREAMING_TARGET.GRASS],
        [WORLD_STREAMING_STREAM.NEAR, WORLD_STREAMING_TARGET.ROCK],
        [WORLD_STREAMING_STREAM.NEAR, WORLD_STREAMING_TARGET.BUILDING],
        [WORLD_STREAMING_STREAM.NEAR, WORLD_STREAMING_TARGET.SETTLEMENT],
        [WORLD_STREAMING_STREAM.DISTANT, WORLD_STREAMING_TARGET.DISTANT],
        [WORLD_STREAMING_STREAM.DISTANT, WORLD_STREAMING_TARGET.TREE],
        [WORLD_STREAMING_STREAM.DISTANT, WORLD_STREAMING_TARGET.BUSH],
        [WORLD_STREAMING_STREAM.DISTANT, WORLD_STREAMING_TARGET.GRASS],
        [WORLD_STREAMING_STREAM.DISTANT, WORLD_STREAMING_TARGET.ROCK],
        [WORLD_STREAMING_STREAM.DISTANT, WORLD_STREAMING_TARGET.BUILDING],
        [WORLD_STREAMING_STREAM.DISTANT, WORLD_STREAMING_TARGET.SETTLEMENT],
        [WORLD_STREAMING_STREAM.GAMEPLAY, WORLD_STREAMING_TARGET.GAMEPLAY],
      ];
      for (const [stream, target] of targets) {
        streamingTelemetry.record(WORLD_STREAMING_EVENT.PLAYER_ARRIVAL, {
          target,
          stream,
          resourceKey: owner.key,
          ownerKey: owner.key,
          playerLogical,
          speedMetersPerSecond,
        });
      }
      lastTelemetryArrival = {
        ownerKey: owner.key,
        arrivedAt,
        x: logicalPlayer.x,
        z: logicalPlayer.z,
      };
    };
    const initialSaveStorageMode = saveStore.snapshot().storage?.mode;
    let saveStatus = initialSaveStorageMode === 'unavailable'
      || state.saveError?.code === 'SAVE_STORAGE_UNAVAILABLE'
      ? 'unavailable'
      : state.saveAvailable
        ? initialSaveStorageMode === 'legacy-fallback' ? 'fallback' : 'available'
        : state.saveError ? 'invalid' : 'new';
    let returnTitleSavePromise = null;
    let lastFrameAt = clock();
    let latestFrameDurationMs = 0;
    let lastHudAt = 0;
    let lastVisualPlayerX = logicalPlayer.x;
    let lastVisualPlayerZ = logicalPlayer.z;
    let diagnosticFrameStarted = false;
    let saveTimer = null;
    let saveIdleCallback = null;
    let lastSavedRevision = -1;
    let lastSavedGeneration = 0;
    let exitSaveRevision = null;
    let exitSavePromise = null;
    let runStarted = false;
    let lastRunStartDiagnostics = null;
    let postCommitRequestedEpoch = 0;
    let postCommitCompletedEpoch = 0;
    let postCommitFailureCount = 0;
    let postCommitLastError = null;
    let postCommitPumpActive = false;
    let postCommitTimer = null;
    let farNaturalWarmStarted = false;
    let ultraNaturalWarmStarted = false;
    let naturalWarmRetryAt = 0;
    const gameplaySyncWorkByEpoch = new Map();
    let saveDeferredForStreaming = false;
    let lastCameraCollision = Object.freeze({
      collided: false, stableId: null, desiredDistance: 0, resolvedDistance: 0,
    });
    const measurement = {
      mode: measurementMode,
      warmupMs: 10_000,
      sampleMs: 60_000,
      protocolStartedAt: null,
      samplingStartedAt: null,
      completedAt: null,
      status: measurementMode ? 'warmup' : 'disabled',
    };
    let streamingAcceptanceMetrics = null;
    const collectStreamingAcceptanceMetrics = () => (
      collectWorldStreamingAcceptanceMetrics(streamingTelemetry.snapshot())
    );
    let distantQuality = worldState.experience.settings.quality;
    let distantRenderDistance = normalizeW8RenderDistancePreset(
      worldState.experience.settings.renderDistance
        ?? W8_DEFAULT_RENDER_DISTANCE_PRESET,
    );
    let requestedDistantRenderDistance = distantRenderDistance;
    let pendingRenderDistancePublication = null;
    let appliedStaticNaturalRetainedOwnerKeys = Object.freeze([]);
    let buildingSettlementShadowComparison = null;
    let buildingSettlementStagingSignature = null;
    running = true;

    const synchronizeDistantPresentation = (runtimeSnapshot, {
      includeUltraNatural = true,
      revealNatural = false,
      naturalRevealInnerMeters = 0,
      renderDistancePreset = distantRenderDistance,
      deferPublication = false,
      preserveStaticNatural = false,
    } = {}) => distantPresentation.sync({
      transitionContract: runtimeSnapshot.transitionContract,
      activeDataKeys: runtimeSnapshot.activeDataKeys,
      renderedKeys: runtimeSnapshot.renderedKeys,
      getChunkData: (chunkX, chunkZ) => runtime.getChunkData(chunkX, chunkZ),
      renderOrigin: runtimeSnapshot.renderOrigin,
      centerChunkX: runtimeSnapshot.centerChunkX,
      centerChunkZ: runtimeSnapshot.centerChunkZ,
      quality: distantQuality,
      renderDistancePreset,
      playerLogicalX: logicalPlayer.x,
      playerLogicalZ: logicalPlayer.z,
      includeUltraNatural,
      revealNatural,
      naturalRevealInnerMeters,
      deferPublication,
      preserveStaticNatural,
    });

    const synchronizeLocalTerrain = runtimeSnapshot => distantPresentation.syncLocalTerrain({
      coverageEpoch: ++localTerrainCoverageEpoch,
      transitionContract: runtimeSnapshot.transitionContract,
      activeDataKeys: runtimeSnapshot.activeDataKeys,
      renderedKeys: runtimeSnapshot.renderedKeys,
      getChunkData: (chunkX, chunkZ) => runtime.getChunkData(chunkX, chunkZ),
      renderOrigin: runtimeSnapshot.renderOrigin,
      centerChunkX: runtimeSnapshot.centerChunkX,
      centerChunkZ: runtimeSnapshot.centerChunkZ,
      renderDistancePreset: distantRenderDistance,
    });

    const synchronizeLocalTerrainIncrementally = runtimeSnapshot => (
      distantPresentation.syncLocalTerrainIncrementally({
        coverageEpoch: ++localTerrainCoverageEpoch,
        transitionContract: runtimeSnapshot.transitionContract,
        activeDataKeys: runtimeSnapshot.activeDataKeys,
        renderedKeys: runtimeSnapshot.renderedKeys,
        getChunkData: (chunkX, chunkZ) => runtime.getChunkData(chunkX, chunkZ),
        renderOrigin: runtimeSnapshot.renderOrigin,
        centerChunkX: runtimeSnapshot.centerChunkX,
        centerChunkZ: runtimeSnapshot.centerChunkZ,
        renderDistancePreset: distantRenderDistance,
      })
    );

    const synchronizeLocalTerrainPreset = (runtimeSnapshot, {
      renderDistancePreset = distantRenderDistance,
      deferPublication = false,
    } = {}) => (
      distantPresentation.syncLocalTerrainPreset({
        coverageEpoch: ++localTerrainCoverageEpoch,
        transitionContract: runtimeSnapshot.transitionContract,
        activeDataKeys: runtimeSnapshot.activeDataKeys,
        renderedKeys: runtimeSnapshot.renderedKeys,
        getChunkData: (chunkX, chunkZ) => runtime.getChunkData(chunkX, chunkZ),
        renderOrigin: runtimeSnapshot.renderOrigin,
        centerChunkX: runtimeSnapshot.centerChunkX,
        centerChunkZ: runtimeSnapshot.centerChunkZ,
        renderDistancePreset,
        deferPublication,
      })
    );

    const commitDistantRuntimeState = runtimeSnapshot => distantPresentation.commitRuntimeState?.({
      transitionContract: runtimeSnapshot.transitionContract,
      activeDataKeys: runtimeSnapshot.activeDataKeys,
      renderedKeys: runtimeSnapshot.renderedKeys,
      renderOrigin: runtimeSnapshot.renderOrigin,
      quality: distantQuality,
      renderDistancePreset: distantRenderDistance,
      playerLogicalX: logicalPlayer.x,
      playerLogicalZ: logicalPlayer.z,
    });

    if (typeof distantPresentation.prepareTerrainPresentationGeneration === 'function'
      && typeof distantPresentation.claimTerrainPresentationGeneration === 'function'
      && typeof distantPresentation.discardTerrainPresentationGeneration === 'function') {
      runtime.configureTerrainPresentationAdapter?.({
      revision: () => distantRenderDistance,
      prepare: ({
        identity,
        centerChunkX,
        centerChunkZ,
        activeDataKeys,
        renderedKeys,
        getChunkData,
        renderOrigin,
        isCurrent,
        isUrgent,
      }) => distantPresentation.prepareTerrainPresentationGeneration({
        coverageEpoch: ++localTerrainCoverageEpoch,
        presentationGenerationIdentity: identity,
        activeDataKeys,
        renderedKeys,
        getChunkData,
        renderOrigin,
        centerChunkX,
        centerChunkZ,
        renderDistancePreset: distantRenderDistance,
        isPresentationGenerationCurrent: isCurrent,
        isTerrainPresentationUrgent: isUrgent,
      }),
      claim: options => distantPresentation.claimTerrainPresentationGeneration({
        ...options,
        renderDistancePreset: distantRenderDistance,
      }),
      discard: presentationGeneration => (
        distantPresentation.discardTerrainPresentationGeneration(presentationGeneration)
      ),
      });
    }

    const isSameCommittedRuntimeState = (workEpoch, runtimeSnapshot) => {
      if (!running || workEpoch !== postCommitRequestedEpoch) return false;
      const current = runtime.getCommittedChunkState();
      return sameRuntimeTransitionContract(
        current.transitionContract,
        runtimeSnapshot.transitionContract,
      )
        && current.centerChunkX === runtimeSnapshot.centerChunkX
        && current.centerChunkZ === runtimeSnapshot.centerChunkZ
        && current.renderOrigin.rebaseCount === runtimeSnapshot.renderOrigin.rebaseCount
        && current.renderOrigin.renderOriginChunkX === runtimeSnapshot.renderOrigin.renderOriginChunkX
        && current.renderOrigin.renderOriginChunkZ === runtimeSnapshot.renderOrigin.renderOriginChunkZ;
    };

    const deferToNextTask = () => new Promise(resolve => {
      setTimeoutFn(resolve, 0);
    });

    const startGameplayTransitionSync = (workEpoch, runtimeSnapshot) => {
      const work = diagnosticProfile.gameplaySync
        ? diagnostics.measureAsync('gameplay-sync', () => gameplay.syncActiveChunks({
          transitionContract: runtimeSnapshot.transitionContract,
          activeDataKeys: runtimeSnapshot.activeDataKeys,
          renderedKeys: runtimeSnapshot.renderedKeys,
          getChunkData: (chunkX, chunkZ) => runtime.getChunkData(chunkX, chunkZ),
          renderOrigin: runtimeSnapshot.renderOrigin,
          isCurrent: () => isSameCommittedRuntimeState(workEpoch, runtimeSnapshot),
        })).then(
          value => Object.freeze({ ok: true, value }),
          error => Object.freeze({ ok: false, error }),
        )
        : Promise.resolve(Object.freeze({ ok: true, value: null }));
      gameplaySyncWorkByEpoch.set(workEpoch, work);
      for (const [epoch, staleWork] of gameplaySyncWorkByEpoch) {
        if (epoch >= workEpoch) continue;
        void staleWork.finally(() => {
          if (gameplaySyncWorkByEpoch.get(epoch) === staleWork) {
            gameplaySyncWorkByEpoch.delete(epoch);
          }
        });
      }
      return work;
    };

    function schedulePostCommitPump(delayMs = 0) {
      if (postCommitPumpActive || postCommitTimer !== null) return;
      postCommitTimer = setTimeoutFn(() => {
        postCommitTimer = null;
        postCommitPumpActive = true;
        void (async () => {
          let attemptedEpoch = null;
          try {
            await deferToNextTask();
            const committedEpoch = postCommitRequestedEpoch;
            attemptedEpoch = committedEpoch;
            const runtimeState = runtime.getCommittedChunkState();
            if (!isSameCommittedRuntimeState(committedEpoch, runtimeState)) return;
            const gameplayWork = gameplaySyncWorkByEpoch.get(committedEpoch)
              ?? startGameplayTransitionSync(committedEpoch, runtimeState);
            if (diagnostics.enabled) diagnostics.recordEvent('terrain-post-commit-started', {
              workEpoch: committedEpoch,
              transitionGeneration: runtimeState.transitionContract?.generation ?? null,
              coverageSignature: runtimeState.transitionContract?.coverageSignature ?? null,
              centerChunkX: runtimeState.centerChunkX,
              centerChunkZ: runtimeState.centerChunkZ,
            });
            const localTerrainResult = await diagnostics.measureAsync(
              'distant-local-terrain-sync',
              () => synchronizeLocalTerrainIncrementally(runtimeState),
            );
            if (diagnostics.enabled) diagnostics.recordEvent('terrain-post-commit-ready', {
              workEpoch: committedEpoch,
              transitionGeneration: runtimeState.transitionContract?.generation ?? null,
              coverageEpoch: localTerrainResult?.coverageEpoch ?? null,
              committed: localTerrainResult?.committed === true,
              reused: localTerrainResult?.reused === true,
              activeRootId: localTerrainResult?.activeRootId ?? null,
              reason: localTerrainResult?.reason ?? null,
            });
            if (!isSameCommittedRuntimeState(committedEpoch, runtimeState)) return;
            if (!localTerrainResult.committed) {
              throw new Error(`Incremental Local Terrain rejected: ${localTerrainResult.reason}`);
            }
            if (diagnosticProfile.distant) {
              if (diagnostics.enabled) diagnostics.recordEvent('distant-post-commit-started', {
                workEpoch: committedEpoch,
                transitionGeneration: runtimeState.transitionContract?.generation ?? null,
                coverageSignature: runtimeState.transitionContract?.coverageSignature ?? null,
              });
              await diagnostics.measureAsync(
                'distant-sync',
                () => synchronizeDistantPresentation(runtimeState),
              );
              if (diagnostics.enabled) diagnostics.recordEvent('distant-post-commit-ready', {
                workEpoch: committedEpoch,
                transitionGeneration: runtimeState.transitionContract?.generation ?? null,
                coverageSignature: runtimeState.transitionContract?.coverageSignature ?? null,
              });
              if (pendingRenderDistancePublication) {
                beginRenderDistancePublication(requestedDistantRenderDistance);
              }
            }
            if (!isSameCommittedRuntimeState(committedEpoch, runtimeState)) return;
            const gameplayResult = await gameplayWork;
            if (!gameplayResult.ok) throw gameplayResult.error;
            if (!isSameCommittedRuntimeState(committedEpoch, runtimeState)) return;
            postCommitCompletedEpoch = committedEpoch;
            if (diagnostics.enabled) diagnostics.recordEvent(
              'chunk-transition-publication-complete',
              {
                workEpoch: committedEpoch,
                transitionGeneration: runtimeState.transitionContract?.generation ?? null,
                centerChunkX: runtimeState.centerChunkX,
                centerChunkZ: runtimeState.centerChunkZ,
              },
            );
            postCommitFailureCount = 0;
            if (transitionError === postCommitLastError) transitionError = null;
            postCommitLastError = null;
            gameplaySyncWorkByEpoch.delete(committedEpoch);
          } catch (error) {
            transitionError = error;
            postCommitLastError = error;
            if (attemptedEpoch !== null) {
              gameplaySyncWorkByEpoch.delete(attemptedEpoch);
              if (attemptedEpoch === postCommitRequestedEpoch) postCommitFailureCount += 1;
            }
          } finally {
            postCommitPumpActive = false;
            if (running
              && postCommitCompletedEpoch < postCommitRequestedEpoch) {
              const retryDelayMs = postCommitFailureCount > 0
                ? Math.min(1_000, 16 * (2 ** Math.min(6, postCommitFailureCount - 1)))
                : 0;
              schedulePostCommitPump(retryDelayMs);
            }
          }
        })();
      }, delayMs);
    }

    function schedulePostCommitWork(runtimeSnapshot = runtime.getCommittedChunkState()) {
      const workEpoch = ++postCommitRequestedEpoch;
      postCommitFailureCount = 0;
      if (postCommitTimer !== null) {
        clearTimeoutFn(postCommitTimer);
        postCommitTimer = null;
      }
      startGameplayTransitionSync(workEpoch, runtimeSnapshot);
      localTerrainCoverageEpoch = Math.max(
        localTerrainCoverageEpoch,
        distantPresentation.invalidatePendingLocalTerrainSync?.()
          ?? localTerrainCoverageEpoch,
      );
      distantPresentation.invalidatePendingFarSync?.();
      schedulePostCommitPump();
    }

    function sampleCanonicalTerrainHeightMeters(
      logicalWorldX,
      logicalWorldZ,
      queriedChunkData = null,
    ) {
      const owner = decomposeLogicalWorldPosition(logicalWorldX, logicalWorldZ);
      const chunkData = queriedChunkData ?? runtime.getChunkData(owner.chunkX, owner.chunkZ);
      if (!chunkData) return null;
      return sampleW8SurfaceHeightMeters(chunkData, logicalWorldX, logicalWorldZ);
    }

    function getPlayerTerrainHeightMeters(logicalWorldX, logicalWorldZ) {
      const canonicalHeight = sampleCanonicalTerrainHeightMeters(logicalWorldX, logicalWorldZ);
      if (Number.isFinite(canonicalHeight)) {
        lastSafePlayerTerrainHeightMeters = canonicalHeight;
        return canonicalHeight;
      }
      const coarseHeight = distantPresentation.sampleTerrainFallbackHeightMeters?.(
        logicalWorldX,
        logicalWorldZ,
      );
      if (Number.isFinite(coarseHeight)) {
        lastSafePlayerTerrainHeightMeters = coarseHeight;
        return coarseHeight;
      }
      if (Number.isFinite(lastSafePlayerTerrainHeightMeters)) {
        return lastSafePlayerTerrainHeightMeters;
      }
      lastSafePlayerTerrainHeightMeters = 0.4;
      return lastSafePlayerTerrainHeightMeters;
    }

    function isPlayerTerrainCoveragePublished(owner) {
      const committed = runtime.getCommittedChunkState();
      return committed.transitionContract !== null
        && (runtime.isTerrainCoveragePublished?.(owner.chunkX, owner.chunkZ)
          ?? committed.renderedKeys.includes(owner.key));
    }

    function recordTerrainCoverageFrame(owner, gateResult, deltaSeconds) {
      const coverage = distantPresentation.terrainPresentationCoverageForOwner?.(
        owner.chunkX,
        owner.chunkZ,
      ) ?? Object.freeze({
        complete: true,
        worldCoverageComplete: true,
        fallback: gateResult?.terrainPresentationFallback === true,
        lagChunks: 0,
        generationAgeMs: 0,
      });
      const blocked = gateResult?.movementBlockedByTerrain === true
        || gateResult?.terrainCoverageBlocked === true;
      if (blocked) {
        terrainMovementDiagnostics.movementBlockedByTerrain += 1;
        terrainMovementDiagnostics.movementBlockedByTerrainMs += Math.max(
          0,
          deltaSeconds * 1000,
        );
      }
      if (gateResult?.collisionCoverageMiss === true) {
        terrainMovementDiagnostics.collisionCoverageMiss += 1;
      }
      const fallback = coverage.fallback === true
        || gateResult?.terrainPresentationFallback === true;
      if (fallback) {
        terrainMovementDiagnostics.terrainFallbackFrame += 1;
        if (terrainFallbackStartedAtMs === null) terrainFallbackStartedAtMs = clock();
        terrainMovementDiagnostics.terrainFallbackMaxDuration = Math.max(
          terrainMovementDiagnostics.terrainFallbackMaxDuration,
          clock() - terrainFallbackStartedAtMs,
        );
        if (owner.key !== lastTerrainFallbackOwnerKey) {
          terrainMovementDiagnostics.preparedMissCount += 1;
          lastTerrainFallbackOwnerKey = owner.key;
        }
      } else {
        if (terrainFallbackStartedAtMs !== null) {
          terrainMovementDiagnostics.terrainFallbackMaxDuration = Math.max(
            terrainMovementDiagnostics.terrainFallbackMaxDuration,
            clock() - terrainFallbackStartedAtMs,
          );
        }
        terrainFallbackStartedAtMs = null;
        lastTerrainFallbackOwnerKey = null;
      }
      terrainMovementDiagnostics.fallbackGenerationAge = Number.isFinite(
        coverage.generationAgeMs,
      ) ? coverage.generationAgeMs : 0;
      terrainMovementDiagnostics.maximumFallbackGenerationAge = Math.max(
        terrainMovementDiagnostics.maximumFallbackGenerationAge,
        terrainMovementDiagnostics.fallbackGenerationAge,
      );
      terrainMovementDiagnostics.latestGenerationLagChunks = Number.isFinite(
        coverage.lagChunks,
      ) ? coverage.lagChunks : 0;
      terrainMovementDiagnostics.maximumGenerationLagChunks = Math.max(
        terrainMovementDiagnostics.maximumGenerationLagChunks,
        terrainMovementDiagnostics.latestGenerationLagChunks,
      );
      const worldCoverageComplete = terrainPresentationWorldCoverageComplete(coverage);
      terrainMovementDiagnostics.latestVisualCoverage = Object.freeze({
        structurallyComplete: coverage.complete === true,
        worldCoverageComplete,
        activeCenterChunkX: coverage.centerChunkX ?? null,
        activeCenterChunkZ: coverage.centerChunkZ ?? null,
        requiredChunkX: coverage.requiredChunkX ?? owner.chunkX,
        requiredChunkZ: coverage.requiredChunkZ ?? owner.chunkZ,
        clipmapExtentMeters: coverage.clipmapExtentMeters ?? null,
        nearOuterCoverageHalfExtentMeters:
          coverage.nearOuterCoverageHalfExtentMeters ?? null,
        requiredVisibleHalfExtentMeters:
          coverage.requiredVisibleHalfExtentMeters ?? null,
        distanceXMeters: coverage.distanceXMeters ?? null,
        distanceZMeters: coverage.distanceZMeters ?? null,
        withinCameraVisibleExtent: coverage.withinCameraVisibleExtent ?? null,
        coverageDeficitMeters: coverage.coverageDeficitMeters ?? null,
      });
      if (!worldCoverageComplete) {
        terrainMovementDiagnostics.visualBlankFrame += 1;
        terrainMovementDiagnostics.visualWorldCoverageMiss += 1;
      }
    }

    function assertRuntimePreparedForPlayer(owner) {
      const runtimeSnapshot = runtime.snapshot();
      const activeDataKeys = new Set(runtimeSnapshot.activeDataKeys);
      const renderedKeys = new Set(runtimeSnapshot.renderedKeys);
      const missingDataKeys = squareChunkCoordinates(owner.chunkX, owner.chunkZ, 2)
        .map(coordinate => coordinate.key).filter(key => !activeDataKeys.has(key));
      const missingRenderKeys = squareChunkCoordinates(owner.chunkX, owner.chunkZ, 1)
        .map(coordinate => coordinate.key).filter(key => !renderedKeys.has(key));
      if (runtimeSnapshot.centerChunkX !== owner.chunkX
        || runtimeSnapshot.centerChunkZ !== owner.chunkZ
        || missingDataKeys.length || missingRenderKeys.length) {
        throw new Error(`intro runtime preparation incomplete for ${owner.key}`);
      }
      return Object.freeze({
        prepared: true,
        ownerKey: owner.key,
        activeDataCount: runtimeSnapshot.activeDataCount,
        renderedCount: runtimeSnapshot.renderedCount,
        missingDataKeys: Object.freeze(missingDataKeys),
        missingRenderKeys: Object.freeze(missingRenderKeys),
        renderOrigin: Object.freeze({ ...runtimeSnapshot.renderOrigin }),
      });
    }

    async function synchronizeRuntimeToLogicalPlayer({ refreshGameplay = false } = {}) {
      const owner = decomposeLogicalWorldPosition(logicalPlayer.x, logicalPlayer.z);
      await diagnostics.measureAsync(
        'chunk-transition',
        () => runtime.transitionToChunk(owner.chunkX, owner.chunkZ),
      );
      const runtimeSnapshot = runtime.getCommittedChunkState();
      scenePresentation.rebase(runtimeSnapshot.renderOrigin);
      commitDistantRuntimeState(runtimeSnapshot);
      await gameplayRenderAdapter.rebase(runtimeSnapshot.renderOrigin);
      const gameplaySync = diagnosticProfile.gameplaySync
        ? diagnostics.measureAsync('gameplay-sync', () => gameplay.syncActiveChunks({
          transitionContract: runtimeSnapshot.transitionContract,
          activeDataKeys: runtimeSnapshot.activeDataKeys,
          renderedKeys: runtimeSnapshot.renderedKeys,
          getChunkData: (chunkX, chunkZ) => runtime.getChunkData(chunkX, chunkZ),
          renderOrigin: runtimeSnapshot.renderOrigin,
          isCurrent: () => sameRuntimeTransitionContract(
            runtime.getCommittedChunkState().transitionContract,
            runtimeSnapshot.transitionContract,
          ),
        }))
        : Promise.resolve(null);
      synchronizeLocalTerrain(runtimeSnapshot);
      if (diagnosticProfile.distant) {
        await diagnostics.measureAsync(
          'distant-sync',
          () => synchronizeDistantPresentation(runtimeSnapshot),
        );
      }
      await gameplaySync;
      if (refreshGameplay) {
        await diagnostics.measureAsync(
          'gameplay-refresh',
          () => gameplay.refreshFromState({ renderOrigin: runtimeSnapshot.renderOrigin }),
        );
      }
      return Object.freeze({ owner, preparation: assertRuntimePreparedForPlayer(owner) });
    }

    async function saveWorld({ force = false } = {}) {
      if (!diagnosticProfile.save) {
        saveStatus = 'diagnostic-disabled';
        return;
      }
      if (!runStarted && !force) return;
      if (!force && lastSavedRevision === worldState.revision) return;
      if (shouldDeferAutosaveForStreaming(runtime.getStreamingState(), { force })) {
        saveDeferredForStreaming = true;
        saveStatus = 'deferred-streaming';
        scheduleSave({ delayMs: 125 });
        return;
      }
      try {
        const saved = await diagnostics.measureAsync(
          'save-total',
          () => saveStore.saveWithMetadata(worldState),
        );
        if (saved.generation < lastSavedGeneration) return saved;
        lastSavedGeneration = saved.generation;
        lastSavedRevision = saved.revision;
        saveDeferredForStreaming = false;
        state.saveAvailable = true;
        state.saveError = null;
        experienceShell?.setContinueAvailable?.(true);
        saveStatus = saveStore.snapshot().storage?.mode === 'legacy-fallback'
          ? 'fallback' : 'saved';
        return saved;
      } catch (error) {
        transitionError = error;
        state.saveError = {
          name: error?.name ?? 'Error',
          message: error?.message ?? String(error),
          code: error?.code ?? null,
        };
        saveStatus = isSaveStorageUnavailableError(error)
          || saveStore.snapshot().storage?.mode === 'unavailable'
          ? 'unavailable' : 'failed';
      }
    }
    function cancelScheduledSave() {
      if (saveTimer !== null) {
        clearTimeoutFn(saveTimer);
        saveTimer = null;
      }
      if (saveIdleCallback !== null) {
        globalObject.cancelIdleCallback?.(saveIdleCallback);
        saveIdleCallback = null;
      }
    }
    function scheduleSave({ immediate = false, delayMs = 5_000, force = false } = {}) {
      if (!runStarted || !diagnosticProfile.save) return false;
      if (saveTimer !== null) {
        if (!immediate) return true;
        clearTimeoutFn(saveTimer);
        saveTimer = null;
      }
      if (saveIdleCallback !== null) {
        globalObject.cancelIdleCallback?.(saveIdleCallback);
        saveIdleCallback = null;
      }
      if (immediate) {
        saveTimer = setTimeoutFn(() => {
          saveTimer = null;
          void saveWorld({ force });
        }, 0);
        return true;
      }
      saveTimer = setTimeoutFn(() => {
        saveTimer = null;
        if (typeof globalObject.requestIdleCallback === 'function') {
          saveIdleCallback = globalObject.requestIdleCallback(() => {
            saveIdleCallback = null;
            void saveWorld();
          }, { timeout: 2_000 });
        } else void saveWorld();
      }, delayMs);
      return true;
    }
    function saveForExit() {
      cancelScheduledSave();
      if (!runStarted || !diagnosticProfile.save) return Promise.resolve(null);
      const revision = worldState.revision;
      if (exitSaveRevision === revision) return exitSavePromise ?? Promise.resolve(null);
      exitSaveRevision = revision;
      const saving = saveWorld({ force: true });
      exitSavePromise = saving;
      void saving.then(saved => {
        if (exitSavePromise !== saving) return;
        exitSavePromise = null;
        if (!saved || saved.revision !== revision) exitSaveRevision = null;
      }, () => {
        if (exitSavePromise !== saving) return;
        exitSavePromise = null;
        exitSaveRevision = null;
      });
      return saving;
    }
    async function loadWorld() {
      playerRelocationInProgress = true;
      naturalStaticStreamSuspended = true;
      invalidateNaturalStreamingCoverage('load-world');
      try {
        const loaded = await saveStore.loadInto(worldState);
        if (!loaded) {
          saveStatus = 'missing';
          return false;
        }
        gameplay.clearTransientCombat?.();
        await synchronizeRuntimeToLogicalPlayer({ refreshGameplay: true });
        experienceShell?.resetPlayerVerticalMovement({
          player: logicalPlayer,
          scaleProfile: getW6ScaleProfile(worldState.activeScaleStageId),
        });
        state.saveError = null;
        saveStatus = saveStore.snapshot().storage?.mode === 'legacy-fallback'
          ? 'fallback' : 'loaded';
        state.saveLoaded = true;
        return true;
      } catch (error) {
        transitionError = error;
        state.saveError = {
          name: error?.name ?? 'Error',
          message: error?.message ?? String(error),
          code: error?.code ?? null,
        };
        saveStatus = isSaveStorageUnavailableError(error)
          || saveStore.snapshot().storage?.mode === 'unavailable'
          ? 'unavailable' : 'failed';
        return false;
      } finally {
        naturalStaticStreamSuspended = false;
        playerRelocationInProgress = false;
      }
    }
    const addWindowListener = (type, listener) => globalObject.addEventListener?.(type, listener);
    const removeWindowListener = (type, listener) => globalObject.removeEventListener?.(type, listener);

    audioDirector = createW8AudioDirector({
      globalObject, volume: worldState.experience.settings.volume,
    });
    const applyRenderDistanceFog = renderDistancePreset => {
      scene.fog.near = W8_GAMEPLAY_FOG_NEAR;
      scene.fog.far = resolveW8RenderDistancePolicy(
        renderDistancePreset,
      ).fogFarMeters * UNITS_PER_METER;
    };
    const applyRuntimeSettings = (settings, { applyRenderDistance = true } = {}) => {
      const qualityRatio = { low: 1, medium: 1.2, high: 1.5 }[settings.quality] ?? 1.5;
      renderer.setPixelRatio(measurementMode
        ? 1 : Math.min(globalObject.devicePixelRatio ?? 1, qualityRatio));
      renderer.shadowMap.enabled = diagnosticProfile.shadows && settings.quality !== 'low';
      if (applyRenderDistance) applyRenderDistanceFog(settings.renderDistance);
      audioDirector.setVolume(settings.volume);
    };

    const beginRenderDistancePublication = nextRenderDistance => {
      const revision = ++renderDistanceRequestRevision;
      runtime.invalidateTerrainPresentationGenerations?.();
      distantPresentation.discardPreparedRenderDistancePreset?.();
      distantPresentation.stageStaticNaturalRenderDistancePreset?.(nextRenderDistance);
      localTerrainCoverageEpoch = Math.max(
        localTerrainCoverageEpoch,
        distantPresentation.invalidatePendingLocalTerrainSync?.()
          ?? localTerrainCoverageEpoch,
      );
      distantPresentation.invalidatePendingFarSync?.();
      const runtimeSnapshot = runtime.snapshot();
      scenePresentation.rebase(runtimeSnapshot.renderOrigin);
      commitDistantRuntimeState(runtimeSnapshot);
      pendingRenderDistancePublication = {
        revision,
        preset: nextRenderDistance,
        distantPrepared: false,
        localTerrainPrepared: false,
        requiredNaturalOwnerKeys: Object.freeze([]),
        requestedAtMs: clock(),
        preparedAtMs: null,
      };
      void diagnostics.measureAsync('distant-sync', async () => {
        const distantPrepared = await synchronizeDistantPresentation(runtimeSnapshot, {
          renderDistancePreset: nextRenderDistance,
          deferPublication: true,
          preserveStaticNatural: true,
        });
        if (!distantPrepared || pendingRenderDistancePublication?.revision !== revision) {
          return false;
        }
        const localTerrain = await diagnostics.measureAsync(
          'distant-local-preset-sync',
          () => synchronizeLocalTerrainPreset(runtimeSnapshot, {
            renderDistancePreset: nextRenderDistance,
            deferPublication: true,
          }),
        );
        if (pendingRenderDistancePublication?.revision !== revision) return false;
        pendingRenderDistancePublication.distantPrepared = true;
        pendingRenderDistancePublication.localTerrainPrepared =
          localTerrain?.prepared === true || localTerrain?.committed === true;
        pendingRenderDistancePublication.preparedAtMs = clock();
        return true;
      }).catch(error => {
        if (pendingRenderDistancePublication?.revision === revision) {
          pendingRenderDistancePublication = null;
          distantPresentation.discardPreparedRenderDistancePreset?.();
        }
        transitionError = error;
      });
    };

    const tryCommitRenderDistancePublication = () => {
      const pending = pendingRenderDistancePublication;
      if (!pending || pending.revision !== renderDistanceRequestRevision
        || pending.preset !== requestedDistantRenderDistance
        || !pending.distantPrepared || !pending.localTerrainPrepared) return false;
      const streamControl = naturalStaticStream.diagnostics();
      if (streamControl.missingRequiredOwnerCount > 0
        || !distantPresentation.isStaticNaturalCoverageReady?.(
          pending.requiredNaturalOwnerKeys,
        )) return false;
      const settlementTicket = buildingSettlementStream.readyTicket();
      const currentOriginGeneration = runtime.getCommittedChunkState()
        .transitionContract?.generation ?? 0;
      if (settlementStreamingMode === BUILDING_SETTLEMENT_STREAM_MODE.SHARED
        && (!settlementTicket
          || settlementTicket.renderDistancePreset !== pending.preset
          || settlementTicket.originGeneration !== currentOriginGeneration
          || settlementTicket.renderDistanceRevision !== pending.revision)) return false;
      if (settlementStreamingMode === BUILDING_SETTLEMENT_STREAM_MODE.SHARED
        && typeof distantPresentation.canClaimBuildingSettlementPublication === 'function'
        && !distantPresentation.canClaimBuildingSettlementPublication(
          settlementTicket.stage,
          {
            publicationKinds: Object.freeze([
              'building',
              'settlement-road',
              'metadata-remote',
            ]),
            observation: settlementTicket.observation,
            currentObservation: latestSettlementStreamingObservation
              ?? settlementTicket.observation,
            renderDistanceRevision: pending.revision,
          },
        )) return false;
      if (!distantPresentation.commitPreparedRenderDistancePreset?.(pending.preset)) return false;
      if (settlementStreamingMode === BUILDING_SETTLEMENT_STREAM_MODE.SHARED
        && !buildingSettlementStream.commit({
          planId: settlementTicket.planId,
          originGeneration: currentOriginGeneration,
          renderDistanceRevision: settlementTicket.renderDistanceRevision,
        })) {
        throw new Error('Building/Settlement revision publication failed after staging');
      }
      distantRenderDistance = pending.preset;
      appliedStaticNaturalRetainedOwnerKeys = pending.retainedNaturalOwnerKeys
        ?? appliedStaticNaturalRetainedOwnerKeys;
      distantPresentation.releaseStaticNaturalRetainedOwners?.(
        appliedStaticNaturalRetainedOwnerKeys,
      );
      if (latestNaturalCoverageState) {
        latestNaturalCoverageState = Object.freeze({
          ...latestNaturalCoverageState,
          presentedRetainedOwnerKeys: appliedStaticNaturalRetainedOwnerKeys,
        });
      }
      applyRenderDistanceFog(distantRenderDistance);
      pendingRenderDistancePublication = null;
      return true;
    };
    scenePresentation.cloudRoot.visible = diagnosticProfile.transparency;
    renderAdapter.setDiagnosticTransparencyEnabled?.(diagnosticProfile.transparency);
    gameplayRenderAdapter.setDiagnosticTransparencyEnabled?.(diagnosticProfile.transparency);
    experienceShell = createInfiniteExperienceShell({
      globalObject,
      documentObject: globalObject.document,
      canvas: renderer.domElement,
      camera,
      playerMarker,
      worldState,
      initialScaleProfile: getW6ScaleProfile(worldState.activeScaleStageId),
      getTerrainHeightMeters: getPlayerTerrainHeightMeters,
      resolvePlayerHorizontalMovement: input => {
        const horizontalMovement = gameplay.resolvePlayerHorizontalMovement(input);
        const gatedMovement = gatePlayerMovementByTerrainCoverage({
          horizontalMovement,
          startX: input.startX,
          startZ: input.startZ,
          sampleCanonicalTerrainHeight: sampleCanonicalTerrainHeightMeters,
          sampleFallbackTerrainHeight:
            distantPresentation.sampleTerrainFallbackHeightMeters,
          fallbackTerrainHeightMeters: lastSafePlayerTerrainHeightMeters,
          isTerrainCoveragePublished: isPlayerTerrainCoveragePublished,
        });
        lastSafePlayerTerrainHeightMeters = gatedMovement.terrainHeightMeters;
        if (gatedMovement.terrainPresentationFallback) {
          requestPlayerTerrainCoverage(gatedMovement.terrainCoverageOwner, {
            speedMetersPerSecond: null,
            attemptedDisplacementMeters: Math.hypot(
              input.displacementX,
              input.displacementZ,
            ),
            scaleStageId: worldState.activeScaleStageId,
          });
        }
        return gatedMovement;
      },
      onAttack: mode => gameplay.attack(mode),
      onCombatCommand: command => gameplay.executeCombatCommand(command),
      onPlayerLanding: input => gameplay.playerLanding(input),
      onSave: () => { void saveWorld({ force: true }); },
      onLoad: () => { void loadWorld(); },
      continueAvailable: state.saveAvailable,
      treeLodDiagnosticsAvailable:
        typeof distantPresentation.setTreeLodDiagnosticsEnabled === 'function',
      onTreeLodOverlayChanged: enabled => {
        distantPresentation.setTreeLodDiagnosticsEnabled?.(enabled === true);
      },
      onStartRun: async (startMode, { skipConfirmation = false } = {}) => {
        playerRelocationInProgress = true;
        naturalStaticStreamSuspended = true;
        invalidateNaturalStreamingCoverage(`start-run:${startMode}`);
        const phaseBefore = experienceShell?.getRunPhase?.() ?? 'menu';
        const gameplayTimeBeforeMs = worldState.gameplayTimeMs;
        const playerBefore = Object.freeze({ ...logicalPlayer });
        const cameraBefore = Object.freeze({
          x: camera.position.x, y: camera.position.y, z: camera.position.z,
        });
        try {
          let synchronized;
          if (startMode === 'continue') {
            if (returnTitleSavePromise) await returnTitleSavePromise;
            const loaded = await loadWorld();
            if (!loaded) return false;
            const owner = decomposeLogicalWorldPosition(logicalPlayer.x, logicalPlayer.z);
            synchronized = Object.freeze({
              owner,
              preparation: assertRuntimePreparedForPlayer(owner),
            });
          } else {
            if (state.saveAvailable && !skipConfirmation
              && typeof globalObject.confirm === 'function'
              && !globalObject.confirm('既存のセーブを上書きしてNew Gameを開始しますか？')) return false;
            await gameplay.restart({
              playerSpawn: experienceSpawn,
              renderOrigin: runtime.snapshot().renderOrigin,
              scaleStageId: W6_INITIAL_SCALE_STAGE_ID,
            });
            worldState.updatePlayer({ facingY: experienceSpawn.facingY });
            synchronized = await synchronizeRuntimeToLogicalPlayer();
            state.saveLoaded = false;
            runStarted = true;
            await saveWorld({ force: true });
          }
          runStarted = true;
          if (startMode === 'continue') lastSavedRevision = worldState.revision;
          const cameraYaw = startMode === 'new'
            ? experienceSpawn.cameraYaw
            : normalizeAngle(logicalPlayer.facingY - Math.PI);
          lastRunStartDiagnostics = Object.freeze({
            schemaVersion: 'w8-run-start-diagnostics-1',
            startMode,
            phaseBefore,
            phaseEnteredAfterPreparation: 'intro',
            gameplayTimeBeforeMs,
            persistentGameplayTimeMs: worldState.gameplayTimeMs,
            playerBefore,
            playerLogical: Object.freeze({
              x: logicalPlayer.x, z: logicalPlayer.z, facingY: logicalPlayer.facingY,
            }),
            cameraBefore,
            cameraYaw,
            pondStableId: experienceSpawn.pondStableId,
            spawnPoint: Object.freeze({
              x: experienceSpawn.x, y: experienceSpawn.y, z: experienceSpawn.z,
            }),
            spawnSafety: experienceSpawn.spawnSafety,
            runtimePreparation: synchronized.preparation,
            oldPlayerStateCleared: startMode !== 'new' || (
              logicalPlayer.hp === 100 && logicalPlayer.score === 0
            ),
            oldCameraStateCleared: Number.isFinite(cameraYaw),
          });
          return Object.freeze({ cameraYaw });
        } finally {
          naturalStaticStreamSuspended = false;
          playerRelocationInProgress = false;
        }
      },
      onReturnTitle: () => {
        naturalStaticStreamSuspended = true;
        invalidateNaturalStreamingCoverage('return-title');
        const saving = saveWorld({ force: true });
        returnTitleSavePromise = saving;
        void saving.finally(() => {
          if (returnTitleSavePromise === saving) returnTitleSavePromise = null;
        });
        return saving;
      },
      onResetHome: async () => {
        playerRelocationInProgress = true;
        naturalStaticStreamSuspended = true;
        invalidateNaturalStreamingCoverage('reset-home');
        try {
          worldState.updatePlayer({
            x: experienceSpawn.x,
            z: experienceSpawn.z,
            facingY: experienceSpawn.facingY,
          });
          await synchronizeRuntimeToLogicalPlayer();
        } catch (error) {
          transitionError = error;
        } finally {
          naturalStaticStreamSuspended = false;
          playerRelocationInProgress = false;
        }
      },
      onRestart: async () => {
        playerRelocationInProgress = true;
        naturalStaticStreamSuspended = true;
        invalidateNaturalStreamingCoverage('restart');
        try {
          await gameplay.restart({
            playerSpawn: experienceSpawn,
            renderOrigin: runtime.snapshot().renderOrigin,
            scaleStageId: W6_INITIAL_SCALE_STAGE_ID,
          });
          worldState.updatePlayer({ facingY: experienceSpawn.facingY });
          await synchronizeRuntimeToLogicalPlayer();
          runStarted = true;
          await saveWorld({ force: true });
          return Object.freeze({ cameraYaw: experienceSpawn.cameraYaw });
        } finally {
          naturalStaticStreamSuspended = false;
          playerRelocationInProgress = false;
        }
      },
      onNuclearRelease: async ({ airborne, chargeMs, issuedAt, originY }) => {
        try {
          const result = await gameplay.executeCombatCommand(createCombatCommand(
            W8_COMBAT_COMMAND_TYPES.CHARGE_RELEASE,
            { airborne, chargeMs, issuedAt, originY },
          ));
          if (result.accepted && chargeMs >= W7_NUCLEAR_CONTRACT.chargeThresholdMs) {
            experienceShell.triggerNuclearEffect();
            scheduleSave({ immediate: true });
          }
          return result;
        } catch (error) {
          transitionError = error;
          return Object.freeze({ accepted: false, reason: 'runtime-error', error });
        }
      },
      onChargeEnd: () => gameplayRenderAdapter.clearPlayerChargePresentation?.(),
      onSpawnManualBoss: async () => {
        try {
          const result = await gameplay.spawnManualBoss();
          if (result.accepted) scheduleSave({ immediate: true });
          return result;
        } catch (error) {
          transitionError = error;
          return Object.freeze({ accepted: false, reason: 'runtime-error', error });
        }
      },
      onSettingsChanged: settings => {
        const qualityChanged = settings.quality !== distantQuality;
        const nextRenderDistance = normalizeW8RenderDistancePreset(settings.renderDistance);
        const renderDistanceChanged = nextRenderDistance !== requestedDistantRenderDistance;
        distantQuality = settings.quality;
        requestedDistantRenderDistance = nextRenderDistance;
        applyRuntimeSettings(settings, { applyRenderDistance: !renderDistanceChanged });
        if (renderDistanceChanged && diagnosticProfile.distant) {
          beginRenderDistancePublication(nextRenderDistance);
        } else if (renderDistanceChanged) {
          distantRenderDistance = nextRenderDistance;
          applyRenderDistanceFog(nextRenderDistance);
        } else if (qualityChanged && diagnosticProfile.distant) {
          const runtimeSnapshot = runtime.snapshot();
          scenePresentation.rebase(runtimeSnapshot.renderOrigin);
          commitDistantRuntimeState(runtimeSnapshot);
          void diagnostics.measureAsync(
            'distant-sync',
            () => synchronizeDistantPresentation(runtimeSnapshot),
          ).catch(error => { transitionError = error; });
        }
        scheduleSave();
      },
    });
    applyRuntimeSettings(worldState.experience.settings);
    if (measurement.mode) await experienceShell.start('new', { skipConfirmation: true });

    function resize() {
      const width = measurementViewport?.width ?? globalObject.innerWidth;
      const height = measurementViewport?.height ?? globalObject.innerHeight;
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height);
    }
    const handlePageHide = () => { void saveForExit(); };
    function setMeasurementViewport(width, height) {
      if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
        throw new RangeError('measurement viewport dimensions must be positive finite numbers');
      }
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height, false);
      return Object.freeze({ width, height });
    }
    addWindowListener('resize', resize);
    addWindowListener('pagehide', handlePageHide);

    function requestTransition(owner, movement = null, { required = false } = {}) {
      if (transitionTargetKey
        || runtime.isCenteredAt(owner.chunkX, owner.chunkZ)) return;
      transitionTargetKey = owner.key;
      if (diagnostics.enabled) diagnostics.recordEvent('chunk-transition-started', {
        ownerKey: owner.key,
        chunkX: owner.chunkX,
        chunkZ: owner.chunkZ,
        playerLogicalX: logicalPlayer.x,
        playerLogicalZ: logicalPlayer.z,
        speedMetersPerSecond: movement?.speedMetersPerSecond ?? null,
        velocityX: movement?.velocityX ?? null,
        velocityZ: movement?.velocityZ ?? null,
        scaleStageId: movement?.scaleStageId ?? worldState.activeScaleStageId,
      });
      diagnostics.measureAsync(
        'chunk-transition',
        () => runtime.transitionToChunk(owner.chunkX, owner.chunkZ, { required }),
      )
        .then(async transition => {
          if (transition?.terrainPresentationClaimed === true) {
            terrainMovementDiagnostics.presentationSwapCount += 1;
            lastTerrainPresentationSwapAtMs = clock();
          }
          const nextState = runtime.getCommittedChunkState();
          if (diagnostics.enabled) diagnostics.recordEvent('chunk-transition-runtime-ready', {
            ownerKey: owner.key,
            transitionGeneration: nextState.transitionContract?.generation ?? null,
            centerChunkX: nextState.centerChunkX,
            centerChunkZ: nextState.centerChunkZ,
          });
          scenePresentation.rebase(nextState.renderOrigin);
          commitDistantRuntimeState(nextState);
          const gameplayRebase = gameplayRenderAdapter.rebase(nextState.renderOrigin);
          schedulePostCommitWork(nextState);
          if (diagnostics.enabled) diagnostics.recordEvent(
            'chunk-transition-publication-scheduled',
            {
              ownerKey: owner.key,
              transitionGeneration: nextState.transitionContract?.generation ?? null,
              workEpoch: postCommitRequestedEpoch,
            },
          );
          await gameplayRebase;
        })
        .catch(error => {
          transitionError = error;
          if (runtime.isTerrainCoverageProvisional?.(owner.chunkX, owner.chunkZ)) {
            if (transitionRetryTimer !== null) clearTimeoutFn(transitionRetryTimer);
            transitionRetryTimer = setTimeoutFn(() => {
              transitionRetryTimer = null;
              const playerOwner = decomposeLogicalWorldPosition(logicalPlayer.x, logicalPlayer.z);
              if (playerOwner.key === owner.key
                && runtime.isTerrainCoverageProvisional?.(owner.chunkX, owner.chunkZ)) {
                requestTransition(owner, movement, { required: true });
              }
            }, 250);
          }
        })
        .finally(() => { transitionTargetKey = null; });
    }

    function requestPlayerTerrainCoverage(owner, movement = null) {
      if (!owner || (transitionTargetKey && transitionTargetKey !== owner.key)) return;
      if (transitionTargetKey !== owner.key && !directionalPrefetchPending.has(owner.key)) {
        if (diagnostics.enabled) diagnostics.recordEvent('terrain-fallback-prefetch-requested', {
          ownerKey: owner.key,
          chunkX: owner.chunkX,
          chunkZ: owner.chunkZ,
          playerLogicalX: logicalPlayer.x,
          playerLogicalZ: logicalPlayer.z,
          speedMetersPerSecond: movement?.speedMetersPerSecond ?? null,
          attemptedDisplacementMeters: movement?.attemptedDisplacementMeters ?? null,
          scaleStageId: movement?.scaleStageId ?? worldState.activeScaleStageId,
        });
        directionalPrefetchPending.add(owner.key);
        void diagnostics.measureAsync(
          'chunk-prefetch',
          () => runtime.prepareTransition(owner.chunkX, owner.chunkZ),
        ).catch(error => { transitionError = error; })
          .finally(() => directionalPrefetchPending.delete(owner.key));
      }
      requestTransition(owner, movement, { required: true });
    }

    function requestTerrainReadySet(movement) {
      const streaming = runtime.getStreamingState();
      if (streaming.centerChunkX === null) return;
      let plan;
      try {
        plan = planRuntimeTerrainReadySet({
          centerChunkX: streaming.centerChunkX,
          centerChunkZ: streaming.centerChunkZ,
          logicalX: logicalPlayer.x,
          logicalZ: logicalPlayer.z,
          velocityX: movement.velocityX,
          velocityZ: movement.velocityZ,
          speedMetersPerSecond: movement.speedMetersPerSecond,
          scaleStageId: movement.scaleStageId,
          sprint: movement.sprint,
        });
      } catch (error) {
        transitionError = error;
        return;
      }
      if (plan.signature === terrainReadyRequestedSignature) return;
      terrainReadyRequestedSignature = plan.signature;
      if (diagnostics.enabled) diagnostics.recordEvent('runtime-terrain-ready-set-requested', {
        ownerKey: `${plan.visibleCenterChunkX},${plan.visibleCenterChunkZ}`,
        fromChunkX: plan.requestedFromChunkX,
        fromChunkZ: plan.requestedFromChunkZ,
        visibleCenterChunkX: plan.visibleCenterChunkX,
        visibleCenterChunkZ: plan.visibleCenterChunkZ,
        playerLogicalX: logicalPlayer.x,
        playerLogicalZ: logicalPlayer.z,
        corridorEndpointOwnerKey: plan.corridorEndpointOwnerKey,
        corridorCenterCount: plan.corridorCenters.length,
        velocityX: plan.velocityX,
        velocityZ: plan.velocityZ,
        speedMetersPerSecond: plan.speedMetersPerSecond,
        scaleStageId: plan.scaleStageId,
        sprint: plan.sprint,
        leadSeconds: plan.leadSeconds,
        dataOwnerCount: plan.dataCoordinates.length,
        renderOwnerCount: plan.renderCoordinates.length,
      });
      void diagnostics.measureAsync(
        'chunk-prefetch',
        () => runtime.updateTerrainReadySet(plan),
      ).catch(error => {
        if (terrainReadyRequestedSignature === plan.signature) terrainReadyRequestedSignature = null;
        transitionError = error;
      });
    }

    function updatePlayer(
      deltaSeconds,
      renderOrigin = runtime.getRenderOrigin(),
      cameraDeltaSeconds = deltaSeconds,
    ) {
      const scaleProfile = getW6ScaleProfile(worldState.activeScaleStageId);
      let movement = Object.freeze({
        velocityX: 0,
        velocityZ: 0,
        speedMetersPerSecond: 0,
        sprint: false,
        scaleStageId: scaleProfile.stage.id,
      });
      let terrainCoverageGateResult = null;
      if (measurement.mode === 'crossing' && measurement.status === 'sampling') {
        const startX = logicalPlayer.x;
        const startZ = logicalPlayer.z;
        const intendedVelocityX = scaleProfile.movementMetersPerSecond;
        const gatedMovement = gatePlayerMovementByTerrainCoverage({
          horizontalMovement: Object.freeze({
            x: startX + intendedVelocityX * deltaSeconds,
            z: startZ,
            collided: false,
          }),
          startX,
          startZ,
          sampleCanonicalTerrainHeight: sampleCanonicalTerrainHeightMeters,
          sampleFallbackTerrainHeight:
            distantPresentation.sampleTerrainFallbackHeightMeters,
          fallbackTerrainHeightMeters: lastSafePlayerTerrainHeightMeters,
          isTerrainCoveragePublished: isPlayerTerrainCoveragePublished,
        });
        terrainCoverageGateResult = gatedMovement;
        lastSafePlayerTerrainHeightMeters = gatedMovement.terrainHeightMeters;
        logicalPlayer.x = gatedMovement.x;
        logicalPlayer.z = gatedMovement.z;
        if (gatedMovement.terrainPresentationFallback) {
          requestPlayerTerrainCoverage(gatedMovement.terrainCoverageOwner, {
            velocityX: intendedVelocityX,
            velocityZ: 0,
            speedMetersPerSecond: Math.abs(intendedVelocityX),
            scaleStageId: scaleProfile.stage.id,
          });
        } else {
          logicalPlayer.facingY = Math.PI / 2;
        }
        const inverseDelta = deltaSeconds > 0 ? 1 / deltaSeconds : 0;
        const velocityX = (logicalPlayer.x - startX) * inverseDelta;
        movement = Object.freeze({
          velocityX,
          velocityZ: 0,
          speedMetersPerSecond: Math.abs(velocityX),
          sprint: false,
          scaleStageId: scaleProfile.stage.id,
        });
      } else if (!measurement.mode) {
        const update = experienceShell.updatePlayer({
          deltaSeconds,
          player: logicalPlayer,
          scaleProfile,
          movementMultiplier: gameplay.getPlayerMovementMultiplier(),
        });
        movement = update.movement;
        terrainCoverageGateResult = update.horizontalCollision;
      }
      if (diagnostics.enabled) diagnostics.recordTerrainGate({
        blocked: terrainCoverageGateResult?.terrainCoverageBlocked === true,
        fallback: terrainCoverageGateResult?.terrainPresentationFallback === true,
        collisionCoverageMiss: terrainCoverageGateResult?.collisionCoverageMiss === true,
        ownerKey: terrainCoverageGateResult?.terrainCoverageOwner?.key ?? null,
      });
      if (terrainCoverageGateResult?.terrainCoverageBlocked === true) {
        const missingOwner = terrainCoverageGateResult.terrainCoverageOwner;
        if (missingOwner) runtime.recordTerrainCoverageGateBlocked?.(
          missingOwner.chunkX,
          missingOwner.chunkZ,
        );
      } else runtime.recordTerrainCoverageGateRestored?.();
      if (diagnostics.enabled
        && terrainCoverageGateResult?.terrainPresentationFallback === true) {
        const missingOwner = terrainCoverageGateResult.terrainCoverageOwner;
        if (missingOwner?.key && missingOwner.key !== lastTerrainCoverageMissOwnerKey) {
          const committed = runtime.getCommittedChunkState();
          const nearCoverage = renderAdapter.renderCoverageSnapshot?.() ?? null;
          diagnostics.recordEvent('player-terrain-presentation-fallback', {
            ownerKey: missingOwner.key,
            chunkX: missingOwner.chunkX,
            chunkZ: missingOwner.chunkZ,
            playerLogicalX: logicalPlayer.x,
            playerLogicalZ: logicalPlayer.z,
            terrainHeightSource: terrainCoverageGateResult.terrainHeightSource ?? null,
            collisionCoverageMiss:
              terrainCoverageGateResult.collisionCoverageMiss === true,
            transitionTargetKey,
            transitionGeneration: committed.transitionContract?.generation ?? null,
            coverageSignature: committed.transitionContract?.coverageSignature ?? null,
            activeDataKeys: committed.activeDataKeys,
            renderedKeys: committed.renderedKeys,
            nearLoadedKeys: nearCoverage?.loadedKeys ?? null,
            nearTerrainKeys: nearCoverage?.terrainKeys ?? null,
            nearMissingTerrainKeys: nearCoverage?.missingTerrainKeys ?? null,
            visibleRoots: distantPresentation.visibleRootRevisionSnapshot?.() ?? null,
          });
          lastTerrainCoverageMissOwnerKey = missingOwner.key;
        }
      } else if (diagnostics.enabled && lastTerrainCoverageMissOwnerKey !== null) {
        diagnostics.recordEvent('player-terrain-presentation-current', {
          ownerKey: lastTerrainCoverageMissOwnerKey,
          playerLogicalX: logicalPlayer.x,
          playerLogicalZ: logicalPlayer.z,
        });
        lastTerrainCoverageMissOwnerKey = null;
      }
      const owner = decomposeLogicalWorldPosition(logicalPlayer.x, logicalPlayer.z);
      recordTerrainCoverageFrame(owner, terrainCoverageGateResult, deltaSeconds);
      requestTerrainReadySet(movement);
      requestTransition(owner, movement);
      const renderLocal = logicalWorldToRenderLocal(
        logicalPlayer.x,
        logicalPlayer.z,
        renderOrigin.renderOriginChunkX,
        renderOrigin.renderOriginChunkZ,
      );
      playerMarker.rotation.y = logicalPlayer.facingY;
      const productionScale = scaleProfile.stage.visualScale
        * UNITS_PER_METER / PRODUCTION_VISUAL_UNITS_PER_METER;
      playerMarker.scale.set(
        productionScale,
        productionScale,
        productionScale,
      );
      const movedMeters = Math.hypot(logicalPlayer.x - lastVisualPlayerX, logicalPlayer.z - lastVisualPlayerZ);
      const shellSnapshot = experienceShell.snapshot();
      gameplayRenderAdapter.setPlayerLocomotion?.({
        movedMeters,
        elapsedSeconds: shellSnapshot.gameplayTimeMs / 1000,
        grounded: shellSnapshot.playerVertical.grounded,
        intro: shellSnapshot.runPhase === 'intro',
      });
      const presentationOffset = gameplayRenderAdapter.getPlayerPresentationOffsetUnits?.()
        ?? { x: 0, y: 0, z: 0 };
      const playerRootY = shellSnapshot.playerVertical.rootY
        ?? shellSnapshot.playerVertical.groundRootY ?? 0;
      const presentationOffsetMeters = presentationOffset.y * productionScale / UNITS_PER_METER;
      const presentedRenderLocal = {
        x: renderLocal.x + presentationOffset.x * productionScale,
        z: renderLocal.z + presentationOffset.z * productionScale,
      };
      playerMarker.position.x = presentedRenderLocal.x;
      playerMarker.position.y = playerRootY * UNITS_PER_METER
        + presentationOffset.y * productionScale;
      playerMarker.position.z = presentedRenderLocal.z;
      lastVisualPlayerX = logicalPlayer.x;
      lastVisualPlayerZ = logicalPlayer.z;
      experienceShell.updateCamera({
        renderLocal: presentedRenderLocal,
        scaleProfile,
        unitsPerMeter: UNITS_PER_METER,
        playerPresentationOffsetMeters: presentationOffsetMeters,
        deltaSeconds: cameraDeltaSeconds,
      });
      const cameraTarget = {
        x: presentedRenderLocal.x,
        y: (playerRootY + presentationOffsetMeters
          + scaleProfile.cameraTargetHeightMeters) * UNITS_PER_METER,
        z: presentedRenderLocal.z,
      };
      const buildingCollision = renderAdapter.resolveCameraCollision?.({
        camera,
        target: cameraTarget,
        clearanceMeters: 0.6,
      }) ?? lastCameraCollision;
      const bossCollision = gameplayRenderAdapter.resolveBossCameraCollision?.({
        camera,
        target: cameraTarget,
      });
      lastCameraCollision = bossCollision?.collided ? bossCollision : buildingCollision;
      renderAdapter.updateCameraOcclusion?.({
        camera,
        target: cameraTarget,
        nowMs: clock(),
        enabled: shellSnapshot.runPhase === 'intro',
      });
      const committedChunkState = runtime.getCommittedChunkState();
      const settlementStreamingObservation = diagnosticMeasure(
        'settlement-shadow-observation',
        () => readSettlementStreamingObservation(requestedDistantRenderDistance),
      );
      latestSettlementStreamingObservation = settlementStreamingObservation;
      const destructionRevision = [...(worldState.featureDamage?.entries?.() ?? [])]
        .filter(([, value]) => value?.destroyed === true)
        .map(([stableId]) => stableId)
        .sort((left, right) => left.localeCompare(right))
        .join('\n');
      const publicationContext = worldStreamingCoordinator.createPublicationContext({
        generatedAtMs: clock(),
        stateRevision: worldState.revision,
        destructionRevision,
        originGeneration: committedChunkState.transitionContract?.generation ?? 0,
      });
      const naturalCoverageKey = createNaturalCoverageKey({
        policyRegistryVersion: worldStreamingPolicyRegistry.version,
        renderDistancePreset: requestedDistantRenderDistance,
        player: { x: logicalPlayer.x, z: logicalPlayer.z },
        velocity: { x: movement.velocityX, z: movement.velocityZ },
        velocityPrefetch: STATIC_OBJECT_STREAM_VELOCITY_PREFETCH,
        naturalResourceBandRevision: NATURAL_RESOURCE_BAND_REVISION,
        settlementContentHash:
          settlementStreamingObservation?.coverageContentHash ?? null,
        runtimeCoverageSignature:
          committedChunkState.transitionContract?.coverageSignature
            ?? `runtime:${committedChunkState.centerChunkX},${committedChunkState.centerChunkZ}`,
        ownerMetadataCache: streamingOwnerMetadataCache,
      });
      const coverageResolution = diagnosticMeasure(
        'world-streaming-plan',
        () => worldStreamingCoordinator.resolveCoveragePlan({
          coverageKey: naturalCoverageKey,
          publicationContext,
          createPlanInput: () => ({
            player: { x: logicalPlayer.x, z: logicalPlayer.z },
            velocity: { x: movement.velocityX, z: movement.velocityZ },
            renderDistancePreset: requestedDistantRenderDistance,
            currentRequests: {
              [LEGACY_RUNTIME_CHUNK_POLICY_KIND]: {
                requiredOwnerKeys: committedChunkState.renderedKeys,
                requestOwnerKeys: committedChunkState.activeDataKeys,
                retainedOwnerKeys: committedChunkState.activeDataKeys,
              },
              ...(settlementStreamingObservation ? {
                [W8_BUILDING_STREAM_POLICY_KIND]: {
                  sourceSnapshot: settlementStreamingObservation,
                  requiredOwnerKeys: settlementStreamingObservation.buildingOwnerKeys,
                  requestOwnerKeys: settlementStreamingObservation.buildingOwnerKeys,
                  retainedOwnerKeys: settlementStreamingObservation.buildingOwnerKeys,
                },
                [W8_SETTLEMENT_STREAM_POLICY_KIND]: {
                  sourceSnapshot: settlementStreamingObservation,
                  requiredOwnerKeys: settlementStreamingObservation.settlementOwnerKeys,
                  requestOwnerKeys: settlementStreamingObservation.settlementOwnerKeys,
                  retainedOwnerKeys: settlementStreamingObservation.settlementOwnerKeys,
                },
              } : {}),
            },
          }),
        }),
      );
      const worldStreamingPlan = coverageResolution.plan;
      if (diagnostics.enabled) diagnostics.recordWork('world-streaming-plan', {
        calls: Number(coverageResolution.regenerated),
        fastPathHits: Number(!coverageResolution.regenerated),
        policies: coverageResolution.regenerated ? worldStreamingPlan.policyPlans.length : 0,
        requiredOwnerKeys: coverageResolution.regenerated
          ? worldStreamingPlan.policyPlans.reduce(
          (sum, policy) => sum + policy.requiredOwnerKeys.length, 0,
          ) : 0,
        prefetchedOwnerKeys: coverageResolution.regenerated
          ? worldStreamingPlan.policyPlans.reduce(
          (sum, policy) => sum + policy.prefetchedOwnerKeys.length, 0,
          ) : 0,
        retainedOwnerKeys: coverageResolution.regenerated
          ? worldStreamingPlan.policyPlans.reduce(
          (sum, policy) => sum + policy.retainedOwnerKeys.length, 0,
          ) : 0,
      });
      buildingSettlementShadowComparison = diagnosticMeasure(
        'settlement-shadow-compare',
        () => compareW8BuildingSettlementShadow({
          plan: worldStreamingPlan,
          observation: settlementStreamingObservation,
        }),
      );
      if (diagnostics.enabled) diagnostics.recordWork('building-settlement-route', {
        shadowComparisons: 1,
        legacyPublisher: settlementStreamingMode === BUILDING_SETTLEMENT_STREAM_MODE.LEGACY
          ? 1 : 0,
        sharedPublisher: settlementStreamingMode === BUILDING_SETTLEMENT_STREAM_MODE.SHARED
          ? 1 : 0,
        observedStableIds: settlementStreamingObservation?.stableIds?.length ?? 0,
        observedOwners: settlementStreamingObservation?.settlementOwnerKeys?.length ?? 0,
      });
      if (buildingSettlementShadowComparison.matches && settlementStreamingObservation) {
        const stagingSignature = diagnosticMeasure(
          'settlement-staging-signature',
          () => `${worldStreamingPlan.originGeneration}:`
            + `${worldStreamingPlan.renderDistancePreset}:`
            + settlementStreamingObservation.contentHash,
        );
        if (stagingSignature !== buildingSettlementStagingSignature) {
          buildingSettlementStagingSignature = stagingSignature;
          void buildingSettlementStream.applyShadowPlan({
            plan: worldStreamingPlan,
            observation: settlementStreamingObservation,
            renderDistanceRevision: renderDistanceRequestRevision,
          }).then(stage => {
            if (stage && settlementStreamingMode === BUILDING_SETTLEMENT_STREAM_MODE.SHARED
              && pendingRenderDistancePublication === null) {
              buildingSettlementStream.commit({
                planId: stage.planId,
                originGeneration: runtime.getCommittedChunkState()
                  .transitionContract?.generation ?? 0,
                renderDistanceRevision: stage.renderDistanceRevision,
              });
            }
          }).catch(error => {
            if (error?.message !== 'Building/Settlement staging cancelled') {
              transitionError = error;
            }
          });
        }
      }
      recordStaticTreeActivationTime('firstShadowPlanGeneratedAtMs');
      if (coverageResolution.regenerated || latestNaturalCoverageState === null) {
        const naturalOwnerPlan = diagnosticMeasure('natural-policy-plan', () => {
          const policyPlans = worldStreamingPlan.policyPlans.filter(
            policy => staticNaturalPolicyRuntimes.has(policy.kind),
          );
          return Object.freeze({
            policyPlans,
            requiredOwnerKeys: Object.freeze([
              ...new Set(policyPlans.flatMap(policy => policy.requiredOwnerKeys)),
            ]),
            retainedOwnerKeys: Object.freeze([
              ...new Set(policyPlans.flatMap(policy => policy.allOwnerKeys)),
            ]),
          });
        });
        const requestedNaturalRequiredOwnerKeys = naturalOwnerPlan.requiredOwnerKeys;
        const requestedNaturalRetainedOwnerKeys = naturalOwnerPlan.retainedOwnerKeys;
        if (pendingRenderDistancePublication) {
          pendingRenderDistancePublication.requiredNaturalOwnerKeys =
            requestedNaturalRequiredOwnerKeys;
          pendingRenderDistancePublication.retainedNaturalOwnerKeys =
            requestedNaturalRetainedOwnerKeys;
        } else {
          appliedStaticNaturalRetainedOwnerKeys = requestedNaturalRetainedOwnerKeys;
        }
        const presentedNaturalRetainedOwnerKeys = pendingRenderDistancePublication
          ? Object.freeze([...new Set([
            ...appliedStaticNaturalRetainedOwnerKeys,
            ...requestedNaturalRetainedOwnerKeys,
          ])])
          : requestedNaturalRetainedOwnerKeys;
        latestNaturalCoverageState = Object.freeze({
          key: naturalCoverageKey,
          plan: worldStreamingPlan,
          policyPlans: naturalOwnerPlan.policyPlans,
          requiredOwnerKeys: requestedNaturalRequiredOwnerKeys,
          retainedOwnerKeys: requestedNaturalRetainedOwnerKeys,
          presentedRetainedOwnerKeys: presentedNaturalRetainedOwnerKeys,
          streamApplied: false,
          resourceKindEntries: Object.freeze([]),
          policyResourceCoverage: Object.freeze([]),
        });
        if (diagnostics.enabled) diagnostics.recordWork('natural-policy-plan', {
          calls: 1,
          policies: naturalOwnerPlan.policyPlans.length,
          requiredOwners: requestedNaturalRequiredOwnerKeys.length,
          retainedOwners: requestedNaturalRetainedOwnerKeys.length,
        });
      } else if (diagnostics.enabled) diagnostics.recordWork('natural-policy-plan', {
        calls: 0,
        fastPathHits: 1,
      });
      const staticNaturalPolicyPlans = latestNaturalCoverageState.policyPlans;
      const naturalStaticStreamCanApply = !naturalStaticStreamSuspended
        && !playerRelocationInProgress;
      if (!naturalStaticStreamActivated && naturalStaticStreamCanApply) {
        activateNaturalStaticStream('first-shadow-plan');
      }
      if (naturalStaticStreamActivated && naturalStaticStreamCanApply) {
        const coverageNeedsApply = !latestNaturalCoverageState.streamApplied;
        if (coverageNeedsApply) {
          diagnosticMeasure('static-natural-apply-plan', () => naturalStaticStream.applyPlan({
            plan: worldStreamingPlan,
            policyPlans: staticNaturalPolicyPlans,
            publicationContext,
            ownerMetadataRevision: worldStreamingPlan.planId,
          }));
          recordStaticTreeActivationTime('firstStaticPlanAppliedAtMs');
        } else naturalStaticStream.updatePublicationContext(publicationContext);
        const streamControl = naturalStaticStream.diagnostics();
        if (coverageNeedsApply) {
          latestNaturalCoverageState = Object.freeze({
            ...latestNaturalCoverageState,
            streamApplied: true,
            resourceKindEntries: naturalStaticStream.resourceKindEntries(),
            policyResourceCoverage: resolveNaturalPresentationPolicyCoverage({
              plan: worldStreamingPlan,
              policyPlans: staticNaturalPolicyPlans,
              policyResourceKindEntries: naturalStaticStream.policyResourceKindEntries(),
              coverageGeneration: streamControl.coverageGeneration,
            }),
          });
        }
        if (!disablePersistentTreePublication) {
          const readyPageAdmissionLimit = resolveNaturalOwnerBuildQueueTarget({
            backlog: streamControl.readyPageCount,
          });
          const readyPages = diagnosticMeasure(
            'static-natural-ready-admission',
            () => readyPageAdmissionLimit > 0
              ? naturalStaticStream.drainReadyOwnerPages({ limit: readyPageAdmissionLimit })
              : Object.freeze([]),
          );
          if (diagnostics.enabled) diagnostics.recordWork('static-natural-ready-admission', {
            calls: 1,
            admittedOwners: readyPages.length,
            admissionLimit: readyPageAdmissionLimit,
            readyPageBacklog: streamControl.readyPageCount,
            readyRequiredOwners: streamControl.readyRequiredOwnerCount,
            missingRequiredOwners: streamControl.missingRequiredOwnerCount,
            requestBacklog: streamControl.backlog,
          });
          const presentationInput = {
            coverageGeneration: streamControl.coverageGeneration,
            planRevision: streamControl.planRevision,
            planId: worldStreamingPlan.planId,
            destructionRevision,
            playerLogicalX: logicalPlayer.x,
            playerLogicalZ: logicalPlayer.z,
            activeDataKeys: committedChunkState.activeDataKeys,
            renderedKeys: committedChunkState.renderedKeys,
            // A small backlog-aware admission window removes the idle frame
            // between serialized builds. Each build still yields to the host,
            // and the presentation coordinator retains its shared time budget.
            readyPages,
          };
          if (coverageNeedsApply) {
            distantPresentation.applyStaticNaturalPlan?.({
              ...presentationInput,
              quality: distantQuality,
              renderDistancePreset: distantRenderDistance,
              renderOrigin: committedChunkState.renderOrigin,
              retainedOwnerKeys: latestNaturalCoverageState.presentedRetainedOwnerKeys,
              resourceKindEntries: latestNaturalCoverageState.resourceKindEntries,
              policyResourceCoverage: latestNaturalCoverageState.policyResourceCoverage,
            });
          } else {
            distantPresentation.advanceStaticNaturalFrame?.(presentationInput);
          }
        }
      }
      return owner;
    }

    function updateHud(owner) {
      const gameplaySnapshot = gameplay.snapshot();
      const experienceSnapshot = experienceShell.snapshot();
      const debugDetailsEnabled = diagnostics.enabled || worldState.developerTools === true
        || experienceSnapshot.debugOpen === true;
      const gameplayDiagnosticsHudEnabled = experienceSnapshot.gameplayDiagnosticsHudEnabled === true;
      if (!debugDetailsEnabled && !gameplayDiagnosticsHudEnabled) {
        experienceShell.renderHud({
          fps: latestFrameDurationMs > 0 ? 1000 / latestFrameDurationMs : 0,
          gameplaySnapshot,
          runtimeSnapshot: null,
          saveStatus,
          renderInfo: null,
          resources: null,
          debugDetailsEnabled: false,
        });
        return;
      }
      const runtimeSnapshot = runtime.snapshot();
      distantPresentation.setTreeLodDiagnosticsEnabled?.(
        experienceSnapshot.treeLodOverlayEnabled === true,
      );
      const presentationSnapshot = diagnosticMeasure(
        'distant-diagnostics-snapshot',
        () => distantPresentation.snapshot(),
      );
      const scenePresentationSnapshot = scenePresentation.snapshot();
      const renderOrigin = runtimeSnapshot.renderOrigin;
      const cameraLogicalX = renderOrigin.renderOriginChunkX * LOGICAL_CHUNK_SIZE_METERS
        + camera.position.x / UNITS_PER_METER;
      const cameraLogicalZ = renderOrigin.renderOriginChunkZ * LOGICAL_CHUNK_SIZE_METERS
        + camera.position.z / UNITS_PER_METER;
      const currentChunk = runtime.getChunkData(owner.chunkX, owner.chunkZ);
      const metrics = runtimeSnapshot.performance;
      const transition = runtimeSnapshot.latestTransition;
      const chunkTransportSnapshot = chunkDataService.snapshot().transport;
      const renderInfo = renderer.info;
      if (!debugDetailsEnabled) {
        experienceShell.renderHud({
          fps: metrics.frame.latest > 0 ? 1000 / metrics.frame.latest : 0,
          gameplaySnapshot,
          runtimeSnapshot,
          presentationSnapshot,
          saveStatus,
          renderInfo: { drawCalls: renderInfo?.render?.calls ?? null },
          resources: null,
          workerSnapshot: chunkTransportSnapshot,
          debugDetailsEnabled: false,
        });
        return;
      }
      const renderResources = renderAdapter.resourceSnapshot();
      const renderedKeySet = new Set(runtimeSnapshot.renderedKeys);
      const loadedKeySet = new Set(renderResources.renderCoverage?.loadedKeys ?? []);
      const renderCoverageKeyDifference = [
        ...runtimeSnapshot.renderedKeys.filter(key => !loadedKeySet.has(key)),
        ...(renderResources.renderCoverage?.loadedKeys ?? []).filter(key => !renderedKeySet.has(key)),
      ].sort();
      const measurementReport = diagnosticMeasure(
        'diagnostics-hud-summary',
        () => diagnostics.hudSnapshot({
          drawCalls: renderInfo?.render?.calls ?? null,
          triangles: renderInfo?.render?.triangles ?? null,
          geometries: renderInfo?.memory?.geometries ?? null,
          materials: renderResources.sharedMaterialCount,
          sceneObjects: countSceneObjects(scene),
        }, HUD_DIAGNOSTIC_STAGE_NAMES),
      );
      const stageP95 = stage => number(measurementReport.stages[stage]?.p95);
      const longTaskMaximum = measurementReport.longTaskMaximumMs;
      if (measurement.status === 'complete' && streamingAcceptanceMetrics === null) {
        streamingAcceptanceMetrics = collectStreamingAcceptanceMetrics();
      }
      const measurementText = measurement.mode
        ? `\nMeasurement: ${measurement.mode} ${measurement.status}  1920x1080  warm-up 10s + sample 60s`
        : '';
      const diagnosticText = diagnostics.enabled
        ? `\nDiagnostic: ${diagnosticProfile.profileId} run ${diagnosticRunNumber}  hitch ${(measurementReport.hitchRatio * 100).toFixed(2)}%\nMeasurement frame count/p50/p95/p99/max: ${measurementReport.frame.count} / ${number(measurementReport.frame.p50)} / ${number(measurementReport.frame.p95)} / ${number(measurementReport.frame.p99)} / ${number(measurementReport.frame.max)} ms\nLong Tasks count/max: ${measurementReport.longTaskCount} / ${number(longTaskMaximum)} ms  Resources draw/triangles/geometry/material/scene: ${measurementReport.resources.drawCalls ?? 'n/a'} / ${measurementReport.resources.triangles ?? 'n/a'} / ${measurementReport.resources.geometries ?? 'n/a'} / ${measurementReport.resources.materials ?? 'n/a'} / ${measurementReport.resources.sceneObjects ?? 'n/a'}\nStage p95 ms: transition ${stageP95('chunk-transition')}  prefetch ${stageP95('chunk-prefetch')}  distant ${stageP95('distant-sync')}  gameplay-sync ${stageP95('gameplay-sync')}  gameplay-update ${stageP95('gameplay-update')}  save ${stageP95('save-total')}  render ${stageP95('render')}\nDistant p95 ms: clear ${stageP95('distant-clear')}  terrain ${stageP95('distant-midground-terrain')}  features ${stageP95('distant-midground-features')}  clipmap ${stageP95('distant-clipmap')}  proxies ${stageP95('distant-feature-proxies')}`
        : '';
      const terrainSchedulerSnapshot = presentationSnapshot.terrainScheduler;
      const terrainPresentationScheduling = runtimeSnapshot.terrainReady
        ?.terrainPresentationScheduling;
      const terrainSchedulerText = diagnostics.enabled && terrainSchedulerSnapshot
        ? `\nTerrain Scheduler: slice count/cpu/p50/p95/max ${terrainSchedulerSnapshot.terrainSliceCount}/${number(terrainSchedulerSnapshot.terrainSliceCpuMs)}/${number(terrainSchedulerSnapshot.terrainSliceP50Ms)}/${number(terrainSchedulerSnapshot.terrainSliceP95Ms)}/${number(terrainSchedulerSnapshot.terrainSliceMaxMs)}ms  resume p50/p95/max ${number(terrainSchedulerSnapshot.terrainResumeWaitP50Ms)}/${number(terrainSchedulerSnapshot.terrainResumeWaitP95Ms)}/${number(terrainSchedulerSnapshot.terrainResumeWaitMaxMs)}ms  deadline miss/max ${terrainSchedulerSnapshot.terrainDeadlineMissCount}/${number(terrainSchedulerSnapshot.terrainDeadlineMissMaxMs)}ms\nTerrain Generation: count cpu/wait/wall/avg/p95 ${terrainSchedulerSnapshot.terrainGenerationCount}/${number(terrainSchedulerSnapshot.terrainGenerationCpuMs)}/${number(terrainSchedulerSnapshot.terrainGenerationYieldWaitMs)}/${number(terrainSchedulerSnapshot.terrainGenerationWallMs)}/${number(terrainSchedulerSnapshot.terrainGenerationWallAverageMs)}/${number(terrainSchedulerSnapshot.terrainGenerationWallP95Ms)}ms  scheduler slices T/N/R ${terrainSchedulerSnapshot.presentationSchedulerTerrainSlices}/${presentationSnapshot.presentationSchedulerNaturalSlices}/${presentationSnapshot.presentationSchedulerRoadSlices}\nTerrain Movement: blocked/count-ms ${terrainMovementDiagnostics.movementBlockedByTerrain}/${number(terrainMovementDiagnostics.movementBlockedByTerrainMs)}  lag latest/max ${terrainMovementDiagnostics.latestGenerationLagChunks}/${terrainMovementDiagnostics.maximumGenerationLagChunks}  fallback ${terrainMovementDiagnostics.terrainFallbackFrame}/${number(terrainMovementDiagnostics.terrainFallbackMaxDuration)}ms  swaps ${terrainMovementDiagnostics.presentationSwapCount}  prepared/visual/collision miss ${terrainMovementDiagnostics.preparedMissCount}/${terrainMovementDiagnostics.visualWorldCoverageMiss}/${terrainMovementDiagnostics.collisionCoverageMiss}\nTerrain Safety Ring: active/coverage ${presentationSnapshot.safetyRingActive}/${presentationSnapshot.safetyRingCoverageComplete}  center ${presentationSnapshot.safetyRingCenter?.chunkX ?? 'n/a'},${presentationSnapshot.safetyRingCenter?.chunkZ ?? 'n/a'}  safety/high-detail/hole miss ${presentationSnapshot.safetyRingCoverageMiss}/${presentationSnapshot.highDetailCoverageMiss}/${presentationSnapshot.visibleTerrainHoleFrame}  reuse/updated ${number(presentationSnapshot.safetyRingReuseRatio)}/${presentationSnapshot.safetyRingUpdatedSamples}  area ${number(presentationSnapshot.safetyRingVisibleArea)}m2  build/max-slice ${number(presentationSnapshot.safetyRingLastBuildDurationMs)}/${number(presentationSnapshot.safetyRingMaximumSliceMs)}ms  error ${presentationSnapshot.safetyRingLastError ?? 'none'}\nTerrain Jump/Reuse: 1 ${terrainPresentationScheduling?.terrainPresentationJumpHistogram?.['1'] ?? 0}/${number(terrainPresentationScheduling?.terrainPresentationReuseRatioByJump?.['1'])}  2 ${terrainPresentationScheduling?.terrainPresentationJumpHistogram?.['2'] ?? 0}/${number(terrainPresentationScheduling?.terrainPresentationReuseRatioByJump?.['2'])}  3-5 ${terrainPresentationScheduling?.terrainPresentationJumpHistogram?.['3-5'] ?? 0}/${number(terrainPresentationScheduling?.terrainPresentationReuseRatioByJump?.['3-5'])}  6+ ${terrainPresentationScheduling?.terrainPresentationJumpHistogram?.['6+'] ?? 0}/${number(terrainPresentationScheduling?.terrainPresentationReuseRatioByJump?.['6+'])}`
        : '';
      const warningText = runtimeSnapshot.warnings.length ? `\n警告: ${runtimeSnapshot.warnings.join(' / ')}` : '';
      const errorText = transitionError ? `\nERROR: ${transitionError.message}` : '';
      const worldStreamingSnapshot = worldStreamingCoordinator.snapshot();
      const staticNaturalStreaming = naturalStaticStream.diagnostics();
      const shadowPolicy = worldStreamingSnapshot.latestPlan?.policyPlans?.find(
        policy => policy.kind === LEGACY_RUNTIME_CHUNK_POLICY_KIND,
      ) ?? null;
      const shadowComparison = worldStreamingSnapshot.latestComparison?.policies?.find(
        policy => policy.kind === LEGACY_RUNTIME_CHUNK_POLICY_KIND,
      ) ?? null;
      const shadowDiagnosticText = diagnostics.enabled
        ? `\nWorld Streaming Shadow: ${escapeHtml(worldStreamingSnapshot.latestPlan?.planId ?? 'none')}  preset ${escapeHtml(worldStreamingSnapshot.latestPlan?.renderDistancePreset ?? 'none')}  match ${shadowComparison?.matches === true ? 'yes' : shadowComparison?.matches === false ? 'no' : 'unobserved'}  required ${shadowPolicy?.requiredOwnerKeys.length ?? 0}/${shadowComparison?.required?.observedCount ?? 0}  request ${shadowPolicy?.requestOwnerKeys.length ?? 0}/${shadowComparison?.requested?.observedCount ?? 0}  retained ${shadowPolicy?.retainedOwnerKeys.length ?? 0}/${shadowComparison?.retained?.observedCount ?? 0}  corridor ${shadowPolicy?.velocityCorridor.ownerKeys.length ?? 0} owner  plan ${number(worldStreamingSnapshot.performance.lastPlanDurationMs)}/${number(worldStreamingSnapshot.performance.p95PlanDurationMs)}/${number(worldStreamingSnapshot.performance.maximumPlanDurationMs)}ms last/p95/max`
        : '';
      const naturalCoverageText = staticNaturalStreaming.policyCoverage.map(coverage => (
        `${coverage.kind.replace('natural-', '')} ${coverage.readyRequiredOwnerCount}/${coverage.requiredOwnerCount}`
      )).join('  ');
      const naturalMissingText = streamingAcceptanceMetrics
        ? Object.entries(streamingAcceptanceMetrics.byTarget).map(([target, metrics]) => (
          `${target}:${metrics.playerArrivalMissingCount}`
        )).join(' ') : '';
      const naturalAcceptance = streamingAcceptanceMetrics?.natural;
      const staticStreamingDiagnosticText = `\nStatic Natural Stream: ${escapeHtml(staticNaturalStreaming.latestPlanId ?? 'inactive')}  coverage/revision ${staticNaturalStreaming.coverageGeneration}/${staticNaturalStreaming.planRevision}  required ${staticNaturalStreaming.readyRequiredOwnerCount}/${staticNaturalStreaming.requiredOwnerCount}  prefetch ${staticNaturalStreaming.readyPrefetchedOwnerCount}/${staticNaturalStreaming.prefetchedOwnerCount}  by-kind ${escapeHtml(naturalCoverageText)}  backlog ${staticNaturalStreaming.backlog}  requested/hit/reuse ${staticNaturalStreaming.requestedCount}/${staticNaturalStreaming.readyHitCount}/${staticNaturalStreaming.pendingReuseCount}  tickets ${staticNaturalStreaming.publishedTicketCount}/${staticNaturalStreaming.ticketCount}  cancel/fail/invalidate ${staticNaturalStreaming.cancelledCount}/${staticNaturalStreaming.failedCount}/${staticNaturalStreaming.invalidationCount}  Worker ${staticNaturalStreaming.workerCount}\nStatic Natural Presentation: published/resident/pending/dispose ${presentationSnapshot.staticNaturalCurrentPublishedOwnerCount}/${presentationSnapshot.staticNaturalResidentOwnerCount}/${presentationSnapshot.staticNaturalPendingOwnerCount}/${presentationSnapshot.staticNaturalDisposeOwnerCount}  publish wait last/max ${number(presentationSnapshot.staticTreeLastPublicationWaitMs)}/${number(presentationSnapshot.staticTreeMaximumPublicationWaitMs)}ms  matrix/attribute ${presentationSnapshot.staticTreeMatrixUpdateCount}/${presentationSnapshot.staticTreeAttributeUpdateCount}  compose max ${number(presentationSnapshot.staticTreeMaximumSliceMs)}ms  deferred dispose ${presentationSnapshot.deferredGenerationDisposeCount}${naturalAcceptance ? `\nStatic Natural Acceptance: worker-publish count/p50/p95/max ${naturalAcceptance.workerToPublishCount}/${number(naturalAcceptance.workerToPublishP50Ms)}/${number(naturalAcceptance.workerToPublishP95Ms)}/${number(naturalAcceptance.workerToPublishMaximumMs)}ms  request-first-draw count/p50/p95/max ${naturalAcceptance.requestToFirstDrawCount}/${number(naturalAcceptance.requestToFirstDrawP50Ms)}/${number(naturalAcceptance.requestToFirstDrawP95Ms)}/${number(naturalAcceptance.requestToFirstDrawMaximumMs)}ms  arrival missing ${naturalAcceptance.playerArrivalMissingCount} (${escapeHtml(naturalMissingText)})` : ''}`;
      const settlementReference = currentChunk?.settlementReferences?.[0];
      const fogFarMeters = scene.fog.far / UNITS_PER_METER;
      const cloudWithinFogCount = scenePresentationSnapshot.clouds.filter(cloud => Math.hypot(
        cloud.logicalX - logicalPlayer.x,
        cloud.logicalZ - logicalPlayer.z,
      ) <= fogFarMeters).length;
      const fullDiagnosticHtml = `W8 / FINITE EXPERIENCE PARITY
World Seed: ${escapeHtml(generator.worldSeed)}
Logical Chunk: (${owner.chunkX}, ${owner.chunkZ})  Local: (${number(owner.logicalLocalX)}m, ${number(owner.logicalLocalZ)}m)
Logical World: (${number(logicalPlayer.x)}m, ${number(logicalPlayer.z)}m)
Natural Biome: ${escapeHtml(currentChunk?.biomeField?.primaryBiomeId ?? 'loading')}  Height range: ${number(currentChunk?.terrain?.heightRangeMeters?.minimum)}..${number(currentChunk?.terrain?.heightRangeMeters?.maximum)}m
Formal Vegetation: ${currentChunk?.vegetationCandidates?.length ?? 0}  Formal Rocks: ${currentChunk?.rockCandidates?.length ?? 0}  Persistent Index: ${runtimeSnapshot.chunkIndex?.size ?? 0}/${runtimeSnapshot.chunkIndex?.capacity ?? 0}
Settlement: ${escapeHtml(settlementReference?.settlementType ?? 'NATURAL')} / ${escapeHtml(settlementReference?.townType ?? 'none')}  Stable ID: ${escapeHtml(settlementReference?.settlementId ?? 'none')}
Current Chunk Settlement features: ${currentChunk?.settlementFeatures?.length ?? 0}  Buildings: ${settlementReference?.buildingCount ?? 0}/${settlementReference?.requestedBuildingCount ?? 0}
Distribution: Seed + 768m Macro Region + minimum distance + urbanization + terrain suitability (fixed total: none)
Scale: ${escapeHtml(worldState.activeScaleStageId)}  Player HP: ${number(worldState.player.hp)}/${number(worldState.player.maxHp)}  Score: ${number(worldState.player.score)}
Run Phase: ${escapeHtml(experienceSnapshot.runPhase)}  Phase clock: ${number(experienceSnapshot.gameplayTimeMs)}ms  Gameplay clock: ${number(worldState.gameplayTimeMs)}ms
Safe Spawn: (${number(experienceSpawn.x)}m, ${number(experienceSpawn.z)}m)  Pond: ${escapeHtml(experienceSpawn.pondStableId ?? 'none')}  Prepared: ${experienceSpawn.spawnSafety?.preparedChunkKeys?.length ?? 0}/25
Cloud: root ${scenePresentationSnapshot.rootAttached && scenePresentationSnapshot.rootVisible ? 'visible' : 'hidden'}  instances ${scenePresentationSnapshot.cloudInstanceCount}/${scenePresentationSnapshot.cloudCapacity}  within Fog ${cloudWithinFogCount}  altitude ${number(scenePresentationSnapshot.minimumCloudY)}..${number(scenePresentationSnapshot.maximumCloudY)}m  matrix v${scenePresentationSnapshot.instanceMatrixVersion ?? 'n/a'}  opacity attr ${scenePresentationSnapshot.instanceOpacityAttributeCount} shader ${scenePresentationSnapshot.instanceOpacityShaderEnabled ? 'on' : 'off'}
Player Render: (${number(playerMarker.position.x)}, ${number(playerMarker.position.y)}, ${number(playerMarker.position.z)})  Camera Logical: (${number(cameraLogicalX)}m, ${number(camera.position.y / UNITS_PER_METER)}m, ${number(cameraLogicalZ)}m)
Camera Collision: ${lastCameraCollision?.collided ? escapeHtml(lastCameraCollision.stableId ?? 'obstacle') : 'clear'}
Gameplay Simulation: ${gameplaySnapshot.activeSimulationChunkCount}/9 nearby Chunk only  Entities: ${gameplaySnapshot.simulatedEntityCount}  Targets: ${gameplaySnapshot.simulatedStaticTargetCount}
Destroyed Stable IDs: ${gameplaySnapshot.state.destroyedFeatureCount + gameplaySnapshot.state.destroyedEntityCount}  Save: ${escapeHtml(saveStatus)} (P save / L load)
Controls: WASD / Shift / Space / Left + Right Mouse / Wheel / H / Escape (developer keys isolated)
Render Origin Chunk: (${runtimeSnapshot.renderOrigin.renderOriginChunkX}, ${runtimeSnapshot.renderOrigin.renderOriginChunkZ})
W1B Render Profile: ${selectedRenderChunkSize} (${renderProfile.selectedUnitsPerMeter} units/m; startup benchmark: isolated)
Render Distance: ${escapeHtml(presentationSnapshot.renderDistancePreset)}  Quality ${escapeHtml(distantQuality)}  Natural ${number(presentationSnapshot.naturalVisibilityMeters)}m  Terrain/River ${number(presentationSnapshot.clipmapExtentMeters)}m  General ${number(presentationSnapshot.visibilityMeters)}m  Settlement ${number(presentationSnapshot.remoteHorizonHiddenDistanceMeters)}m
Rendered: ${runtimeSnapshot.renderedCount}/9  Prefetched Data: ${runtimeSnapshot.activeDataCount}/25  Cache: ${runtimeSnapshot.cacheSize}/${runtimeSnapshot.cacheCapacity}
Chunk Generator: ${escapeHtml(chunkTransportSnapshot?.mode ?? chunkTransportSnapshot?.kind ?? 'unknown')}  fallback ${chunkTransportSnapshot?.fallbackOccurred ? escapeHtml(chunkTransportSnapshot.fallbackReason?.message ?? 'yes') : 'none'}  worker generation p50/max ${number(chunkTransportSnapshot?.generationMsP50)}/${number(chunkTransportSnapshot?.generationMsMaximum)}ms  receive p50/max ${number(chunkTransportSnapshot?.mainThreadReceiveMsP50)}/${number(chunkTransportSnapshot?.mainThreadReceiveMsMaximum)}ms
Distant Local Terrain: epoch ${presentationSnapshot.committedLocalTerrainEpoch}/${presentationSnapshot.localTerrainSyncEpoch}  center (${presentationSnapshot.localTerrainCoverageCenter?.chunkX ?? 'n/a'}, ${presentationSnapshot.localTerrainCoverageCenter?.chunkZ ?? 'n/a'})  active/resolved/rendered/mid ${presentationSnapshot.localTerrainActiveKeyCount}/${presentationSnapshot.localTerrainResolvedChunkCount}/${presentationSnapshot.localTerrainRenderedKeyCount}/${presentationSnapshot.localTerrainMidgroundOwnerCount}  commits/rejects ${presentationSnapshot.localTerrainCommitCount}/${presentationSnapshot.localTerrainRejectionCount}  missing ${escapeHtml(presentationSnapshot.localTerrainMissingOwnerKeys.join(',') || 'none')}  far pending ${presentationSnapshot.farSyncPending ? presentationSnapshot.farSyncPendingCount : 0}
Render Coverage Audit: loaded/terrain ${renderResources.renderCoverage?.loadedKeys.length ?? 0}/${renderResources.renderCoverage?.terrainKeys.length ?? 0}  key diff ${escapeHtml(renderCoverageKeyDifference.join(',') || 'none')}  missing ${escapeHtml(renderResources.renderCoverage?.missingTerrainKeys.join(',') || 'none')}  disposed ${escapeHtml(renderResources.renderCoverage?.disposedTerrainKeys.join(',') || 'none')}
Distant: mid ${presentationSnapshot.midgroundChunkCount}  natural ${presentationSnapshot.distantNaturalProxyCount}/${presentationSnapshot.distantNaturalProxyLimit}  town ${presentationSnapshot.distantTownProxyCount}/${presentationSnapshot.distantTownProxyLimit}  water ${presentationSnapshot.distantWaterProxyCount}  boundary RGB ${number(presentationSnapshot.maximumInnerBoundaryColorDifference)}
Canonical: settlements ${presentationSnapshot.queryCandidateCount}/${presentationSnapshot.queryTemplateSuccessCount} resolved  owner Chunks ${presentationSnapshot.queryCanonicalChunkSuccessCount}/${presentationSnapshot.queryOwnerChunkCount}  records ${presentationSnapshot.canonicalRecordCount} (building ${presentationSnapshot.canonicalBuildingRecordCount}, landmark ${presentationSnapshot.canonicalLandmarkRecordCount}, road ${presentationSnapshot.canonicalRoadRecordCount})  visible Far ${presentationSnapshot.canonicalFarObjectCount} / Mid ${presentationSnapshot.canonicalMidObjectCount} / Near handoff ${presentationSnapshot.canonicalNearObjectCount}
Tree LOD: full ${presentationSnapshot.visibleCanonicalFullTreeCount}  silhouette ${presentationSnapshot.visibleCanonicalSilhouetteTreeCount}  ultra ${presentationSnapshot.visibleCanonicalUltraTreeCount}  84-124m ${presentationSnapshot.visibleCanonicalTreeUltraInnerBandCount}  124-140m ${presentationSnapshot.visibleCanonicalTreeUltraOuterBandCount}  parts ${presentationSnapshot.visibleCanonicalTreePartInstanceCount}
Horizon Local: active ${escapeHtml(presentationSnapshot.activeLocalSettlementId ?? 'none')}  selected ${presentationSnapshot.localSettlementIds.length}/${presentationSnapshot.localSettlementLimit ?? 'n/a'}  additional ${presentationSnapshot.additionalLocalSettlementIds.length}  building ${presentationSnapshot.visibleCanonicalHorizonBuildingCount}  landmark ${presentationSnapshot.visibleCanonicalHorizonLandmarkCount}  parts ${presentationSnapshot.visibleCanonicalHorizonPartInstanceCount}  destroyed ${presentationSnapshot.destroyedHorizonBuildingCount}
Horizon Remote: candidates/selected/materialized/visible ${presentationSnapshot.queryRemoteCandidateCount}/${presentationSnapshot.queryRemoteSelectedCount}/${presentationSnapshot.queryRemoteHorizonMaterializedCount}/${presentationSnapshot.visibleRemoteHorizonSettlementCount}  canonical/represented/missing ${presentationSnapshot.remoteHorizonCanonicalBuildingCount}/${presentationSnapshot.remoteHorizonBuildingCount}/${presentationSnapshot.remoteHorizonMissingBuildingCount}  landmark/parts ${presentationSnapshot.remoteHorizonLandmarkCount}/${presentationSnapshot.remoteHorizonPartInstanceCount}  metadata ${number(presentationSnapshot.settlementMetadataQueryDistanceMeters)}m  range ${number(presentationSnapshot.remoteHorizonStartMeters)}..${number(presentationSnapshot.remoteHorizonHiddenDistanceMeters)}m  caps ${presentationSnapshot.queryRemoteSettlementLimit}/${presentationSnapshot.queryRemoteBuildingLimitPerSettlement}/${presentationSnapshot.queryRemotePartLimit}  atmosphere ${escapeHtml(presentationSnapshot.remoteHorizonAtmosphereMode ?? 'none')}  suppressed ${presentationSnapshot.remoteHorizonSuppressedByNearCount}
Presentation Identity: distant ${presentationSnapshot.distantVisibleStableIdCount}  duplicate ${presentationSnapshot.duplicateVisibleStableIdCount} ${escapeHtml(presentationSnapshot.duplicateVisibleStableIds.join(',') || 'none')}
Far Query: ultra owner ${presentationSnapshot.queryUltraOwnerChunkCount}  cache ${presentationSnapshot.queryUltraOwnerChunkCacheHits}/${presentationSnapshot.queryUltraOwnerChunkCacheMisses}/${presentationSnapshot.queryUltraOwnerChunkCacheEvictions}  warm ${number(presentationSnapshot.ultraWarmDurationMs)}ms  building owner ${presentationSnapshot.queryBuildingOwnerChunkCount}  cache ${presentationSnapshot.queryFarOwnerChunkCacheHits}/${presentationSnapshot.queryFarOwnerChunkCacheMisses}/${presentationSnapshot.queryFarOwnerChunkCacheEvictions}  inner warm ${number(presentationSnapshot.innerWarmDurationMs)}ms
Generated: ${runtimeSnapshot.counts.generated}  Loaded: ${runtimeSnapshot.counts.renderLoaded}  Unloaded: ${runtimeSnapshot.counts.renderUnloaded}  Rebase: ${runtimeSnapshot.renderOrigin.rebaseCount}
Latest crossing: ${number(transition?.durationMs)}ms  generated Δ${transition?.generatedDelta ?? 0}  load Δ${transition?.renderLoadedDelta ?? 0}  unload Δ${transition?.renderUnloadedDelta ?? 0}
Generation ms latest/p50/p95/max: ${number(metrics.generation.latest)} / ${number(metrics.generation.p50)} / ${number(metrics.generation.p95)} / ${number(metrics.generation.max)}
Projection ms latest/p50/p95/max: ${number(metrics.projection.latest)} / ${number(metrics.projection.p50)} / ${number(metrics.projection.p95)} / ${number(metrics.projection.max)}
Load ms latest/p50/p95/max: ${number(metrics.load.latest)} / ${number(metrics.load.p50)} / ${number(metrics.load.p95)} / ${number(metrics.load.max)}
Unload ms latest/p50/p95/max: ${number(metrics.unload.latest)} / ${number(metrics.unload.p50)} / ${number(metrics.unload.p95)} / ${number(metrics.unload.max)}
Rebase ms latest/p50/p95/max: ${number(metrics.rebase.latest)} / ${number(metrics.rebase.p50)} / ${number(metrics.rebase.p95)} / ${number(metrics.rebase.max)}
Frame ms latest/p50/p95/max: ${number(metrics.frame.latest)} / ${number(metrics.frame.p50)} / ${number(metrics.frame.p95)} / ${number(metrics.frame.max)}
Render resources: draw ${renderInfo?.render?.calls ?? 'n/a'}  geometry ${renderInfo?.memory?.geometries ?? 'n/a'}  material ${renderResources.sharedMaterialCount}  scene ${countSceneObjects(scene)}${staticStreamingDiagnosticText}${measurementText}${diagnosticText}${terrainSchedulerText}${shadowDiagnosticText}${escapeHtml(warningText)}${escapeHtml(errorText)}`;
      experienceShell.renderHud({
        fps: metrics.frame.latest > 0 ? 1000 / metrics.frame.latest : 0,
        gameplaySnapshot,
        runtimeSnapshot,
        presentationSnapshot,
        saveStatus,
        renderInfo: {
          drawCalls: renderInfo?.render?.calls ?? null,
          geometries: renderInfo?.memory?.geometries ?? null,
        },
        resources: renderResources,
        workerSnapshot: chunkTransportSnapshot,
        fullDiagnosticHtml,
        measurementReport,
        debugDetailsEnabled: true,
      });
    }

    function failRuntimeLoop(error) {
      running = false;
      localTerrainCoverageEpoch = Math.max(
        localTerrainCoverageEpoch,
        distantPresentation.invalidatePendingLocalTerrainSync?.()
          ?? localTerrainCoverageEpoch,
      );
      distantPresentation.invalidatePendingFarSync?.();
      state.status = 'failed';
      state.stage = 'Animation Loop';
      state.bootError = { name: error?.name ?? 'Error', message: error?.message ?? String(error), stage: state.stage };
      renderSandboxBootStatus(hud, state);
    }

    function updateScenePresentation(deltaSeconds, frameNow, cloudDeltaSeconds, renderOrigin) {
      scenePresentation.update(cloudDeltaSeconds, renderOrigin);
      if (!measurement.mode && experienceShell.getMode?.() === 'menu') {
        const lobbyPulse = Math.sin(frameNow * 0.0035);
        scenePresentation.titleCrab.position.y = finiteVisualToRender(lobbyPulse * 5);
        if (scenePresentation.titleCrabParts?.leftClaw) {
          scenePresentation.titleCrabParts.leftClaw.position.y = 30 + lobbyPulse * 8;
          scenePresentation.titleCrabParts.leftClaw.rotation.z = 0.12 + lobbyPulse * 0.08;
        }
        if (scenePresentation.titleCrabParts?.rightClaw) {
          scenePresentation.titleCrabParts.rightClaw.position.y = 30 - lobbyPulse * 8;
          scenePresentation.titleCrabParts.rightClaw.rotation.z = -0.12 - lobbyPulse * 0.08;
        }
        for (let index = 0; index < (scenePresentation.titleCrabParts?.legs?.length ?? 0); index += 1) {
          scenePresentation.titleCrabParts.legs[index].rotation.x = Math.sin(
            frameNow * 0.003 + index,
          ) * 0.12;
        }
        scenePresentation.explosionRoot.rotation.y += deltaSeconds * 0.03;
      }
      gameplayRenderAdapter.updatePresentation?.(deltaSeconds);
    }

    const rootPositionSnapshot = object => Object.freeze({
      x: Number(object?.position?.x ?? 0),
      y: Number(object?.position?.y ?? 0),
      z: Number(object?.position?.z ?? 0),
    });
    const matrixWorldTranslationSnapshot = object => {
      const elements = object?.matrixWorld?.elements;
      if (elements?.length >= 16
        && [elements[12], elements[13], elements[14]].every(Number.isFinite)) {
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
    const recordOriginTransformDiagnosticFrame = () => {
      if (!diagnostics.enabled) return null;
      const runtimeSnapshot = runtime.getCommittedChunkState();
      const renderOrigin = runtimeSnapshot.renderOrigin;
      const transitionGeneration = runtimeSnapshot.transitionContract?.generation ?? null;
      const renderResources = renderAdapter.resourceSnapshot();
      const gameplayRender = gameplayRenderAdapter.snapshot();
      const distant = distantPresentation.originTransformAuditSnapshot?.() ?? {
        roots: Object.freeze([]), buildingSlots: Object.freeze([]), committedRenderOrigin: null,
      };
      const roots = [];
      const nearRoot = renderAdapter.worldRoot;
      roots.push(Object.freeze({
        role: 'near-terrain-building-root',
        rootIdentity: nearRoot?.name ?? null,
        logicalOwner: `${runtimeSnapshot.centerChunkX},${runtimeSnapshot.centerChunkZ}`,
        transitionGeneration,
        renderOriginRevision: renderResources.rebaseCount,
        rootPosition: rootPositionSnapshot(nearRoot),
        matrixWorldTranslation: matrixWorldTranslationSnapshot(nearRoot),
        rebaseAppliedBy: 'ChunkRenderAdapter.rebase',
        staleRevisionGuard: 'RuntimeTransitionContract publication',
        attached: nearRoot?.parent === scene,
        visible: nearRoot?.visible !== false,
        drawnOwnerCount: renderResources.renderCoverage?.terrainKeys?.length ?? 0,
        originAligned: renderAdapter.renderOriginChunkX === renderOrigin.renderOriginChunkX
          && renderAdapter.renderOriginChunkZ === renderOrigin.renderOriginChunkZ,
      }));
      for (const [ownerKey, projected] of renderAdapter.loaded) {
        const expected = logicalWorldToRenderLocal(
          projected.chunkX * LOGICAL_CHUNK_SIZE_METERS,
          projected.chunkZ * LOGICAL_CHUNK_SIZE_METERS,
          renderOrigin.renderOriginChunkX,
          renderOrigin.renderOriginChunkZ,
          selectedRenderChunkSize,
        );
        roots.push(Object.freeze({
          role: 'near-owner',
          rootIdentity: projected.group?.name ?? null,
          logicalOwner: ownerKey,
          transitionGeneration,
          renderOriginRevision: renderResources.rebaseCount,
          rootPosition: rootPositionSnapshot(projected.group),
          matrixWorldTranslation: matrixWorldTranslationSnapshot(projected.group),
          rebaseAppliedBy: 'ChunkRenderAdapter.#positionGroup',
          staleRevisionGuard: 'RuntimeTransitionContract publication',
          attached: projected.group?.parent === nearRoot,
          visible: projected.group?.visible !== false,
          drawnOwnerCount: 1,
          originAligned: Math.abs(Number(projected.group?.position?.x ?? 0) - expected.x) < 1e-6
            && Math.abs(Number(projected.group?.position?.z ?? 0) - expected.z) < 1e-6,
        }));
      }
      roots.push(...distant.roots);
      for (const gameplayRoot of [gameplayRenderAdapter.root, gameplayRenderAdapter.combatRoot]) {
        roots.push(Object.freeze({
          role: gameplayRoot === gameplayRenderAdapter.root ? 'collision-gameplay' : 'combat',
          rootIdentity: gameplayRoot?.name ?? null,
          logicalOwner: null,
          transitionGeneration,
          renderOriginRevision: gameplayRender.renderOrigin.rebaseCount,
          rootPosition: rootPositionSnapshot(gameplayRoot),
          matrixWorldTranslation: matrixWorldTranslationSnapshot(gameplayRoot),
          rebaseAppliedBy: 'GameplayRenderAdapter.rebase',
          staleRevisionGuard: 'GameplayRenderAdapter.rebase epoch guard',
          attached: gameplayRoot?.parent === scene,
          visible: gameplayRoot?.visible !== false,
          drawnOwnerCount: gameplayRender.liveChunkGroups,
          originAligned: gameplayRender.renderOrigin.renderOriginChunkX
              === renderOrigin.renderOriginChunkX
            && gameplayRender.renderOrigin.renderOriginChunkZ
              === renderOrigin.renderOriginChunkZ,
        }));
      }
      roots.push(Object.freeze({
        role: 'camera',
        rootIdentity: camera.name || 'gameplay-camera',
        logicalOwner: decomposeLogicalWorldPosition(logicalPlayer.x, logicalPlayer.z).key,
        transitionGeneration,
        renderOriginRevision: renderOrigin.rebaseCount,
        rootPosition: rootPositionSnapshot(camera),
        matrixWorldTranslation: matrixWorldTranslationSnapshot(camera),
        rebaseAppliedBy: 'experienceShell.updateCamera',
        staleRevisionGuard: 'current frame renderOrigin',
        attached: camera.parent === scene,
        visible: camera.visible !== false,
        drawnOwnerCount: 1,
        originAligned: true,
      }));
      const anomalyCodes = [];
      const expectedRevision = renderOrigin.rebaseCount;
      if (renderResources.rebaseCount !== expectedRevision) anomalyCodes.push('near-origin-revision');
      if (distant.committedRenderOrigin?.rebaseCount !== expectedRevision) {
        anomalyCodes.push('distant-origin-revision');
      }
      if (gameplayRender.renderOrigin.rebaseCount !== expectedRevision) {
        anomalyCodes.push('gameplay-origin-revision');
      }
      for (const rootEntry of roots) {
        if (rootEntry.rootIdentity && rootEntry.attached !== false && rootEntry.originAligned === false) {
          anomalyCodes.push(`root-transform:${rootEntry.role}:${rootEntry.rootIdentity}`);
        }
      }
      return originTransformDiagnostics.record(Object.freeze({
        buildIdentity: SANDBOX_RUNTIME_BUILD_IDENTITY,
        activeFeatureFlags: Object.freeze({
          settlementStreamingMode,
          incrementalStaticTreePages: true,
          persistentStaticNatural: !disablePersistentTreePublication,
          diagnosticsEnabled: diagnostics.enabled,
          streamingTelemetryEnabled: streamingTelemetry.enabled,
        }),
        frameSequence: settlementStreamingFrameSequence,
        transitionGeneration,
        renderOriginRevision: expectedRevision,
        rebaseCount: expectedRevision,
        playerLogicalPosition: Object.freeze({ x: logicalPlayer.x, z: logicalPlayer.z }),
        roots: Object.freeze(roots),
        drawnOwnerCount: roots.reduce((sum, entry) => sum + Number(entry.drawnOwnerCount ?? 0), 0),
        ownerKeys: Object.freeze([...renderAdapter.loaded.keys()].sort()),
        buildingSlots: distant.buildingSlots,
        anomalyCodes: Object.freeze([...new Set(anomalyCodes)].sort()),
      }));
    };

    function renderActiveScene() {
      diagnostics.measure('render', () => {
        const titleActive = !measurement.mode && experienceShell.getMode?.() === 'menu';
        scenePresentation.titlePresentationRoot.visible = titleActive;
        playerMarker.visible = !titleActive;
        if (titleActive) {
          scenePresentation.titlePresentationRoot.position.set(
            playerMarker.position.x, playerMarker.position.y, playerMarker.position.z,
          );
          scenePresentation.titlePresentationRoot.rotation.y = 0;
          camera.position.set(
            playerMarker.position.x + finiteVisualToRender(220),
            playerMarker.position.y + finiteVisualToRender(80),
            playerMarker.position.z + finiteVisualToRender(380),
          );
          camera.lookAt(
            playerMarker.position.x + finiteVisualToRender(-40),
            playerMarker.position.y + finiteVisualToRender(50),
            playerMarker.position.z,
          );
        }
        let webglCapture = null;
        if (webglRenderDiagnostics?.enabled) {
          const runtimeState = runtime.getCommittedChunkState();
          webglCapture = webglRenderDiagnostics.beginFrame({
            frameSequence: settlementStreamingFrameSequence,
            transitionGeneration: runtimeState.transitionContract?.generation ?? null,
            renderOriginRevision: runtimeState.renderOrigin?.rebaseCount ?? null,
            playerLogicalPosition: Object.freeze({ x: logicalPlayer.x, z: logicalPlayer.z }),
            currentOwnerKey: `${runtimeState.centerChunkX},${runtimeState.centerChunkZ}`,
            worldExpected: !titleActive && runtimeState.renderedKeys.length > 0,
          });
        }
        try {
          renderer.render(scene, camera);
        } finally {
          if (webglCapture) {
            try {
              webglRenderDiagnostics.finishFrame(webglCapture);
            } catch (error) {
              diagnostics.recordEvent('webgl-render-diagnostic-failed', {
                name: error?.name ?? 'Error',
                message: error?.message ?? String(error),
              });
            }
          }
        }
        if (staticTreeActivationTimeline.firstPersistentTreePublishAtMs !== null) {
          recordStaticTreeActivationTime('firstPersistentTreeDrawAtMs');
        }
        if (streamingTelemetry.enabled) {
          renderAdapter.markFirstDraw?.();
          distantPresentation.markFirstDraw?.();
          gameplayRenderAdapter.markFirstDraw?.();
        }
        recordOriginTransformDiagnosticFrame();
      });
    }

    function sealDiagnosticFrame() {
      if (!diagnostics.enabled) return;
      diagnostics.sealFrame({ rendererInfo: renderer.info });
    }

    function frame(now) {
      if (!running) return;
      try {
        settlementStreamingFrameSequence += 1;
        streamingOwnerMetadataCache?.beginFrame(settlementStreamingFrameSequence);
        const frameNow = Number.isFinite(now) ? now : clock();
        if (!farNaturalWarmStarted && diagnosticProfile.distant
          && pendingRenderDistancePublication === null
          && frameNow >= naturalWarmRetryAt) {
          farNaturalWarmStarted = true;
          recordStaticTreeActivationTime('innerWarmStartedAtMs');
          void diagnostics.measureAsync(
            'distant-sync-natural',
            () => synchronizeDistantPresentation(runtime.getCommittedChunkState(), {
              includeUltraNatural: false,
              revealNatural: true,
              naturalRevealInnerMeters: 0,
            }),
          ).then(committed => {
            if (committed !== true) {
              farNaturalWarmStarted = false;
              ultraNaturalWarmStarted = false;
              naturalWarmRetryAt = clock() + 1_000;
              return;
            }
            recordStaticTreeActivationTime('innerWarmCompletedAtMs');
            recordDistantTreeVisibility();
            const policy = resolveW8RenderDistancePolicy(distantRenderDistance);
            if (!running || ultraNaturalWarmStarted
              || policy.naturalInnerWarmMeters >= policy.fogFarMeters) {
              return;
            }
            ultraNaturalWarmStarted = true;
            recordStaticTreeActivationTime('outerWarmStartedAtMs');
            void diagnostics.measureAsync(
              'distant-sync-natural-outer',
              () => synchronizeDistantPresentation(runtime.getCommittedChunkState(), {
                revealNatural: true,
                naturalRevealInnerMeters: policy.naturalInnerWarmMeters,
              }),
            ).then(outerCommitted => {
              if (outerCommitted === true) {
                recordStaticTreeActivationTime('outerWarmCompletedAtMs');
                recordDistantTreeVisibility();
                return;
              }
              farNaturalWarmStarted = false;
              ultraNaturalWarmStarted = false;
              naturalWarmRetryAt = clock() + 1_000;
            }).catch(error => {
              farNaturalWarmStarted = false;
              ultraNaturalWarmStarted = false;
              naturalWarmRetryAt = clock() + 1_000;
              transitionError = error;
            });
          }).catch(error => {
            farNaturalWarmStarted = false;
            ultraNaturalWarmStarted = false;
            naturalWarmRetryAt = clock() + 1_000;
            transitionError = error;
          });
        }
        const rawFrameMs = Math.max(0, frameNow - lastFrameAt);
        latestFrameDurationMs = rawFrameMs;
        if (diagnosticFrameStarted) diagnostics.finishFrame(rawFrameMs, frameNow);
        diagnostics.startFrame(frameNow);
        diagnosticFrameStarted = diagnostics.enabled;
        const terrainSchedulerFrame = distantPresentation
          .pumpTerrainPresentationScheduler?.() ?? null;
        if (diagnostics.enabled && terrainSchedulerFrame) {
          diagnostics.recordWork('terrain-presentation-scheduler', {
            calls: 1,
            resumed: terrainSchedulerFrame.resumed,
            allowance: terrainSchedulerFrame.allowance,
            urgent: Number(terrainSchedulerFrame.urgent === true),
            pending: terrainSchedulerFrame.pending,
          });
        }
        const deltaSeconds = Math.min(rawFrameMs / 1000, 0.05);
        lastFrameAt = frameNow;
        if (measurement.protocolStartedAt === null) measurement.protocolStartedAt = frameNow;
        const measurementElapsed = frameNow - measurement.protocolStartedAt;
        if (measurement.mode && measurement.status === 'warmup'
          && measurementElapsed >= measurement.warmupMs) {
          runtime.resetPerformance(['frame', 'generation', 'projection', 'load', 'unload', 'rebase', 'crossing']);
          diagnostics.reset();
          originTransformDiagnostics.reset();
          webglRenderDiagnostics?.reset();
          streamingTelemetry.clear();
          distantPresentation.resetTerrainPresentationSchedulerDiagnostics?.();
          Object.assign(terrainMovementDiagnostics, {
            movementBlockedByTerrain: 0,
            movementBlockedByTerrainMs: 0,
            terrainFallbackFrame: 0,
            terrainFallbackMaxDuration: 0,
            fallbackGenerationAge: 0,
            maximumFallbackGenerationAge: 0,
            latestGenerationLagChunks: 0,
            maximumGenerationLagChunks: 0,
            presentationSwapCount: 0,
            preparedMissCount: 0,
            visualBlankFrame: 0,
            visualWorldCoverageMiss: 0,
            collisionCoverageMiss: 0,
          });
          terrainFallbackStartedAtMs = null;
          lastTerrainFallbackOwnerKey = null;
          lastTerrainPresentationSwapAtMs = null;
          terrainLagSpikeDiagnostics.reset();
          terrainLagSpikeCapturePublished = false;
          globalObject.document?.querySelector?.('#terrain-lag-spike-capture')?.remove?.();
          streamingAcceptanceMetrics = null;
          diagnostics.startFrame(frameNow);
          diagnosticFrameStarted = diagnostics.enabled;
          measurement.samplingStartedAt = frameNow;
          measurement.status = 'sampling';
        }
        if (!measurement.mode || measurement.status === 'sampling') runtime.recordFrame(rawFrameMs);
        if (measurement.status === 'sampling'
          && frameNow - measurement.samplingStartedAt >= measurement.sampleMs) {
          measurement.completedAt = frameNow;
          measurement.status = 'complete';
        }
        const runPhase = experienceShell.getRunPhase?.();
        const experiencePhaseRunning = measurement.mode
          || ['intro', 'playing', 'dying'].includes(runPhase);
        const hitStopped = gameplay.isHitStopped(frameNow);
        const effectiveDeltaSeconds = (!experiencePhaseRunning
          || (experienceShell.isPaused() && !measurement.mode))
          || hitStopped ? 0 : deltaSeconds;
        const cloudDeltaSeconds = w8CloudDeltaSeconds({
          deltaSeconds,
          measurementMode: measurement.mode,
          runPhase,
          paused: experienceShell.isPaused(),
          hitStopped,
        });
        const frameRenderOrigin = runtime.getRenderOrigin();
        diagnostics.measure('scene-presentation', () => updateScenePresentation(
          deltaSeconds,
          frameNow,
          cloudDeltaSeconds,
          frameRenderOrigin,
        ));
        if (playerRelocationInProgress) {
          renderActiveScene();
          sealDiagnosticFrame();
          recordTerrainLagSpikeFrame({ frameNow, rawFrameMs, schedulerFrame: terrainSchedulerFrame });
          animationFrameId = requestAnimationFrameFn(frame);
          return;
        }
        const owner = diagnostics.measure(
          'player-update',
          () => updatePlayer(effectiveDeltaSeconds, frameRenderOrigin, deltaSeconds),
        );
        diagnostics.measure('gameplay-update', () => gameplay.update({
            deltaSeconds: effectiveDeltaSeconds,
            player: logicalPlayer,
            playerY: playerMarker.position.y / UNITS_PER_METER,
            renderOrigin: frameRenderOrigin,
            simulationEnabled: isW8GameplaySimulationEnabled(
              measurement.mode,
              runPhase,
              experienceShell.isPaused(),
            ),
          }));
        // Gameplay owns feature damage. Refresh every canonical distant tier
        // after simulation so a Tree destroyed this frame cannot survive for
        // one extra rendered frame as a Forest/Horizon silhouette.
        diagnostics.measure('distant-update', () => distantPresentation.update(
          logicalPlayer.x,
          logicalPlayer.z,
          frameRenderOrigin,
        ));
        diagnostics.measure('render-distance-publication', () => (
          tryCommitRenderDistancePublication()
        ));
        recordDistantTreeVisibility();
        if (runStarted && worldState.revision !== lastSavedRevision) scheduleSave();
        const presentation = diagnostics.measure(
          'presentation-effects', () => gameplay.consumePresentationEffects(),
        );
        if (presentation.cameraShake > 0) {
          experienceShell.applyCameraShake(presentation.cameraShake);
        }
        gameplayRenderAdapter.consumePresentationEvents?.(presentation.events, { playerMarker });
        audioDirector.consume(presentation.events);
        renderActiveScene();
        recordPlayerArrival(owner, frameNow);
        if (frameNow - lastHudAt > 120) {
          diagnostics.measure('hud', () => updateHud(owner));
          lastHudAt = frameNow;
        }
        sealDiagnosticFrame();
        recordTerrainLagSpikeFrame({ frameNow, rawFrameMs, schedulerFrame: terrainSchedulerFrame });
        animationFrameId = requestAnimationFrameFn(frame);
      } catch (error) {
        if (diagnostics.enabled) {
          diagnostics.recordEvent('runtime-frame-failed', {
            name: error?.name ?? 'Error',
            message: error?.message ?? String(error),
          });
          sealDiagnosticFrame();
        }
        failRuntimeLoop(error);
      }
    }

    await runStage('Renderer', () => {
      const owner = updatePlayer(0);
      renderActiveScene();
      recordPlayerArrival(owner, clock());
      state.initialSceneObjectCount = countSceneObjects(scene);
      state.initializationComplete = true;
      state.status = 'ready';
      state.stage = 'Ready';
      state.bootCompletedAt = clock();
      state.bootDurationMs = state.bootCompletedAt - state.bootStartedAt;
      updateHud(owner);
    });

    animationFrameId = requestAnimationFrameFn(frame);
    state.loopStarted = true;

    async function shutdown() {
      if (!running && runtime?.snapshot().activeDataCount === 0) return;
      running = false;
      distantPresentation.invalidatePendingLocalTerrainSync?.();
      distantPresentation.invalidatePendingFarSync?.();
      if (animationFrameId !== null) cancelAnimationFrameFn(animationFrameId);
      if (postCommitTimer !== null) { clearTimeoutFn(postCommitTimer); postCommitTimer = null; }
      if (transitionRetryTimer !== null) {
        clearTimeoutFn(transitionRetryTimer);
        transitionRetryTimer = null;
      }
      cancelScheduledSave();
      removeWindowListener('resize', resize);
      removeWindowListener('pagehide', handlePageHide);
      experienceShell.dispose();
      if (runStarted) await saveForExit();
      diagnostics.dispose();
      streamingTelemetry.dispose();
      await audioDirector.dispose();
      await gameplay.shutdown();
      await runtime.shutdown();
      distantPresentation.dispose();
      await naturalStaticStream.dispose();
      await buildingSettlementStream.dispose();
      await chunkDataService.shutdown();
      scenePresentation.dispose();
      visualAssets.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    }

    return Object.freeze({
      runtime,
      generator,
      renderAdapter,
      renderProfile,
      logicalPlayer,
      bootState: state,
      snapshot: () => {
        const runtimeSnapshot = runtime.snapshot();
        const renderOrigin = runtimeSnapshot.renderOrigin;
        const experienceSnapshot = experienceShell.snapshot();
        const presentationSnapshot = distantPresentation.snapshot();
        const distantPresenterAudit = distantPresentation.presenterAuditSnapshot?.() ?? null;
        const nearVisibleStableIds = new Set(
          renderAdapter.visibleStableIdsSnapshot?.() ?? [],
        );
        const distantVisibleStableIds = new Set([
          ...(distantPresenterAudit?.legacyDistantVisibleStableIds ?? []),
          ...(distantPresenterAudit?.persistentNaturalVisibleStableIds ?? []),
        ]);
        const nearDistantDuplicateStableIds = [...nearVisibleStableIds]
          .filter(stableId => distantVisibleStableIds.has(stableId))
          .sort();
        const fogRenderDistancePreset = Object.keys(W8_RENDER_DISTANCE_PRESETS).find(preset => (
          Math.abs(
            resolveW8RenderDistancePolicy(preset).fogFarMeters * UNITS_PER_METER
              - scene.fog.far,
          ) < 1e-6
        )) ?? null;
        const renderDistancePresets = Object.freeze({
          fog: fogRenderDistancePreset,
          terrain: presentationSnapshot.localTerrainRenderDistancePreset,
          river: presentationSnapshot.distantRenderDistancePreset,
          natural: presentationSnapshot.staticNaturalRenderDistancePreset,
          distant: presentationSnapshot.distantRenderDistancePreset,
        });
        const observedRenderDistancePresets = Object.values(renderDistancePresets)
          .filter(value => value !== null);
        const renderDistanceMixed = new Set(observedRenderDistancePresets).size > 1;
        const terrainFallbackMaxDuration = terrainFallbackStartedAtMs === null
          ? terrainMovementDiagnostics.terrainFallbackMaxDuration
          : Math.max(
            terrainMovementDiagnostics.terrainFallbackMaxDuration,
            clock() - terrainFallbackStartedAtMs,
          );
        return {
          boot: snapshotSandboxBootState(state),
          runtime: runtimeSnapshot,
          resources: renderAdapter.resourceSnapshot(),
          generator: generator.snapshot(),
          chunkDataService: chunkDataService.snapshot(),
          gameplay: gameplay.snapshot(),
          experience: experienceSnapshot,
          runStart: lastRunStartDiagnostics ? Object.freeze({
            ...lastRunStartDiagnostics,
            phaseNow: experienceSnapshot.runPhase,
            phaseElapsedMs: experienceSnapshot.gameplayTimeMs,
            persistentGameplayTimeMs: worldState.gameplayTimeMs,
          }) : null,
          spatial: Object.freeze({
            playerLogical: Object.freeze({
              x: logicalPlayer.x, z: logicalPlayer.z, facingY: logicalPlayer.facingY,
            }),
            playerRender: Object.freeze({
              x: playerMarker.position.x, y: playerMarker.position.y, z: playerMarker.position.z,
            }),
            cameraLogical: Object.freeze({
              x: renderOrigin.renderOriginChunkX * LOGICAL_CHUNK_SIZE_METERS
                + camera.position.x / UNITS_PER_METER,
              y: camera.position.y / UNITS_PER_METER,
              z: renderOrigin.renderOriginChunkZ * LOGICAL_CHUNK_SIZE_METERS
                + camera.position.z / UNITS_PER_METER,
            }),
            cameraRender: Object.freeze({
              x: camera.position.x, y: camera.position.y, z: camera.position.z,
            }),
            cameraCollision: lastCameraCollision,
            spawn: experienceSpawn,
          }),
          save: saveStore.snapshot(),
          audio: audioDirector.snapshot(),
          presentation: presentationSnapshot,
          terrainCoverageDiagnostics: Object.freeze({
            schemaVersion: 'terrain-movement-coverage-diagnostics-1',
            ...terrainMovementDiagnostics,
            terrainFallbackMaxDuration,
          }),
          terrainPresentationDiagnostics:
            runtimeSnapshot.terrainReady?.terrainPresentationScheduling ?? null,
          terrainLagSpikeDiagnostics: terrainLagSpikeDiagnostics.snapshot(),
          chunkDataSubscriberDiagnostics:
            runtimeSnapshot.terrainReady?.chunkDataSubscriberDiagnostics ?? null,
          terrainDependencyDiagnostics:
            runtimeSnapshot.terrainReady?.terrainDependencyDiagnostics ?? null,
          runtimeBuildIdentity: SANDBOX_RUNTIME_BUILD_IDENTITY,
          originTransformDiagnostics: originTransformDiagnostics.snapshot(),
          webglRenderDiagnostics: webglRenderDiagnostics?.snapshot() ?? Object.freeze({
            schemaVersion: 'webgl-render-diagnostics-1',
            buildIdentity: SANDBOX_RUNTIME_BUILD_IDENTITY,
            enabled: false,
            supported: false,
            realWebGLRenderer: false,
            captureCount: 0,
            latest: null,
            incidents: Object.freeze([]),
            pendingIncident: null,
            rendererInfo: null,
            sceneDrawState: null,
            meshDrawState: null,
            canvasScreenshot: null,
          }),
          presentationDiagnostics: Object.freeze({
            schemaVersion: 'w8-browser-acceptance-diagnostics-1',
            browserAcceptance: 'FAIL',
            presenterAudit: distantPresenterAudit,
            nearVisibleStableIdCount: nearVisibleStableIds.size,
            nearDistantDuplicatePresenterCount: nearDistantDuplicateStableIds.length,
            nearDistantDuplicateStableIds: Object.freeze(nearDistantDuplicateStableIds),
            visibleRootRevisions:
              distantPresentation.visibleRootRevisionSnapshot?.() ?? Object.freeze([]),
            treeMaterials: Object.freeze({
              ...(distantPresentation.treeMaterialAuditSnapshot?.() ?? {}),
              rendererOutputColorSpace: renderer.outputColorSpace ?? null,
              sceneFogColorHex: typeof scene.fog?.color?.getHex === 'function'
                ? scene.fog.color.getHex() : null,
              sceneFogNear: scene.fog?.near ?? null,
              sceneFogFar: scene.fog?.far ?? null,
            }),
            lifecycleByObject: collectWorldStreamingAcceptanceMetrics(
              streamingTelemetry.snapshot(),
              {
                targets: Object.freeze([
                  WORLD_STREAMING_TARGET.TREE,
                  WORLD_STREAMING_TARGET.BUSH,
                  WORLD_STREAMING_TARGET.GRASS,
                  WORLD_STREAMING_TARGET.ROCK,
                  WORLD_STREAMING_TARGET.BUILDING,
                  WORLD_STREAMING_TARGET.SETTLEMENT,
                  WORLD_STREAMING_TARGET.NEAR,
                  WORLD_STREAMING_TARGET.DISTANT,
                  WORLD_STREAMING_TARGET.GAMEPLAY,
                ]),
              },
            ),
          }),
          renderDistanceConsistency: Object.freeze({
            schemaVersion: 'render-distance-consistency-observation-1',
            requestedPreset: requestedDistantRenderDistance,
            appliedPreset: distantRenderDistance,
            requestedRevision: renderDistanceRequestRevision,
            publicationPending: pendingRenderDistancePublication !== null,
            pendingPreset: pendingRenderDistancePublication?.preset ?? null,
            pendingRequiredNaturalOwnerCount:
              pendingRenderDistancePublication?.requiredNaturalOwnerKeys?.length ?? 0,
            presets: renderDistancePresets,
            mixed: renderDistanceMixed,
            requestedMismatch: Object.values(renderDistancePresets).some(value => (
              value !== null && value !== requestedDistantRenderDistance
            )),
            atomicPublicationRequired: renderDistanceMixed,
          }),
          scenePresentation: scenePresentation.snapshot(),
          measurement: Object.freeze({ ...measurement }),
          diagnostics: diagnostics.snapshot({
            drawCalls: renderer.info?.render?.calls ?? null,
            geometries: renderer.info?.memory?.geometries ?? null,
            materials: renderAdapter.resourceSnapshot().sharedMaterialCount,
            sceneObjects: countSceneObjects(scene),
          }),
          streamingTelemetry: streamingTelemetry.snapshot(),
          worldStreaming: worldStreamingCoordinator.snapshot(),
          streamingOwnerMetadata: streamingOwnerMetadataCache.snapshot(),
          buildingSettlementShadow: buildingSettlementShadowComparison,
          buildingSettlementStreaming: buildingSettlementStream.snapshot(),
          staticObjectStreaming: naturalStaticStream.snapshot(),
          treePathAudit: Object.freeze({
            treeStaticStreamActivated: naturalStaticStreamActivated,
            treeStaticStreamSuspended: naturalStaticStreamSuspended,
            farNaturalWarmStarted,
            ultraNaturalWarmStarted,
            naturalWarmRetryAt,
            activationTimeline: Object.freeze({ ...staticTreeActivationTimeline }),
            near: renderAdapter.treePathAuditSnapshot?.() ?? null,
            distant: distantPresentation.treePathAuditSnapshot?.() ?? Object.freeze([]),
          }),
          sceneObjectCount: countSceneObjects(scene),
          renderInfo: Object.freeze({
            drawCalls: renderer.info?.render?.calls ?? null,
            triangles: renderer.info?.render?.triangles ?? null,
            geometries: renderer.info?.memory?.geometries ?? null,
            textures: renderer.info?.memory?.textures ?? null,
            canvasWidth: renderer.domElement?.width ?? null,
            canvasHeight: renderer.domElement?.height ?? null,
          }),
        };
      },
      setMeasurementViewport,
      shutdown,
      constants: Object.freeze({ unitsPerMeter: UNITS_PER_METER }),
    });
  } catch (error) {
    recordSandboxBootFailure({ state, hud, error, clock });
    try {
      if (gameplay) await gameplay.shutdown();
      experienceShell?.dispose?.();
      if (runtime && state.stage !== 'Terrain') await runtime.shutdown();
      else if (renderAdapter && !runtime) await renderAdapter.shutdown();
      distantPresentation?.dispose?.();
      await naturalStaticStream?.dispose?.();
      await buildingSettlementStream?.dispose?.();
      await chunkDataService?.shutdown?.();
      scenePresentation?.dispose?.();
      visualAssets?.dispose?.();
      await audioDirector?.dispose?.();
      diagnostics?.dispose?.();
      renderer?.dispose?.();
      renderer?.domElement?.remove?.();
    } catch {
      // The original boot error remains authoritative.
    }
    throw error;
  }
}
