import { ChunkRuntimeManager } from './chunk-runtime-manager.js';
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
import { ChunkRenderAdapter } from './render/chunk-render-adapter.js';
import {
  createW8ParityChunkGenerator,
  sampleW8SurfaceHeightMeters,
} from './w8-parity-chunk-generator.js';
import { createMigratedSettlementTemplate } from './single-rural-settlement.js';
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
} from './world-state-store.js';
import { createInfiniteExperienceShell } from './experience-shell.js';
import { createW8AudioDirector } from './w8-audio.js';
import { createW8DistantPresentation } from './render/w8-distant-presentation.js';
import {
  createW8RuntimeDiagnostics,
  parseW8DiagnosticProfile,
} from './runtime-diagnostics.js';

export const SANDBOX_BOOT_TIMEOUT_MS = 30_000;

const FINITE_TO_INFINITE_RENDER_SCALE = UNITS_PER_METER / PRODUCTION_VISUAL_UNITS_PER_METER;
const finiteVisualToRender = value => value * FINITE_TO_INFINITE_RENDER_SCALE;
const W8_GAMEPLAY_CAMERA_FAR = finiteVisualToRender(35_000);
const W8_GAMEPLAY_FOG_NEAR = finiteVisualToRender(3_000);
const W8_GAMEPLAY_FOG_FAR_BY_QUALITY = Object.freeze({
  high: finiteVisualToRender(12_000),
  medium: finiteVisualToRender(9_000),
  low: finiteVisualToRender(6_500),
});

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

