import { ChunkRuntimeManager } from './chunk-runtime-manager.js';
import {
  W1B_SELECTED_RENDER_CHUNK_SIZE,
  describeRenderChunkCandidate,
} from './chunk-size-benchmark.js';
import {
  UNITS_PER_METER,
  decomposeLogicalWorldPosition,
  logicalWorldToRenderLocal,
} from './chunk-coordinates.js';
import { ChunkRenderAdapter } from './render/chunk-render-adapter.js';
import { createDistributedSettlementChunkGenerator } from './distributed-settlement-chunk-generator.js';
import { PersistentChunkIndex } from './persistent-chunk-index.js';

export const SANDBOX_BOOT_TIMEOUT_MS = 30_000;

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
    schemaVersion: 'w5-sandbox-boot-state-1',
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
  const badge = '<span id="badge">W5 / INFINITE SETTLEMENT DISTRIBUTION</span>';
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

export async function bootInfiniteWorldSandbox({
  globalObject = globalThis,
  THREE = globalObject.THREE,
  viewport = globalObject.document?.querySelector?.('#viewport'),
  hud = globalObject.document?.querySelector?.('#hud'),
  requestedSeed = new globalObject.URLSearchParams(globalObject.location?.search ?? '').get('seed')
    ?? 'KaniNingen Infinite Natural World',
  state = createSandboxBootState(),
  generatorFactory = createDistributedSettlementChunkGenerator,
  renderAdapterFactory = options => new ChunkRenderAdapter(options),
  runtimeFactory = options => new ChunkRuntimeManager(options),
  chunkIndexFactory = options => new PersistentChunkIndex(options),
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
  let renderer = null;
  let markerBody = null;
  let markerMaterial = null;
  let markerDirection = null;
  let scene = null;
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
    generator = await runStage('Legacy Core', () => generatorFactory({ worldSeed: requestedSeed }));
    const renderProfile = createRuntimeRenderProfile();
    const selectedRenderChunkSize = renderProfile.selectedRenderChunkSize;

    const rendererContext = await runStage('Renderer', () => {
      const nextScene = new THREE.Scene();
      nextScene.background = new THREE.Color(0x9bb6c5);
      nextScene.fog = new THREE.Fog(0x9bb6c5, 9000, 26000);
      const nextCamera = new THREE.PerspectiveCamera(
        52,
        globalObject.innerWidth / globalObject.innerHeight,
        8,
        42000,
      );
      const nextRenderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
      nextRenderer.setPixelRatio(Math.min(globalObject.devicePixelRatio ?? 1, 2));
      nextRenderer.setSize(globalObject.innerWidth, globalObject.innerHeight);
      nextRenderer.outputColorSpace = THREE.SRGBColorSpace;
      appendElement(viewport, nextRenderer.domElement);

      nextScene.add(new THREE.HemisphereLight(0xd8edff, 0x34412e, 2.15));
      const sun = new THREE.DirectionalLight(0xfff0cf, 2.2);
      sun.position.set(-5000, 9000, 3000);
      nextScene.add(sun);

      const playerMarker = new THREE.Group();
      playerMarker.name = 'w1a-player-marker';
      markerMaterial = new THREE.MeshLambertMaterial({ color: 0xc84b3f, flatShading: true });
      markerBody = new THREE.Mesh(new THREE.CylinderGeometry(125, 175, 90, 8), markerMaterial);
      markerBody.position.y = 90;
      playerMarker.add(markerBody);
      markerDirection = new THREE.Mesh(
        new THREE.ConeGeometry(75, 260, 5),
        new THREE.MeshLambertMaterial({ color: 0xf2c35d, flatShading: true }),
      );
      markerDirection.rotation.x = Math.PI / 2;
      markerDirection.position.set(0, 95, -180);
      playerMarker.add(markerDirection);
      nextScene.add(playerMarker);
      return { nextScene, nextCamera, nextRenderer, playerMarker };
    });
    scene = rendererContext.nextScene;
    const camera = rendererContext.nextCamera;
    renderer = rendererContext.nextRenderer;
    const playerMarker = rendererContext.playerMarker;

    const runtimeContext = await runStage('Chunk Runtime', () => {
      renderAdapter = renderAdapterFactory({ THREE, scene, renderChunkSize: selectedRenderChunkSize });
      const chunkIndex = chunkIndexFactory({ capacity: 65_536 });
      const logicalPlayer = { x: generator.reviewSpawn.x, z: generator.reviewSpawn.z };
      const initialOwner = decomposeLogicalWorldPosition(logicalPlayer.x, logicalPlayer.z);
      let chunkGenerationMs = 0;
      let renderProjectionMs = 0;
      const measuredGenerator = {
        async generateChunk(chunkX, chunkZ) {
          const startedAt = clock();
          try { return await generator.generateChunk(chunkX, chunkZ); }
          finally { chunkGenerationMs += Math.max(0, clock() - startedAt); }
        },
      };
      const measuredRenderAdapter = {
        rebase: origin => renderAdapter.rebase(origin),
        async projectChunk(chunkData, origin) {
          const startedAt = clock();
          try { return await renderAdapter.projectChunk(chunkData, origin); }
          finally { renderProjectionMs += Math.max(0, clock() - startedAt); }
        },
        loadProjected: projected => renderAdapter.loadProjected(projected),
        unloadChunk: key => renderAdapter.unloadChunk(key),
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

    const keys = new Set();
    let transitionTargetKey = null;
    let transitionError = null;
    let lastFrameAt = clock();
    let lastHudAt = 0;
    running = true;

    function onKey(event, pressed) {
      if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ShiftLeft', 'ShiftRight'].includes(event.code)) {
        event.preventDefault();
        if (pressed) keys.add(event.code);
        else keys.delete(event.code);
      }
    }
    const onKeyDown = event => onKey(event, true);
    const onKeyUp = event => onKey(event, false);
    const addWindowListener = (type, listener) => globalObject.addEventListener?.(type, listener);
    const removeWindowListener = (type, listener) => globalObject.removeEventListener?.(type, listener);
    addWindowListener('keydown', onKeyDown);
    addWindowListener('keyup', onKeyUp);

    function resize() {
      camera.aspect = globalObject.innerWidth / globalObject.innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(globalObject.innerWidth, globalObject.innerHeight);
    }
    addWindowListener('resize', resize);

    function requestTransition(owner) {
      const runtimeSnapshot = runtime.snapshot();
      if (transitionTargetKey
        || (runtimeSnapshot.centerChunkX === owner.chunkX && runtimeSnapshot.centerChunkZ === owner.chunkZ)) return;
      transitionTargetKey = owner.key;
      runtime.transitionToChunk(owner.chunkX, owner.chunkZ)
        .catch(error => { transitionError = error; })
        .finally(() => { transitionTargetKey = null; });
    }

    function updatePlayer(deltaSeconds) {
      let dx = Number(keys.has('KeyD')) - Number(keys.has('KeyA'));
      let dz = Number(keys.has('KeyS')) - Number(keys.has('KeyW'));
      if (dx || dz) {
        const length = Math.hypot(dx, dz);
        dx /= length;
        dz /= length;
        const sprinting = keys.has('ShiftLeft') || keys.has('ShiftRight');
        const speedMetersPerSecond = sprinting ? 32 : 5;
        logicalPlayer.x += dx * speedMetersPerSecond * deltaSeconds;
        logicalPlayer.z += dz * speedMetersPerSecond * deltaSeconds;
      }
      const owner = decomposeLogicalWorldPosition(logicalPlayer.x, logicalPlayer.z);
      requestTransition(owner);
      const origin = runtime.snapshot().renderOrigin;
      const renderLocal = logicalWorldToRenderLocal(
        logicalPlayer.x,
        logicalPlayer.z,
        origin.renderOriginChunkX,
        origin.renderOriginChunkZ,
      );
      playerMarker.position.set(renderLocal.x, 0, renderLocal.z);
      const cameraOffset = { x: 5200, y: 6500, z: 6100 };
      camera.position.set(
        renderLocal.x + cameraOffset.x,
        cameraOffset.y,
        renderLocal.z + cameraOffset.z,
      );
      camera.lookAt(renderLocal.x, 0, renderLocal.z);
      return owner;
    }

    function updateHud(owner) {
      const runtimeSnapshot = runtime.snapshot();
      const currentChunk = runtime.getChunkData(owner.chunkX, owner.chunkZ);
      const metrics = runtimeSnapshot.performance;
      const transition = runtimeSnapshot.latestTransition;
      const warningText = runtimeSnapshot.warnings.length ? `\n警告: ${runtimeSnapshot.warnings.join(' / ')}` : '';
      const errorText = transitionError ? `\nERROR: ${transitionError.message}` : '';
      const settlementReference = currentChunk?.settlementReferences?.[0];
      hud.innerHTML = `<span id="badge">W5 / INFINITE SETTLEMENT DISTRIBUTION</span>
World Seed: ${escapeHtml(generator.worldSeed)}
Logical Chunk: (${owner.chunkX}, ${owner.chunkZ})  Local: (${number(owner.logicalLocalX)}m, ${number(owner.logicalLocalZ)}m)
Logical World: (${number(logicalPlayer.x)}m, ${number(logicalPlayer.z)}m)
Natural Biome: ${escapeHtml(currentChunk?.biomeField?.primaryBiomeId ?? 'loading')}  Height range: ${number(currentChunk?.terrain?.heightRangeMeters?.minimum)}..${number(currentChunk?.terrain?.heightRangeMeters?.maximum)}m
Formal Vegetation: ${currentChunk?.vegetationCandidates?.length ?? 0}  Formal Rocks: ${currentChunk?.rockCandidates?.length ?? 0}  Persistent Index: ${runtimeSnapshot.chunkIndex?.size ?? 0}/${runtimeSnapshot.chunkIndex?.capacity ?? 0}
Settlement: ${escapeHtml(settlementReference?.settlementType ?? 'NATURAL')} / ${escapeHtml(settlementReference?.townType ?? 'none')}  Stable ID: ${escapeHtml(settlementReference?.settlementId ?? 'none')}
Current Chunk Settlement features: ${currentChunk?.settlementFeatures?.length ?? 0}  Buildings: ${settlementReference?.buildingCount ?? 0}/${settlementReference?.requestedBuildingCount ?? 0}
Distribution: Seed + 768m Macro Region + minimum distance + urbanization + terrain suitability (fixed total: none)
Render Origin Chunk: (${runtimeSnapshot.renderOrigin.renderOriginChunkX}, ${runtimeSnapshot.renderOrigin.renderOriginChunkZ})
W1B Render Profile: ${selectedRenderChunkSize} (${renderProfile.selectedUnitsPerMeter} units/m; startup benchmark: isolated)
Rendered: ${runtimeSnapshot.renderedCount}/9  Prefetched Data: ${runtimeSnapshot.activeDataCount}/25  Cache: ${runtimeSnapshot.cacheSize}/${runtimeSnapshot.cacheCapacity}
Generated: ${runtimeSnapshot.counts.generated}  Loaded: ${runtimeSnapshot.counts.renderLoaded}  Unloaded: ${runtimeSnapshot.counts.renderUnloaded}  Rebase: ${runtimeSnapshot.renderOrigin.rebaseCount}
Latest crossing: ${number(transition?.durationMs)}ms  generated Δ${transition?.generatedDelta ?? 0}  load Δ${transition?.renderLoadedDelta ?? 0}  unload Δ${transition?.renderUnloadedDelta ?? 0}
Generation ms latest/p50/p95/max: ${number(metrics.generation.latest)} / ${number(metrics.generation.p50)} / ${number(metrics.generation.p95)} / ${number(metrics.generation.max)}
Projection ms latest/p50/p95/max: ${number(metrics.projection.latest)} / ${number(metrics.projection.p50)} / ${number(metrics.projection.p95)} / ${number(metrics.projection.max)}
Load ms latest/p50/p95/max: ${number(metrics.load.latest)} / ${number(metrics.load.p50)} / ${number(metrics.load.p95)} / ${number(metrics.load.max)}
Unload ms latest/p50/p95/max: ${number(metrics.unload.latest)} / ${number(metrics.unload.p50)} / ${number(metrics.unload.p95)} / ${number(metrics.unload.max)}
Rebase ms latest/p50/p95/max: ${number(metrics.rebase.latest)} / ${number(metrics.rebase.p50)} / ${number(metrics.rebase.p95)} / ${number(metrics.rebase.max)}
Frame ms latest/p50/p95/max: ${number(metrics.frame.latest)} / ${number(metrics.frame.p50)} / ${number(metrics.frame.p95)} / ${number(metrics.frame.max)}${escapeHtml(warningText)}<span id="error">${escapeHtml(errorText)}</span>`;
    }

    function failRuntimeLoop(error) {
      running = false;
      state.status = 'failed';
      state.stage = 'Animation Loop';
      state.bootError = { name: error?.name ?? 'Error', message: error?.message ?? String(error), stage: state.stage };
      renderSandboxBootStatus(hud, state);
    }

    function frame(now) {
      if (!running) return;
      try {
        const frameNow = Number.isFinite(now) ? now : clock();
        const rawFrameMs = Math.max(0, frameNow - lastFrameAt);
        const deltaSeconds = Math.min(rawFrameMs / 1000, 0.05);
        lastFrameAt = frameNow;
        runtime.recordFrame(rawFrameMs);
        const owner = updatePlayer(deltaSeconds);
        renderer.render(scene, camera);
        if (frameNow - lastHudAt > 120) {
          updateHud(owner);
          lastHudAt = frameNow;
        }
        animationFrameId = requestAnimationFrameFn(frame);
      } catch (error) {
        failRuntimeLoop(error);
      }
    }

    await runStage('Renderer', () => {
      const owner = updatePlayer(0);
      renderer.render(scene, camera);
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
      removeWindowListener('resize', resize);
      removeWindowListener('keydown', onKeyDown);
      removeWindowListener('keyup', onKeyUp);
      await runtime.shutdown();
      markerBody.geometry.dispose();
      markerMaterial.dispose();
      markerDirection.geometry.dispose();
      markerDirection.material.dispose();
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
      snapshot: () => ({
        boot: snapshotSandboxBootState(state),
        runtime: runtime.snapshot(),
        resources: renderAdapter.resourceSnapshot(),
        generator: generator.snapshot(),
        sceneObjectCount: countSceneObjects(scene),
      }),
      shutdown,
      constants: Object.freeze({ unitsPerMeter: UNITS_PER_METER }),
    });
  } catch (error) {
    recordSandboxBootFailure({ state, hud, error, clock });
    try {
      if (runtime && state.stage !== 'Terrain') await runtime.shutdown();
      else if (renderAdapter && !runtime) await renderAdapter.shutdown();
      renderer?.dispose?.();
      renderer?.domElement?.remove?.();
    } catch {
      // The original boot error remains authoritative.
    }
    throw error;
  }
}
