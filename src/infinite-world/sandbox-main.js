import { ChunkRuntimeManager } from './chunk-runtime-manager.js';
import { runW1BChunkSizeBenchmark } from './chunk-size-benchmark.js';
import {
  UNITS_PER_METER,
  decomposeLogicalWorldPosition,
  logicalWorldToRenderLocal,
} from './chunk-coordinates.js';
import { ChunkRenderAdapter } from './render/chunk-render-adapter.js';
import { createSingleRuralChunkGenerator } from './single-rural-chunk-generator.js';
import { PersistentChunkIndex } from './persistent-chunk-index.js';

const THREE = globalThis.THREE;
const viewport = document.querySelector('#viewport');
const hud = document.querySelector('#hud');
if (!THREE) throw new Error('Three.js failed to load');
if (!viewport || !hud) throw new Error('sandbox DOM is incomplete');

const query = new URLSearchParams(globalThis.location.search);
const requestedSeed = query.get('seed') ?? 'KaniNingen Infinite Natural World';
const generator = await createSingleRuralChunkGenerator({ worldSeed: requestedSeed });
const chunkSizeBenchmark = runW1BChunkSizeBenchmark({ iterations: 25_000, rounds: 5 });
const selectedRenderChunkSize = chunkSizeBenchmark.decision.selectedRenderChunkSize;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x9bb6c5);
scene.fog = new THREE.Fog(0x9bb6c5, 9000, 26000);
const camera = new THREE.PerspectiveCamera(52, innerWidth / innerHeight, 8, 42000);
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
viewport.append(renderer.domElement);

scene.add(new THREE.HemisphereLight(0xd8edff, 0x34412e, 2.15));
const sun = new THREE.DirectionalLight(0xfff0cf, 2.2);
sun.position.set(-5000, 9000, 3000);
scene.add(sun);

const playerMarker = new THREE.Group();
playerMarker.name = 'w1a-player-marker';
const markerMaterial = new THREE.MeshLambertMaterial({ color: 0xc84b3f, flatShading: true });
const markerBody = new THREE.Mesh(new THREE.CylinderGeometry(125, 175, 90, 8), markerMaterial);
markerBody.position.y = 90;
playerMarker.add(markerBody);
const markerDirection = new THREE.Mesh(
  new THREE.ConeGeometry(75, 260, 5),
  new THREE.MeshLambertMaterial({ color: 0xf2c35d, flatShading: true }),
);
markerDirection.rotation.x = Math.PI / 2;
markerDirection.position.set(0, 95, -180);
playerMarker.add(markerDirection);
scene.add(playerMarker);

const renderAdapter = new ChunkRenderAdapter({ THREE, scene, renderChunkSize: selectedRenderChunkSize });
const chunkIndex = new PersistentChunkIndex({ capacity: 65_536 });
const runtime = new ChunkRuntimeManager({ generator, renderAdapter, cacheCapacity: 81, chunkIndex });
const logicalPlayer = { x: 8, z: 8 };
const initialOwner = decomposeLogicalWorldPosition(logicalPlayer.x, logicalPlayer.z);
await runtime.initialize(initialOwner.chunkX, initialOwner.chunkZ);

const keys = new Set();
let transitionTargetKey = null;
let transitionError = null;
let lastFrameAt = performance.now();
let lastHudAt = 0;
let running = true;

function onKey(event, pressed) {
  if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ShiftLeft', 'ShiftRight'].includes(event.code)) {
    event.preventDefault();
    if (pressed) keys.add(event.code);
    else keys.delete(event.code);
  }
}
const onKeyDown = event => onKey(event, true);
const onKeyUp = event => onKey(event, false);
addEventListener('keydown', onKeyDown);
addEventListener('keyup', onKeyUp);

function resize() {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
}
addEventListener('resize', resize);