export function isW8GameplaySimulationEnabled(measurementMode, runPhase) {
  return measurementMode !== null || runPhase === 'playing';
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
  state = createSandboxBootState(),
  generatorFactory = createW8ParityChunkGenerator,
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
  let audioDirector = null;
  let diagnostics = null;
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
    generator = await runStage('Legacy Core', () => generatorFactory({ worldSeed: requestedSeed }));
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
        state.saveError = { name: error?.name ?? 'Error', message: error?.message ?? String(error) };
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
      nextScene.background = new THREE.Color(0x5dade2);
      nextScene.fog = new THREE.Fog(
        0x5dade2,
        W8_GAMEPLAY_FOG_NEAR,
        W8_GAMEPLAY_FOG_FAR_BY_QUALITY.high,
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
      });
      const chunkIndex = chunkIndexFactory({ capacity: 65_536 });
      const logicalPlayer = worldState.player;
      const initialOwner = decomposeLogicalWorldPosition(logicalPlayer.x, logicalPlayer.z);
      let chunkGenerationMs = 0;
      let renderProjectionMs = 0;
      const measuredGenerator = {
        async generateChunk(chunkX, chunkZ) {
          const startedAt = clock();
          try {
            return await diagnostics.measureAsync(
              'chunk-generation',
              () => generator.generateChunk(chunkX, chunkZ),
            );
          }
          finally { chunkGenerationMs += Math.max(0, clock() - startedAt); }
        },
      };
      const measuredRenderAdapter = {
        rebase: origin => diagnostics.measure('chunk-rebase', () => renderAdapter.rebase(origin)),
        async projectChunk(chunkData, origin) {
          const startedAt = clock();
          try {
            return await diagnostics.measureAsync(
              'chunk-projection',
              () => renderAdapter.projectChunk(chunkData, origin),
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
        shutdown: () => renderAdapter.shutdown(),
      };
      runtime = runtimeFactory({
        generator: measuredGenerator,
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
    distantPresentation = await createW8DistantPresentation({
      THREE,
      scene,
      worldSeedHash: generator.worldSeedHash,
      visualAssets,
      findSettlementsNear: generator.distributor.findSettlementsNear,
      resolveTemplate: createMigratedSettlementTemplate,
      getCanonicalChunkData: async (chunkX, chunkZ) =>
        runtime.getChunkData(chunkX, chunkZ) ?? generator.generateChunk(chunkX, chunkZ),
      isFeatureDestroyed: stableId => worldState.isFeatureDestroyed(stableId),
      measure: (stage, operation) => diagnostics.measure(stage, operation),
    });
    if (diagnosticProfile.distant) {
      const runtimeSnapshot = runtime.snapshot();
      await diagnostics.measureAsync('distant-sync', () => distantPresentation.sync({
          activeDataKeys: runtimeSnapshot.activeDataKeys,
          renderedKeys: runtimeSnapshot.renderedKeys,
          getChunkData: (chunkX, chunkZ) => runtime.getChunkData(chunkX, chunkZ),
           renderOrigin: runtimeSnapshot.renderOrigin,
           centerChunkX: runtimeSnapshot.centerChunkX,
           centerChunkZ: runtimeSnapshot.centerChunkZ,
           quality: worldState.experience.settings.quality,
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

    await runStage('Settlement', () => {
      const runtimeSnapshot = runtime.snapshot();
      const generatorSnapshot = generator.snapshot();
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
      });
      gameplayRenderAdapter.consumePresentationEvents?.([], { playerMarker });
      gameplay = gameplayRuntimeFactory({
        worldSeedHash: generator.worldSeedHash,
        generatorMajor: generator.generatorVersion.major,
        state: worldState,
        renderAdapter: gameplayRenderAdapter,
        featureRenderAdapter: renderAdapter,
        getChunkDataForQuery: (chunkX, chunkZ) => generator.generateChunk(chunkX, chunkZ),
        sampleTerrainHeight: sampleCanonicalTerrainHeightMeters,
        clock,
      });
      const runtimeSnapshot = runtime.snapshot();
      if (diagnosticProfile.gameplaySync) {
        await diagnostics.measureAsync('gameplay-sync', () => gameplay.syncActiveChunks({
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
    let saveStatus = state.saveAvailable ? 'available' : state.saveError ? 'invalid' : 'new';
    let lastFrameAt = clock();
    let lastHudAt = 0;
    let lastVisualPlayerX = logicalPlayer.x;
    let lastVisualPlayerZ = logicalPlayer.z;
    let diagnosticFrameStarted = false;
    let saveTimer = null;
    let saveIdleCallback = null;
    let lastSavedRevision = -1;
    let runStarted = false;
    let farNaturalWarmStarted = false;
    let ultraNaturalWarmStarted = false;
    let lastRunStartDiagnostics = null;
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
    running = true;

    const synchronizeDistantPresentation = (runtimeSnapshot, {
      includeUltraNatural = true,
    } = {}) => distantPresentation.sync({
      activeDataKeys: runtimeSnapshot.activeDataKeys,
      renderedKeys: runtimeSnapshot.renderedKeys,
      getChunkData: (chunkX, chunkZ) => runtime.getChunkData(chunkX, chunkZ),
      renderOrigin: runtimeSnapshot.renderOrigin,
      centerChunkX: runtimeSnapshot.centerChunkX,
      centerChunkZ: runtimeSnapshot.centerChunkZ,
      quality: distantQuality,
      playerLogicalX: logicalPlayer.x,
      playerLogicalZ: logicalPlayer.z,
      includeUltraNatural,
    });

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
      const runtimeSnapshot = runtime.snapshot();
      scenePresentation.rebase(runtimeSnapshot.renderOrigin);
      distantPresentation.rebase(runtimeSnapshot.renderOrigin);
      if (diagnosticProfile.distant) {
        await diagnostics.measureAsync(
          'distant-sync',
          () => synchronizeDistantPresentation(runtimeSnapshot),
        );
      }
      if (diagnosticProfile.gameplaySync) {
        await diagnostics.measureAsync('gameplay-sync', () => gameplay.syncActiveChunks({
          activeDataKeys: runtimeSnapshot.activeDataKeys,
          renderedKeys: runtimeSnapshot.renderedKeys,
          getChunkData: (chunkX, chunkZ) => runtime.getChunkData(chunkX, chunkZ),
          renderOrigin: runtimeSnapshot.renderOrigin,
        }));
      }
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
      try {
        await diagnostics.measureAsync('save-total', () => saveStore.save(worldState));
        lastSavedRevision = worldState.revision;
        state.saveAvailable = true;
        experienceShell?.setContinueAvailable?.(true);
        saveStatus = 'saved';
      } catch (error) {
        transitionError = error;
        saveStatus = 'failed';
      }
    }
    function scheduleSave({ immediate = false } = {}) {
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
        void saveWorld({ force: true });
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
      }, 5_000);
      return true;
    }
    async function loadWorld() {
      playerRelocationInProgress = true;
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
        saveStatus = 'loaded';
        state.saveLoaded = true;
        return true;
      } catch (error) {
        transitionError = error;
        saveStatus = 'failed';
        return false;
      } finally {
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
      scene.fog.far = W8_GAMEPLAY_FOG_FAR_BY_QUALITY[settings.quality]
        ?? W8_GAMEPLAY_FOG_FAR_BY_QUALITY.high;
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
      onAttack: mode => gameplay.attack(mode),
      onCombatCommand: command => gameplay.executeCombatCommand(command),
      onPlayerLanding: input => gameplay.playerLanding(input),
      onSave: () => { void saveWorld({ force: true }); },
      onLoad: () => { void loadWorld(); },
      continueAvailable: state.saveAvailable,
      treeLodDiagnosticsAvailable: () => diagnostics.enabled || worldState.developerTools === true,
      onTreeLodOverlayChanged: enabled => {
        distantPresentation.setTreeLodDiagnosticsEnabled?.(
          (diagnostics.enabled || worldState.developerTools === true) && enabled === true,
        );
      },
      onStartRun: async (startMode, { skipConfirmation = false } = {}) => {
        playerRelocationInProgress = true;
        const phaseBefore = experienceShell?.getRunPhase?.() ?? 'menu';
        const gameplayTimeBeforeMs = worldState.gameplayTimeMs;
        const playerBefore = Object.freeze({ ...logicalPlayer });
        const cameraBefore = Object.freeze({
          x: camera.position.x, y: camera.position.y, z: camera.position.z,
        });
        try {
          let synchronized;
          if (startMode === 'continue') {
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
          lastSavedRevision = worldState.revision;
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
          playerRelocationInProgress = false;
        }
      },
      onHome: async () => {
        playerRelocationInProgress = true;
        try {
          logicalPlayer.x = experienceSpawn.x;
          logicalPlayer.z = experienceSpawn.z;
          logicalPlayer.facingY = experienceSpawn.facingY;
          await synchronizeRuntimeToLogicalPlayer();
        } catch (error) {
          transitionError = error;
        } finally {
          playerRelocationInProgress = false;
        }
      },
      onRestart: async () => {
        playerRelocationInProgress = true;
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
        distantQuality = settings.quality;
        applyRuntimeSettings(settings);
        if (qualityChanged && diagnosticProfile.distant) {
          const runtimeSnapshot = runtime.snapshot();
          scenePresentation.rebase(runtimeSnapshot.renderOrigin);
          distantPresentation.rebase(runtimeSnapshot.renderOrigin);
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
    const handlePageHide = () => scheduleSave({ immediate: true });
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
      const runtimeSnapshot = runtime.snapshot();
      if (transitionTargetKey
        || (runtimeSnapshot.centerChunkX === owner.chunkX && runtimeSnapshot.centerChunkZ === owner.chunkZ)) return;
      transitionTargetKey = owner.key;
      diagnostics.measureAsync(
        'chunk-transition',
        () => runtime.transitionToChunk(owner.chunkX, owner.chunkZ),
      )
        .then(async () => {
          const nextSnapshot = runtime.snapshot();
          scenePresentation.rebase(nextSnapshot.renderOrigin);
          distantPresentation.rebase(nextSnapshot.renderOrigin);
          if (diagnosticProfile.distant) {
            await diagnostics.measureAsync(
              'distant-sync',
              () => synchronizeDistantPresentation(nextSnapshot),
            );
          }
          if (!diagnosticProfile.gameplaySync) return null;
          return diagnostics.measureAsync('gameplay-sync', () => gameplay.syncActiveChunks({
              activeDataKeys: nextSnapshot.activeDataKeys,
              renderedKeys: nextSnapshot.renderedKeys,
              getChunkData: (chunkX, chunkZ) => runtime.getChunkData(chunkX, chunkZ),
              renderOrigin: nextSnapshot.renderOrigin,
            }));
        })
        .catch(error => { transitionError = error; })
        .finally(() => { transitionTargetKey = null; });
    }

    function requestDirectionalPrefetch(owner) {
      const runtimeSnapshot = runtime.snapshot();
      if (runtimeSnapshot.centerChunkX === null || transitionTargetKey) return;
      const directionX = Math.sin(logicalPlayer.facingY);
      const directionZ = Math.cos(logicalPlayer.facingY);
      let targetChunkX = runtimeSnapshot.centerChunkX;
      let targetChunkZ = runtimeSnapshot.centerChunkZ;
      if (directionX > 0.35 && owner.logicalLocalX >= LOGICAL_CHUNK_SIZE_METERS * 0.5) targetChunkX += 1;
      else if (directionX < -0.35 && owner.logicalLocalX <= LOGICAL_CHUNK_SIZE_METERS * 0.5) targetChunkX -= 1;
      if (directionZ > 0.35 && owner.logicalLocalZ >= LOGICAL_CHUNK_SIZE_METERS * 0.5) targetChunkZ += 1;
      else if (directionZ < -0.35 && owner.logicalLocalZ <= LOGICAL_CHUNK_SIZE_METERS * 0.5) targetChunkZ -= 1;
      if (targetChunkX === runtimeSnapshot.centerChunkX && targetChunkZ === runtimeSnapshot.centerChunkZ) return;
      const missing = squareChunkCoordinates(targetChunkX, targetChunkZ, 2)
        .find(coordinate => runtime.getChunkData(coordinate.chunkX, coordinate.chunkZ) === null
          && !directionalPrefetchPending.has(coordinate.key));
      if (!missing) return;
      directionalPrefetchPending.add(missing.key);
      void diagnostics.measureAsync(
        'chunk-prefetch',
        () => runtime.prefetchChunk(missing.chunkX, missing.chunkZ),
      ).catch(error => { transitionError = error; })
        .finally(() => directionalPrefetchPending.delete(missing.key));
    }

    function updatePlayer(
      deltaSeconds,
      renderOrigin = runtime.snapshot().renderOrigin,
      cameraDeltaSeconds = deltaSeconds,
    ) {
      const scaleProfile = getW6ScaleProfile(worldState.activeScaleStageId);
      if (measurement.mode === 'crossing' && measurement.status === 'sampling') {
        logicalPlayer.x += scaleProfile.movementMetersPerSecond * deltaSeconds;
        logicalPlayer.facingY = Math.PI / 2;
      } else if (!measurement.mode) {
        experienceShell.updatePlayer({
          deltaSeconds,
          player: logicalPlayer,
          scaleProfile,
          movementMultiplier: gameplay.getPlayerMovementMultiplier(),
        });
      }
      const owner = decomposeLogicalWorldPosition(logicalPlayer.x, logicalPlayer.z);
      requestDirectionalPrefetch(owner);
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
      return owner;
    }

    function updateHud(owner) {
      const runtimeSnapshot = runtime.snapshot();
      const experienceSnapshot = experienceShell.snapshot();
      distantPresentation.setTreeLodDiagnosticsEnabled?.(
        (diagnostics.enabled || worldState.developerTools === true)
          && experienceSnapshot.treeLodOverlayEnabled === true,
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
      const gameplaySnapshot = gameplay.snapshot();
      const renderInfo = renderer.info;
      const measurementReport = diagnostics.snapshot({
        drawCalls: renderInfo?.render?.calls ?? null,
        triangles: renderInfo?.render?.triangles ?? null,
        geometries: renderInfo?.memory?.geometries ?? null,
        materials: renderAdapter.resourceSnapshot().sharedMaterialCount,
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
      const settlementReference = currentChunk?.settlementReferences?.[0];
      const fogFarMeters = scene.fog.far / UNITS_PER_METER;
      const cloudWithinFogCount = scenePresentationSnapshot.clouds.filter(cloud => Math.hypot(
        cloud.logicalX - logicalPlayer.x,
        cloud.logicalZ - logicalPlayer.z,
      ) <= fogFarMeters).length;
      hud.innerHTML = `<span id="badge">W8 / FINITE EXPERIENCE PARITY</span>
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
Rendered: ${runtimeSnapshot.renderedCount}/9  Prefetched Data: ${runtimeSnapshot.activeDataCount}/25  Cache: ${runtimeSnapshot.cacheSize}/${runtimeSnapshot.cacheCapacity}
Distant: mid ${presentationSnapshot.midgroundChunkCount}  natural ${presentationSnapshot.distantNaturalProxyCount}/${presentationSnapshot.distantNaturalProxyLimit}  town ${presentationSnapshot.distantTownProxyCount}/${presentationSnapshot.distantTownProxyLimit}  water ${presentationSnapshot.distantWaterProxyCount}  boundary RGB ${number(presentationSnapshot.maximumInnerBoundaryColorDifference)}
Canonical: settlements ${presentationSnapshot.queryCandidateCount}/${presentationSnapshot.queryTemplateSuccessCount} resolved  owner Chunks ${presentationSnapshot.queryCanonicalChunkSuccessCount}/${presentationSnapshot.queryOwnerChunkCount}  records ${presentationSnapshot.canonicalRecordCount} (building ${presentationSnapshot.canonicalBuildingRecordCount}, landmark ${presentationSnapshot.canonicalLandmarkRecordCount}, road ${presentationSnapshot.canonicalRoadRecordCount})  visible Far ${presentationSnapshot.canonicalFarObjectCount} / Mid ${presentationSnapshot.canonicalMidObjectCount} / Near handoff ${presentationSnapshot.canonicalNearObjectCount}
Tree LOD: full ${presentationSnapshot.visibleCanonicalFullTreeCount}  silhouette ${presentationSnapshot.visibleCanonicalSilhouetteTreeCount}  ultra ${presentationSnapshot.visibleCanonicalUltraTreeCount}  84-124m ${presentationSnapshot.visibleCanonicalTreeUltraInnerBandCount}  124-140m ${presentationSnapshot.visibleCanonicalTreeUltraOuterBandCount}  parts ${presentationSnapshot.visibleCanonicalTreePartInstanceCount}
Horizon: current Settlement ${escapeHtml(presentationSnapshot.currentSettlementId ?? 'none')}  building ${presentationSnapshot.visibleCanonicalHorizonBuildingCount}  landmark ${presentationSnapshot.visibleCanonicalHorizonLandmarkCount}  parts ${presentationSnapshot.visibleCanonicalHorizonPartInstanceCount}  destroyed ${presentationSnapshot.destroyedHorizonBuildingCount}
Far Query: ultra owner ${presentationSnapshot.queryUltraOwnerChunkCount}  cache ${presentationSnapshot.queryUltraOwnerChunkCacheHits}/${presentationSnapshot.queryUltraOwnerChunkCacheMisses}/${presentationSnapshot.queryUltraOwnerChunkCacheEvictions}  warm ${number(presentationSnapshot.ultraWarmDurationMs)}ms  building owner ${presentationSnapshot.queryBuildingOwnerChunkCount}  cache ${presentationSnapshot.queryFarOwnerChunkCacheHits}/${presentationSnapshot.queryFarOwnerChunkCacheMisses}/${presentationSnapshot.queryFarOwnerChunkCacheEvictions}  inner warm ${number(presentationSnapshot.innerWarmDurationMs)}ms
Generated: ${runtimeSnapshot.counts.generated}  Loaded: ${runtimeSnapshot.counts.renderLoaded}  Unloaded: ${runtimeSnapshot.counts.renderUnloaded}  Rebase: ${runtimeSnapshot.renderOrigin.rebaseCount}
Latest crossing: ${number(transition?.durationMs)}ms  generated Δ${transition?.generatedDelta ?? 0}  load Δ${transition?.renderLoadedDelta ?? 0}  unload Δ${transition?.renderUnloadedDelta ?? 0}
Generation ms latest/p50/p95/max: ${number(metrics.generation.latest)} / ${number(metrics.generation.p50)} / ${number(metrics.generation.p95)} / ${number(metrics.generation.max)}
Projection ms latest/p50/p95/max: ${number(metrics.projection.latest)} / ${number(metrics.projection.p50)} / ${number(metrics.projection.p95)} / ${number(metrics.projection.max)}
Load ms latest/p50/p95/max: ${number(metrics.load.latest)} / ${number(metrics.load.p50)} / ${number(metrics.load.p95)} / ${number(metrics.load.max)}
Unload ms latest/p50/p95/max: ${number(metrics.unload.latest)} / ${number(metrics.unload.p50)} / ${number(metrics.unload.p95)} / ${number(metrics.unload.max)}
Rebase ms latest/p50/p95/max: ${number(metrics.rebase.latest)} / ${number(metrics.rebase.p50)} / ${number(metrics.rebase.p95)} / ${number(metrics.rebase.max)}
Frame ms latest/p50/p95/max: ${number(metrics.frame.latest)} / ${number(metrics.frame.p50)} / ${number(metrics.frame.p95)} / ${number(metrics.frame.max)}
Render resources: draw ${renderInfo?.render?.calls ?? 'n/a'}  geometry ${renderInfo?.memory?.geometries ?? 'n/a'}  material ${renderAdapter.resourceSnapshot().sharedMaterialCount}  scene ${countSceneObjects(scene)}${measurementText}${diagnosticText}${escapeHtml(warningText)}<span id="error">${escapeHtml(errorText)}</span>`;
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
        resources: renderAdapter.resourceSnapshot(),
        measurementReport,
      });
    }

    function failRuntimeLoop(error) {
      running = false;
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
            () => synchronizeDistantPresentation(runtime.snapshot(), { includeUltraNatural: false }),
          ).then(() => {
            if (!running || ultraNaturalWarmStarted) return;
            ultraNaturalWarmStarted = true;
            void diagnostics.measureAsync(
              'distant-sync-ultra',
              () => synchronizeDistantPresentation(runtime.snapshot()),
            ).catch(error => { transitionError = error; });
          }).catch(error => { transitionError = error; });
        }
        const rawFrameMs = Math.max(0, frameNow - lastFrameAt);
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
        const frameRenderOrigin = runtime.snapshot().renderOrigin;
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
            simulationEnabled: isW8GameplaySimulationEnabled(measurement.mode, runPhase),
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
      if (animationFrameId !== null) cancelAnimationFrameFn(animationFrameId);
      if (saveTimer !== null) { clearTimeoutFn(saveTimer); saveTimer = null; }
      if (saveIdleCallback !== null) {
        globalObject.cancelIdleCallback?.(saveIdleCallback);
        saveIdleCallback = null;
      }
      removeWindowListener('resize', resize);
      removeWindowListener('pagehide', handlePageHide);
      experienceShell.dispose();
      if (runStarted) await saveWorld({ force: true });
      diagnostics.dispose();
      await audioDirector.dispose();
      await gameplay.shutdown();
      await runtime.shutdown();
      distantPresentation.dispose();
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
