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
  parseChunkKey,
  squareChunkCoordinates,
} from './chunk-coordinates.js';
import { planNextChunkBoundaryPrefetch } from './chunk-streaming-plan.js';
import { sameRuntimeTransitionContract } from './runtime-transition-contract.js';
import { ChunkRenderAdapter } from './render/chunk-render-adapter.js';
import {
  createW8ParityChunkGenerator,
  sampleW8SurfaceHeightMeters,
} from './w8-parity-chunk-generator.js';
import { PersistentChunkIndex } from './persistent-chunk-index.js';
import { InfiniteGameplayRuntime } from './gameplay-runtime.js';
import {
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
  createWorldStreamingTelemetry,
} from './world-streaming-telemetry.js';
import {
  LEGACY_RUNTIME_CHUNK_POLICY_KIND,
  createLegacyRuntimeChunkStreamingPolicy,
} from './world-streaming-plan.js';
import { createWorldStreamingPolicyRegistry } from './world-streaming-policy-registry.js';
import { createWorldStreamingCoordinator } from './world-streaming-coordinator.js';
import {
  createCircularStaticStreamingPolicy,
  createStaticObjectStream,
} from './static-object-stream.js';
import {
  createW8ForestHorizonOwnerPredicate,
} from './forest-horizon-owner-policy.js';
import {
  W8_DEFAULT_RENDER_DISTANCE_PRESET,
  W8_RENDER_FOG_COLOR_HEX,
  W8_RENDER_DISTANCE_PRESETS,
  normalizeW8RenderDistancePreset,
  resolveW8RenderDistancePolicy,
} from './render-distance-policy.js';