function requestTransition(owner) {
  const state = runtime.snapshot();
  if (transitionTargetKey || (state.centerChunkX === owner.chunkX && state.centerChunkZ === owner.chunkZ)) return;
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

function number(value) {
  return Number(value ?? 0).toFixed(2);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function updateHud(owner) {
  const state = runtime.snapshot();
  const currentChunk = runtime.getChunkData(owner.chunkX, owner.chunkZ);
  const metrics = state.performance;
  const transition = state.latestTransition;
  const warningText = state.warnings.length ? `\n警告: ${state.warnings.join(' / ')}` : '';
  const errorText = transitionError ? `\nERROR: ${transitionError.message}` : '';
  hud.innerHTML = `<span id="badge">W4 / SINGLE RURAL SETTLEMENT</span>
World Seed: ${escapeHtml(generator.worldSeed)}
Logical Chunk: (${owner.chunkX}, ${owner.chunkZ})  Local: (${number(owner.logicalLocalX)}m, ${number(owner.logicalLocalZ)}m)
Logical World: (${number(logicalPlayer.x)}m, ${number(logicalPlayer.z)}m)
Natural Biome: ${escapeHtml(currentChunk?.biomeField?.primaryBiomeId ?? 'loading')}  Height range: ${number(currentChunk?.terrain?.heightRangeMeters?.minimum)}..${number(currentChunk?.terrain?.heightRangeMeters?.maximum)}m
Formal Vegetation: ${currentChunk?.vegetationCandidates?.length ?? 0}  Formal Rocks: ${currentChunk?.rockCandidates?.length ?? 0}  Persistent Index: ${state.chunkIndex?.size ?? 0}/${state.chunkIndex?.capacity ?? 0}
RURAL Settlement: ${escapeHtml(generator.settlement.settlementId)}  Roads: ${generator.settlement.roads.length}  Buildings: ${generator.settlement.buildings.length}/${generator.settlement.requestedBuildingCount}
Current Chunk Settlement features: ${currentChunk?.settlementFeatures?.length ?? 0}
Render Origin Chunk: (${state.renderOrigin.renderOriginChunkX}, ${state.renderOrigin.renderOriginChunkZ})
W1B Render Profile: ${selectedRenderChunkSize} (${chunkSizeBenchmark.decision.selectedUnitsPerMeter} units/m; 4096/2048 compared)
Rendered: ${state.renderedCount}/9  Prefetched Data: ${state.activeDataCount}/25  Cache: ${state.cacheSize}/${state.cacheCapacity}
Generated: ${state.counts.generated}  Loaded: ${state.counts.renderLoaded}  Unloaded: ${state.counts.renderUnloaded}  Rebase: ${state.renderOrigin.rebaseCount}
Latest crossing: ${number(transition?.durationMs)}ms  generated Δ${transition?.generatedDelta ?? 0}  load Δ${transition?.renderLoadedDelta ?? 0}  unload Δ${transition?.renderUnloadedDelta ?? 0}
Generation ms latest/p50/p95/max: ${number(metrics.generation.latest)} / ${number(metrics.generation.p50)} / ${number(metrics.generation.p95)} / ${number(metrics.generation.max)}
Projection ms latest/p50/p95/max: ${number(metrics.projection.latest)} / ${number(metrics.projection.p50)} / ${number(metrics.projection.p95)} / ${number(metrics.projection.max)}
Load ms latest/p50/p95/max: ${number(metrics.load.latest)} / ${number(metrics.load.p50)} / ${number(metrics.load.p95)} / ${number(metrics.load.max)}
Unload ms latest/p50/p95/max: ${number(metrics.unload.latest)} / ${number(metrics.unload.p50)} / ${number(metrics.unload.p95)} / ${number(metrics.unload.max)}
Rebase ms latest/p50/p95/max: ${number(metrics.rebase.latest)} / ${number(metrics.rebase.p50)} / ${number(metrics.rebase.p95)} / ${number(metrics.rebase.max)}
Frame ms latest/p50/p95/max: ${number(metrics.frame.latest)} / ${number(metrics.frame.p50)} / ${number(metrics.frame.p95)} / ${number(metrics.frame.max)}${escapeHtml(warningText)}<span id="error">${escapeHtml(errorText)}</span>`;
}

function frame(now) {
  if (!running) return;
  const rawFrameMs = Math.max(0, now - lastFrameAt);
  const deltaSeconds = Math.min(rawFrameMs / 1000, 0.05);
  lastFrameAt = now;
  runtime.recordFrame(rawFrameMs);
  const owner = updatePlayer(deltaSeconds);
  renderer.render(scene, camera);
  if (now - lastHudAt > 120) {
    updateHud(owner);
    lastHudAt = now;
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

async function shutdown() {
  if (!running) return;
  running = false;
  removeEventListener('resize', resize);
  removeEventListener('keydown', onKeyDown);
  removeEventListener('keyup', onKeyUp);
  await runtime.shutdown();
  markerBody.geometry.dispose();
  markerMaterial.dispose();
  markerDirection.geometry.dispose();
  markerDirection.material.dispose();
  renderer.dispose();
  renderer.domElement.remove();
}

globalThis.__w1aSandbox = Object.freeze({
  runtime,
  generator,
  renderAdapter,
  chunkSizeBenchmark,
  logicalPlayer,
  snapshot: () => ({ runtime: runtime.snapshot(), resources: renderAdapter.resourceSnapshot() }),
  shutdown,
  constants: Object.freeze({ unitsPerMeter: UNITS_PER_METER }),
});
globalThis.__infiniteWorldSandbox = globalThis.__w1aSandbox;