export const SANDBOX_BOOT_TIMEOUT_MS = 30_000;

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
  diagnosticProfile = parseW8DiagnosticProfile(
    new globalObject.URLSearchParams(globalObject.location?.search ?? '').get('diagnosticProfile'),
  ),
  diagnosticRunNumber = parseDiagnosticRunNumber(
    new globalObject.URLSearchParams(globalObject.location?.search ?? '').get('diagnosticRun'),
  ),
  diagnosticsEnabled = measurementMode !== null
    || new globalObject.URLSearchParams(globalObject.location?.search ?? '').get('diagnostics') === '1'
    || diagnosticProfile.profileId !== 'baseline',
  streamingTelemetryEnabled = new globalObject.URLSearchParams(
    globalObject.location?.search ?? '',
  ).get('streamingTelemetry') === '1',
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
  let streamingTelemetry = null;
  let worldStreamingCoordinator = null;
  let treeStaticStream = null;
  let treeStaticStreamActivated = false;
  let treeStaticStreamSuspended = false;
  let canonicalWorldSeedHash = null;
  let forestHorizonOwnerPredicate = null;
  let availableSaveSnapshot = null;
  let experienceSpawn = null;
  let running = false;
  let animationFrameId = null;
  let currentStageStartedAt = null;

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
      },
    });
    streamingTelemetry = createWorldStreamingTelemetry({
      enabled: streamingTelemetryEnabled,
      capacity: streamingTelemetryCapacity,
      clock,
    });
    const worldStreamingPolicyRegistry = createWorldStreamingPolicyRegistry();
    worldStreamingPolicyRegistry.register(createLegacyRuntimeChunkStreamingPolicy());
    const treeStaticPolicyRuntime = createCircularStaticStreamingPolicy({
      kind: 'natural-tree',
      publicationGroup: 'natural-static',
      maximumRequiredDistanceMeters: Math.max(
        ...Object.values(W8_RENDER_DISTANCE_PRESETS).map(policy => policy.fogFarMeters),
      ),
      distanceProfileResolver: renderDistancePreset => {
        const policy = resolveW8RenderDistancePolicy(renderDistancePreset);
        return Object.freeze({
          exactDistanceMeters: policy.naturalVisibilityMeters,
          horizonDistanceMeters: policy.fogFarMeters,
        });
      },
      horizonOwnerPredicate: coordinates => {
        forestHorizonOwnerPredicate ??= createW8ForestHorizonOwnerPredicate(
          canonicalWorldSeedHash,
        );
        return forestHorizonOwnerPredicate(coordinates);
      },
    });
    worldStreamingPolicyRegistry.register(treeStaticPolicyRuntime.policy);
    worldStreamingPolicyRegistry.freeze();
    worldStreamingCoordinator = createWorldStreamingCoordinator({
      registry: worldStreamingPolicyRegistry,
    });
    const schedulerTerminalCorrelations = new Set();
    const recordGenerationSchedulerEvent = event => {
      const envelope = event?.envelope;
      const correlationId = envelope?.correlationId ?? null;
      if (!streamingTelemetry.enabled || correlationId === null) return;
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
          },
      };
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
        workerFactory: chunkGeneratorWorkerFactory ?? undefined,
        fallbackTransportFactory: async () => createInlineChunkGeneratorTransport({
          generator: await generatorFactory({ worldSeed: requestedSeed }),
          clock,
          onSchedulerEvent: recordGenerationSchedulerEvent,
        }),
        clock,
        onSchedulerEvent: recordGenerationSchedulerEvent,
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
        generateForestHorizonManifest: request =>
          workerTransport.generateForestHorizonManifest(request),
        cancelForestHorizonRequests: options =>
          workerTransport.cancelForestHorizonRequests(options),
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
          settings: { quality: 'medium', showFps: false, fpsCap: 0 },
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
      const measuredRenderAdapter = {
        rebase: origin => diagnostics.measure('chunk-rebase', () => renderAdapter.rebase(origin)),
        async projectChunk(chunkData, origin, options) {
          const startedAt = clock();
          try {
            return await diagnostics.measureAsync(
              'chunk-projection',
              () => renderAdapter.projectChunk(chunkData, origin, options),
            );
          }
          finally { renderProjectionMs += Math.max(0, clock() - startedAt); }
        },
        loadProjected: projected => diagnostics.measure(
          'chunk-load', () => renderAdapter.loadProjected(projected),
        ),
        unloadChunk: key => diagnostics.measure(
          'chunk-unload', () => renderAdapter.unloadChunk(key),
        ),
        discardProjected: projected => diagnostics.measure(
          'chunk-discard', () => renderAdapter.discardProjected?.(projected),
        ),
        renderCoverageSnapshot: () => renderAdapter.renderCoverageSnapshot?.() ?? null,
        shutdown: () => renderAdapter.shutdown(),
      };
      runtime = runtimeFactory({
        chunkDataService,
        renderAdapter: measuredRenderAdapter,
        cacheCapacity: 81,
        chunkIndex,
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
    treeStaticStream = createStaticObjectStream({
      policyKind: treeStaticPolicyRuntime.policy.kind,
      classifyOwner: treeStaticPolicyRuntime.classifyOwner,
      clock,
      requestOwner: ({
        ownerKey,
        resourceKind,
        priority,
        required,
        deadlineAtMs,
        epoch,
        planId,
      }) => {
        const { chunkX, chunkZ } = parseChunkKey(ownerKey);
        const consumerId = `static-object-stream:${treeStaticPolicyRuntime.policy.kind}:${ownerKey}`;
        if (resourceKind === 'canonical') {
          const existing = runtime.getChunkData(chunkX, chunkZ);
          if (existing) return Object.freeze({ promise: Promise.resolve(existing), cancel: () => false });
          return chunkDataService.requestChunk({
            chunkX,
            chunkZ,
            priority,
            required,
            deadlineAtMs,
            consumerId,
            epoch,
            telemetryTarget: WORLD_STREAMING_TARGET.TREE,
            telemetryStream: WORLD_STREAMING_STREAM.DISTANT,
          });
        }
        const promise = traceGenerationBoundary({
          target: WORLD_STREAMING_TARGET.TREE,
          resourceKey: ownerKey,
          ownerKey,
          metadata: {
            consumerId,
            epoch,
            planId,
            manifest: 'forest-horizon',
          },
        }, schedulerOptions => chunkGeneratorTransport.generateForestHorizonManifest({
          chunkX,
          chunkZ,
          consumerId,
          epoch,
          priority,
          required,
          deadlineAtMs,
          ...schedulerOptions,
        }));
        return Object.freeze({
          promise,
          cancel: reason => chunkGeneratorTransport.cancelForestHorizonRequests({
            consumerId,
            epoch,
            reason: reason ?? 'static-plan-superseded',
          }) > 0,
        });
      },
    });
    distantPresentation = await createW8DistantPresentation({
      THREE,
      scene,
      worldSeedHash: generator.worldSeedHash,
      visualAssets,
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
        if (treeStaticStreamSuspended) return fallback();
        return treeStaticStream.requestOrReuse({
          ownerKey,
          resourceKind: 'canonical',
          fallback,
        });
      },
      getForestHorizonManifest: (chunkX, chunkZ, request = {}) => {
        const ownerKey = `${chunkX},${chunkZ}`;
        const fallback = () => traceGenerationBoundary({
          target: WORLD_STREAMING_TARGET.TREE,
          resourceKey: ownerKey,
          ownerKey,
          metadata: {
            consumerId: request.consumerId ?? 'distant-owner-query',
            epoch: request.epoch ?? 0,
            manifest: 'forest-horizon',
          },
        }, schedulerOptions => chunkGeneratorTransport.generateForestHorizonManifest({
            chunkX,
            chunkZ,
            consumerId: request.consumerId ?? 'distant-owner-query',
            epoch: request.epoch ?? 0,
            ...schedulerOptions,
          }));
        if (treeStaticStreamSuspended) return fallback();
        return treeStaticStream.requestOrReuse({
          ownerKey,
          resourceKind: 'manifest',
          fallback,
        });
      },
      cancelCanonicalChunkRequests: options => {
        const cancelled = chunkDataService.cancelConsumer(options);
        chunkGeneratorTransport.cancelForestHorizonRequests(options);
        return cancelled;
      },
      publishStaticOwnerTickets: ({ ownerKeys }) => {
        if (ownerKeys.length > 0) treeStaticStreamActivated = true;
        return treeStaticStream.publishOwners({ ownerKeys });
      },
      isFeatureDestroyed: stableId => worldState.isFeatureDestroyed(stableId),
      getNearVisibleStableIds: () =>
        renderAdapter.visibleSettlementStableIdsSnapshot?.() ?? [],
      getNearVisibleSettlementIds: () => renderAdapter.visibleSettlementIdsSnapshot?.() ?? [],
      measure: (stage, operation) => diagnostics.measure(stage, operation),
      telemetry: streamingTelemetry,
    });
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
           // Boot must present the already-canonical inner scene before the optional
           // 84–140m tier warms.  The latter is queued from the first frame below.
           includeUltraNatural: false,
         }));
    }
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
    const directionalPrefetchPending = new Set();
    let transitionError = null;
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
    let distantQuality = worldState.experience.settings.quality;
    let distantRenderDistance = normalizeW8RenderDistancePreset(
      worldState.experience.settings.renderDistance
        ?? W8_DEFAULT_RENDER_DISTANCE_PRESET,
    );
    running = true;

    const synchronizeDistantPresentation = (runtimeSnapshot, {
      includeUltraNatural = true,
    } = {}) => distantPresentation.sync({
      transitionContract: runtimeSnapshot.transitionContract,
      activeDataKeys: runtimeSnapshot.activeDataKeys,
      renderedKeys: runtimeSnapshot.renderedKeys,
      getChunkData: (chunkX, chunkZ) => runtime.getChunkData(chunkX, chunkZ),
      renderOrigin: runtimeSnapshot.renderOrigin,
      centerChunkX: runtimeSnapshot.centerChunkX,
      centerChunkZ: runtimeSnapshot.centerChunkZ,
      quality: distantQuality,
      renderDistancePreset: distantRenderDistance,
      playerLogicalX: logicalPlayer.x,
      playerLogicalZ: logicalPlayer.z,
      includeUltraNatural,
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

    const synchronizeLocalTerrainPreset = runtimeSnapshot => (
      distantPresentation.syncLocalTerrainPreset({
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
            const localTerrainResult = await diagnostics.measureAsync(
              'distant-local-terrain-sync',
              () => synchronizeLocalTerrainIncrementally(runtimeState),
            );
            if (!isSameCommittedRuntimeState(committedEpoch, runtimeState)) return;
            if (!localTerrainResult.committed) {
              throw new Error(`Incremental Local Terrain rejected: ${localTerrainResult.reason}`);
            }
            if (diagnosticProfile.distant) {
              await diagnostics.measureAsync(
                'distant-sync',
                () => synchronizeDistantPresentation(runtimeState),
              );
            }
            if (!isSameCommittedRuntimeState(committedEpoch, runtimeState)) return;
            const gameplayResult = await gameplayWork;
            if (!gameplayResult.ok) throw gameplayResult.error;
            if (!isSameCommittedRuntimeState(committedEpoch, runtimeState)) return;
            postCommitCompletedEpoch = committedEpoch;
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
      const owner = decomposeLogicalWorldPosition(logicalWorldX, logicalWorldZ);
      if (!runtime.getChunkData(owner.chunkX, owner.chunkZ)) {
        throw new Error(`formal Terrain is not active for Player Chunk ${owner.key}`);
      }
      const height = sampleCanonicalTerrainHeightMeters(logicalWorldX, logicalWorldZ);
      if (!Number.isFinite(height)) {
        throw new Error(`formal Terrain is not active for Player Chunk ${owner.key}`);
      }
      return height;
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
      treeStaticStreamSuspended = true;
      treeStaticStream.invalidate('load-world');
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
        treeStaticStreamSuspended = false;
        playerRelocationInProgress = false;
      }
    }
    const addWindowListener = (type, listener) => globalObject.addEventListener?.(type, listener);
    const removeWindowListener = (type, listener) => globalObject.removeEventListener?.(type, listener);

    audioDirector = createW8AudioDirector({
      globalObject, volume: worldState.experience.settings.volume,
    });
    const applyRuntimeSettings = settings => {
      const qualityRatio = { low: 1, medium: 1.2, high: 1.5 }[settings.quality] ?? 1.5;
      renderer.setPixelRatio(measurementMode
        ? 1 : Math.min(globalObject.devicePixelRatio ?? 1, qualityRatio));
      renderer.shadowMap.enabled = diagnosticProfile.shadows && settings.quality !== 'low';
      scene.fog.near = W8_GAMEPLAY_FOG_NEAR;
      scene.fog.far = resolveW8RenderDistancePolicy(
        settings.renderDistance,
      ).fogFarMeters * UNITS_PER_METER;
      audioDirector.setVolume(settings.volume);
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
      resolvePlayerHorizontalMovement: input => gameplay.resolvePlayerHorizontalMovement(input),
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
        treeStaticStreamSuspended = true;
        treeStaticStream.invalidate(`start-run:${startMode}`);
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
          treeStaticStreamSuspended = false;
          playerRelocationInProgress = false;
        }
      },
      onReturnTitle: () => {
        treeStaticStreamSuspended = true;
        treeStaticStream.invalidate('return-title');
        const saving = saveWorld({ force: true });
        returnTitleSavePromise = saving;
        void saving.finally(() => {
          if (returnTitleSavePromise === saving) returnTitleSavePromise = null;
        });
        return saving;
      },
      onResetHome: async () => {
        playerRelocationInProgress = true;
        treeStaticStreamSuspended = true;
        treeStaticStream.invalidate('reset-home');
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
          treeStaticStreamSuspended = false;
          playerRelocationInProgress = false;
        }
      },
      onRestart: async () => {
        playerRelocationInProgress = true;
        treeStaticStreamSuspended = true;
        treeStaticStream.invalidate('restart');
        try {
          await gameplay.restart({
            playerSpawn: experienceSpawn,
            renderOrigin: runtime.snapshot().renderOrigin,
          });
          worldState.updatePlayer({ facingY: experienceSpawn.facingY });
          await synchronizeRuntimeToLogicalPlayer();
          runStarted = true;
          await saveWorld({ force: true });
          return Object.freeze({ cameraYaw: experienceSpawn.cameraYaw });
        } finally {
          treeStaticStreamSuspended = false;
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
        const renderDistanceChanged = nextRenderDistance !== distantRenderDistance;
        distantQuality = settings.quality;
        distantRenderDistance = nextRenderDistance;
        applyRuntimeSettings(settings);
        if ((qualityChanged || renderDistanceChanged) && diagnosticProfile.distant) {
          if (renderDistanceChanged) {
            localTerrainCoverageEpoch = Math.max(
              localTerrainCoverageEpoch,
              distantPresentation.invalidatePendingLocalTerrainSync?.()
                ?? localTerrainCoverageEpoch,
            );
          }
          const runtimeSnapshot = runtime.snapshot();
          scenePresentation.rebase(runtimeSnapshot.renderOrigin);
          commitDistantRuntimeState(runtimeSnapshot);
          void diagnostics.measureAsync(
            'distant-sync',
            async () => {
              const committed = await synchronizeDistantPresentation(runtimeSnapshot);
              if (committed && renderDistanceChanged
                && distantRenderDistance === nextRenderDistance) {
                await diagnostics.measureAsync(
                  'distant-local-preset-sync',
                  () => synchronizeLocalTerrainPreset(runtimeSnapshot),
                );
              }
              return committed;
            },
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

    function requestTransition(owner) {
      if (transitionTargetKey
        || runtime.isCenteredAt(owner.chunkX, owner.chunkZ)) return;
      transitionTargetKey = owner.key;
      diagnostics.measureAsync(
        'chunk-transition',
        () => runtime.transitionToChunk(owner.chunkX, owner.chunkZ),
      )
        .then(async () => {
          const nextState = runtime.getCommittedChunkState();
          scenePresentation.rebase(nextState.renderOrigin);
          commitDistantRuntimeState(nextState);
          const gameplayRebase = gameplayRenderAdapter.rebase(nextState.renderOrigin);
          schedulePostCommitWork(nextState);
          await gameplayRebase;
        })
        .catch(error => { transitionError = error; })
        .finally(() => { transitionTargetKey = null; });
    }

    function requestDirectionalPrefetch(movement) {
      const streaming = runtime.getStreamingState();
      if (streaming.centerChunkX === null || transitionTargetKey || movement.speedMetersPerSecond <= 0) return;
      const plan = planNextChunkBoundaryPrefetch({
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
      if (!plan || directionalPrefetchPending.has(plan.targetKey)) return;
      directionalPrefetchPending.add(plan.targetKey);
      void diagnostics.measureAsync(
        'chunk-prefetch',
        () => runtime.prepareTransition(plan.targetChunkX, plan.targetChunkZ),
      ).catch(error => { transitionError = error; })
        .finally(() => directionalPrefetchPending.delete(plan.targetKey));
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
      if (measurement.mode === 'crossing' && measurement.status === 'sampling') {
        logicalPlayer.x += scaleProfile.movementMetersPerSecond * deltaSeconds;
        logicalPlayer.facingY = Math.PI / 2;
        movement = Object.freeze({
          velocityX: scaleProfile.movementMetersPerSecond,
          velocityZ: 0,
          speedMetersPerSecond: scaleProfile.movementMetersPerSecond,
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
      }
      const owner = decomposeLogicalWorldPosition(logicalPlayer.x, logicalPlayer.z);
      requestDirectionalPrefetch(movement);
      requestTransition(owner);
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
      const worldStreamingPlan = worldStreamingCoordinator.createShadowPlan({
        player: { x: logicalPlayer.x, z: logicalPlayer.z },
        velocity: { x: movement.velocityX, z: movement.velocityZ },
        renderDistancePreset: distantRenderDistance,
        stateRevision: worldState.revision,
        originGeneration: committedChunkState.transitionContract?.generation ?? 0,
        currentRequests: {
          [LEGACY_RUNTIME_CHUNK_POLICY_KIND]: {
            requiredOwnerKeys: committedChunkState.renderedKeys,
            requestOwnerKeys: committedChunkState.activeDataKeys,
            retainedOwnerKeys: committedChunkState.activeDataKeys,
          },
        },
      });
      const treePolicyPlan = worldStreamingPlan.policyPlans.find(
        policy => policy.kind === treeStaticPolicyRuntime.policy.kind,
      );
      if (treeStaticStreamActivated && !treeStaticStreamSuspended
        && !playerRelocationInProgress) {
        treeStaticStream.applyPlan({ plan: worldStreamingPlan, policyPlan: treePolicyPlan });
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
      const presentationSnapshot = distantPresentation.snapshot();
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
      const measurementReport = diagnostics.snapshot({
        drawCalls: renderInfo?.render?.calls ?? null,
        triangles: renderInfo?.render?.triangles ?? null,
        geometries: renderInfo?.memory?.geometries ?? null,
        materials: renderResources.sharedMaterialCount,
        sceneObjects: countSceneObjects(scene),
      });
      const stageP95 = stage => number(measurementReport.stages[stage]?.p95);
      const longTaskMaximum = measurementReport.longTasks.reduce(
        (maximum, entry) => Math.max(maximum, entry.durationMs), 0,
      );
      const measurementText = measurement.mode
        ? `\nMeasurement: ${measurement.mode} ${measurement.status}  1920x1080  warm-up 10s + sample 60s`
        : '';
      const diagnosticText = diagnostics.enabled
        ? `\nDiagnostic: ${diagnosticProfile.profileId} run ${diagnosticRunNumber}  hitch ${(measurementReport.hitchRatio * 100).toFixed(2)}%\nMeasurement frame count/p50/p95/p99/max: ${measurementReport.frame.count} / ${number(measurementReport.frame.p50)} / ${number(measurementReport.frame.p95)} / ${number(measurementReport.frame.p99)} / ${number(measurementReport.frame.max)} ms\nLong Tasks count/max: ${measurementReport.longTasks.length} / ${number(longTaskMaximum)} ms  Resources draw/triangles/geometry/material/scene: ${measurementReport.resources.drawCalls ?? 'n/a'} / ${measurementReport.resources.triangles ?? 'n/a'} / ${measurementReport.resources.geometries ?? 'n/a'} / ${measurementReport.resources.materials ?? 'n/a'} / ${measurementReport.resources.sceneObjects ?? 'n/a'}\nStage p95 ms: transition ${stageP95('chunk-transition')}  prefetch ${stageP95('chunk-prefetch')}  distant ${stageP95('distant-sync')}  gameplay-sync ${stageP95('gameplay-sync')}  gameplay-update ${stageP95('gameplay-update')}  save ${stageP95('save-total')}  render ${stageP95('render')}\nDistant p95 ms: clear ${stageP95('distant-clear')}  terrain ${stageP95('distant-midground-terrain')}  features ${stageP95('distant-midground-features')}  clipmap ${stageP95('distant-clipmap')}  proxies ${stageP95('distant-feature-proxies')}`
        : '';
      const warningText = runtimeSnapshot.warnings.length ? `\n警告: ${runtimeSnapshot.warnings.join(' / ')}` : '';
      const errorText = transitionError ? `\nERROR: ${transitionError.message}` : '';
      const worldStreamingSnapshot = worldStreamingCoordinator.snapshot();
      const staticTreeStreaming = treeStaticStream.diagnostics();
      const shadowPolicy = worldStreamingSnapshot.latestPlan?.policyPlans?.find(
        policy => policy.kind === LEGACY_RUNTIME_CHUNK_POLICY_KIND,
      ) ?? null;
      const shadowComparison = worldStreamingSnapshot.latestComparison?.policies?.find(
        policy => policy.kind === LEGACY_RUNTIME_CHUNK_POLICY_KIND,
      ) ?? null;
      const shadowDiagnosticText = diagnostics.enabled
        ? `\nWorld Streaming Shadow: ${escapeHtml(worldStreamingSnapshot.latestPlan?.planId ?? 'none')}  preset ${escapeHtml(worldStreamingSnapshot.latestPlan?.renderDistancePreset ?? 'none')}  match ${shadowComparison?.matches === true ? 'yes' : shadowComparison?.matches === false ? 'no' : 'unobserved'}  required ${shadowPolicy?.requiredOwnerKeys.length ?? 0}/${shadowComparison?.required?.observedCount ?? 0}  request ${shadowPolicy?.requestOwnerKeys.length ?? 0}/${shadowComparison?.requested?.observedCount ?? 0}  retained ${shadowPolicy?.retainedOwnerKeys.length ?? 0}/${shadowComparison?.retained?.observedCount ?? 0}  corridor ${shadowPolicy?.velocityCorridor.ownerKeys.length ?? 0} owner  plan ${number(worldStreamingSnapshot.performance.lastPlanDurationMs)}/${number(worldStreamingSnapshot.performance.p95PlanDurationMs)}/${number(worldStreamingSnapshot.performance.maximumPlanDurationMs)}ms last/p95/max`
        : '';
      const staticStreamingDiagnosticText = `\nStatic Tree Stream: ${escapeHtml(staticTreeStreaming.latestPlanId ?? 'inactive')}  required ${staticTreeStreaming.readyRequiredOwnerCount}/${staticTreeStreaming.requiredOwnerCount}  prefetch ${staticTreeStreaming.readyPrefetchedOwnerCount}/${staticTreeStreaming.prefetchedOwnerCount}  backlog ${staticTreeStreaming.backlog}  requested/hit/reuse ${staticTreeStreaming.requestedCount}/${staticTreeStreaming.readyHitCount}/${staticTreeStreaming.pendingReuseCount}  tickets ${staticTreeStreaming.publishedTicketCount}/${staticTreeStreaming.ticketCount}  cancel/fail/invalidate ${staticTreeStreaming.cancelledCount}/${staticTreeStreaming.failedCount}/${staticTreeStreaming.invalidationCount}  Worker ${staticTreeStreaming.workerCount}`;
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
Render Distance: ${escapeHtml(presentationSnapshot.renderDistancePreset)}  Natural ${number(presentationSnapshot.naturalVisibilityMeters)}m  Terrain/River ${number(presentationSnapshot.clipmapExtentMeters)}m  General ${number(presentationSnapshot.visibilityMeters)}m  Settlement ${number(presentationSnapshot.remoteHorizonHiddenDistanceMeters)}m
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
Render resources: draw ${renderInfo?.render?.calls ?? 'n/a'}  geometry ${renderInfo?.memory?.geometries ?? 'n/a'}  material ${renderResources.sharedMaterialCount}  scene ${countSceneObjects(scene)}${staticStreamingDiagnosticText}${measurementText}${diagnosticText}${shadowDiagnosticText}${escapeHtml(warningText)}${escapeHtml(errorText)}`;
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
        renderer.render(scene, camera);
        if (streamingTelemetry.enabled) {
          renderAdapter.markFirstDraw?.();
          distantPresentation.markFirstDraw?.();
          gameplayRenderAdapter.markFirstDraw?.();
        }
      });
    }

    function frame(now) {
      if (!running) return;
      try {
        const frameNow = Number.isFinite(now) ? now : clock();
        if (!farNaturalWarmStarted && diagnosticProfile.distant) {
          farNaturalWarmStarted = true;
          void diagnostics.measureAsync(
            'distant-sync',
            () => synchronizeDistantPresentation(runtime.getCommittedChunkState(), { includeUltraNatural: false }),
          ).then(() => {
            if (!running || ultraNaturalWarmStarted) return;
            ultraNaturalWarmStarted = true;
            void diagnostics.measureAsync(
              'distant-sync-ultra',
              () => synchronizeDistantPresentation(runtime.getCommittedChunkState()),
            ).catch(error => { transitionError = error; });
          }).catch(error => { transitionError = error; });
        }
        const rawFrameMs = Math.max(0, frameNow - lastFrameAt);
        latestFrameDurationMs = rawFrameMs;
        if (diagnosticFrameStarted) diagnostics.finishFrame(rawFrameMs, frameNow);
        diagnostics.startFrame(frameNow);
        diagnosticFrameStarted = diagnostics.enabled;
        const deltaSeconds = Math.min(rawFrameMs / 1000, 0.05);
        lastFrameAt = frameNow;
        if (measurement.protocolStartedAt === null) measurement.protocolStartedAt = frameNow;
        const measurementElapsed = frameNow - measurement.protocolStartedAt;
        if (measurement.mode && measurement.status === 'warmup'
          && measurementElapsed >= measurement.warmupMs) {
          runtime.resetPerformance(['frame', 'generation', 'projection', 'load', 'unload', 'rebase', 'crossing']);
          diagnostics.reset();
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
          animationFrameId = requestAnimationFrameFn(frame);
          return;
        }
        const owner = diagnostics.measure(
          'player-update',
          () => updatePlayer(effectiveDeltaSeconds, frameRenderOrigin, deltaSeconds),
        );
        diagnostics.measure('distant-update', () => distantPresentation.update(
          logicalPlayer.x,
          logicalPlayer.z,
          frameRenderOrigin,
        ));
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
        animationFrameId = requestAnimationFrameFn(frame);
      } catch (error) {
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
      await treeStaticStream.dispose();
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
          presentation: distantPresentation.snapshot(),
          scenePresentation: scenePresentation.snapshot(),
          measurement: Object.freeze({ ...measurement }),
          streamingTelemetry: streamingTelemetry.snapshot(),
          worldStreaming: worldStreamingCoordinator.snapshot(),
          staticObjectStreaming: treeStaticStream.snapshot(),
          diagnostics: diagnostics.snapshot({
            drawCalls: renderer.info?.render?.calls ?? null,
            geometries: renderer.info?.memory?.geometries ?? null,
            materials: renderAdapter.resourceSnapshot().sharedMaterialCount,
            sceneObjects: countSceneObjects(scene),
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
      await treeStaticStream?.dispose?.();
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
    let farNaturalWarmStarted = false;
    let ultraNaturalWarmStarted = false;
