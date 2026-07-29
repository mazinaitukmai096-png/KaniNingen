import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  createExperienceCameraState,
  createInfiniteExperienceShell,
} from '../src/infinite-world/experience-shell.js';
import {
  W7_NUCLEAR_CONTRACT,
  getW6ScaleProfile,
} from '../src/infinite-world/gameplay-contract.js';
import { getScalePlayerVerticalMetrics } from '../src/infinite-world/player-vertical-movement.js';

const repoRoot = resolve(import.meta.dirname, '..');

class FakeEventTarget {
  constructor() { this.listeners = new Map(); }
  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }
  removeEventListener(type, listener) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter(item => item !== listener));
  }
  dispatch(type, event = {}) {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener({
      preventDefault() {}, target: this, ...event,
    });
  }
  listenerCount(type) { return (this.listeners.get(type) ?? []).length; }
}

function createElement() {
  const attributes = new Map();
  const classes = new Set();
  return Object.assign(new FakeEventTarget(), {
    style: {}, textContent: '', innerHTML: '', value: '', checked: false, dataset: {},
    classList: {
      toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); },
      contains(name) { return classes.has(name); },
    },
    setAttribute(name, value) { attributes.set(name, String(value)); },
    getAttribute(name) { return attributes.get(name) ?? null; },
  });
}

function createFixture({
  exposeDeveloperTools = false,
  developerToolsEnabled = false,
  runConfiguration = true,
  useCombatCommands = false,
  treeLodDiagnosticsAvailable = false,
  resolvePlayerHorizontalMovement = undefined,
  nuclearReleaseResult = undefined,
} = {}) {
  const ids = [
    'start-screen', 'start-button', 'continue-button', 'lobby-settings-btn', 'ui', 'crosshair', 'compass',
    'compass-arrow', 'fps-counter', 'score', 'hp-number', 'hp-bar-fill',
    'atomic-status', 'atomic-cd-label', 'boss-ui', 'boss-hp-fill', 'boss-hp-damage', 'boss-title',
    'charge-ui', 'charge-bar-fill', 'charge-label', 'news-ticker', 'settings-modal',
    'settings-close-btn', 'set-home-btn', 'set-reset-btn', 'resume-overlay', 'debug-modal',
    'debug-close-btn', 'debug-summary', 'debug-runtime-details', 'gameplay-diagnostics-hud',
    'debug-gameplay-diagnostics-off-btn', 'debug-gameplay-diagnostics-on-btn',
    'debug-tree-lod-overlay-off-btn', 'debug-tree-lod-overlay-on-btn', 'set-tree-lod-overlay',
    'debug-spawn-boss-btn', 'set-mouse', 'val-mouse', 'set-vol', 'val-vol',
    'set-quality', 'set-render-distance', 'set-fps-counter', 'set-fps-cap', 'set-shake', 'val-shake', 'final-score',
    'set-antialias', 'antialias-note',
    'game-over', 'restart-button',
    'nuclear-flash', 'save-warning',
  ];
  if (exposeDeveloperTools) ids.push('set-developer-tools', 'developer-tools-section');
  const elements = new Map(ids.map(id => [id, createElement()]));
  elements.get('set-quality').value = 'high';
  elements.get('set-render-distance').value = 'current';
  const bodyClasses = new Set();
  const documentObject = new FakeEventTarget();
  Object.assign(documentObject, {
    body: { classList: { toggle(name, enabled) {
      if (enabled) bodyClasses.add(name); else bodyClasses.delete(name);
    } } },
    pointerLockElement: null,
    getElementById: id => elements.get(id) ?? null,
    querySelectorAll: () => [],
    exitPointerLock() { this.pointerLockElement = null; this.dispatch('pointerlockchange'); },
  });
  const globalObject = new FakeEventTarget();
  let now = 0;
  globalObject.performance = { now: () => now };
  globalObject.setTimeout = callback => { callback(); return 1; };
  const canvas = createElement();
  canvas.requestPointerLock = () => {
    documentObject.pointerLockElement = canvas;
    documentObject.dispatch('pointerlockchange');
  };
  const camera = {
    near: 0, position: { set(x, y, z) { Object.assign(this, { x, y, z }); } },
    updateProjectionMatrix() {}, lookAt(x, y, z) { this.lookTarget = { x, y, z }; },
  };
  const playerMarker = { position: { y: 0 } };
  const worldState = {
    revision: 0,
    activeScaleStageId: 'MAX',
    developerTools: developerToolsEnabled,
    experience: {
      hudHidden: false,
      settings: {
        mouseSensitivity: 1, volume: 0.5, quality: 'high', renderDistance: 'current', showFps: false,
        fpsCap: 0, cameraShake: 1, antialias: true,
      },
    },
    setScaleStage(stageId) { this.activeScaleStageId = stageId; },
    setDeveloperTools(enabled) { this.developerTools = enabled; },
    updateExperience(patch) {
      this.revision += 1;
      this.experience = {
        ...this.experience,
        ...patch,
        settings: { ...this.experience.settings, ...(patch.settings ?? {}) },
      };
    },
  };
  const calls = {
    attacks: [], saves: 0, loads: 0, returnTitles: 0, homeResets: 0, restarts: 0,
    nuclear: [], landings: [], bossSpawns: 0, starts: [], combatCommands: [], treeLodOverlays: [],
  };
  const shell = createInfiniteExperienceShell({
    globalObject, documentObject, canvas, camera, playerMarker, worldState,
    initialScaleProfile: getW6ScaleProfile('MAX'),
    getTerrainHeightMeters: (x, z) => 1 + x * 0.01 + z * 0.02,
    ...(resolvePlayerHorizontalMovement ? { resolvePlayerHorizontalMovement } : {}),
    onAttack: mode => calls.attacks.push(mode),
    onSave: () => { calls.saves += 1; },
    onLoad: () => { calls.loads += 1; },
    onReturnTitle: () => { calls.returnTitles += 1; },
    onResetHome: () => { calls.homeResets += 1; },
    onRestart: () => { calls.restarts += 1; },
    onStartRun: mode => { calls.starts.push(mode); return runConfiguration; },
    ...(useCombatCommands ? {
      onCombatCommand: command => {
        calls.combatCommands.push(command);
        return { accepted: true };
      },
    } : {}),
    onNuclearRelease: input => { calls.nuclear.push(input); return nuclearReleaseResult; },
    onPlayerLanding: input => { calls.landings.push(input); },
    onSpawnManualBoss: () => { calls.bossSpawns += 1; },
    treeLodDiagnosticsAvailable,
    onTreeLodOverlayChanged: enabled => { calls.treeLodOverlays.push(enabled); },
  });
  return {
    shell, globalObject, documentObject, canvas, camera, playerMarker, worldState,
    calls, elements, bodyClasses, setNow(value) { now = value; },
  };
}

function finishIntro(fixture, player = { x: 0, z: 0, facingY: 0 }, profile = getW6ScaleProfile('MAX')) {
  fixture.shell.updatePlayer({ deltaSeconds: 6, player, scaleProfile: profile });
  assert.equal(fixture.shell.getRunPhase(), 'playing');
  return player;
}

function renderAtomicReady(fixture) {
  fixture.shell.renderHud({
    fps: 60,
    gameplaySnapshot: {
      state: {
        player: { hp: 100, maxHp: 100, score: 0 }, activeScaleStageId: 'MAX',
        nuclearCooldownMs: 0, destroyedFeatureCount: 0, destroyedEntityCount: 0,
      },
      activeTankCount: 0, activeSimulationChunkCount: 9,
      simulatedEntityCount: 0, simulatedStaticTargetCount: 0,
    },
    runtimeSnapshot: {
      centerChunkX: 0, centerChunkZ: 0, renderedCount: 9, activeDataCount: 25,
      performance: { frame: { p50: 6, p95: 10, max: 15 } },
    },
    saveStatus: 'saved', renderInfo: {}, resources: { sharedMaterialCount: 1 },
  });
}

test('W7 camera state is sourced from the protected scale profile', () => {
  for (const stageId of ['TINY', 'MID', 'MAX']) {
    const profile = getW6ScaleProfile(stageId);
    const camera = createExperienceCameraState(profile);
    assert.equal(camera.yaw, 0);
    assert.equal(camera.pitch, profile.stage.cameraPitch);
    assert.equal(camera.distanceMeters, profile.cameraDistanceMeters);
  }
});

test('New Game and Continue are explicit start modes and Continue remains unavailable without a valid save', () => {
  const newFixture = createFixture();
  assert.equal(newFixture.elements.get('continue-button').disabled, true);
  newFixture.elements.get('continue-button').dispatch('click');
  assert.deepEqual(newFixture.calls.starts, []);
  newFixture.elements.get('start-button').dispatch('click');
  assert.deepEqual(newFixture.calls.starts, ['new']);
  assert.equal(newFixture.shell.snapshot().runStartMode, 'new');
  assert.equal(newFixture.shell.getRunPhase(), 'intro');
  newFixture.shell.dispose();

  const continueFixture = createFixture();
  continueFixture.shell.setContinueAvailable(true);
  assert.equal(continueFixture.elements.get('continue-button').disabled, false);
  continueFixture.elements.get('continue-button').dispatch('click');
  assert.deepEqual(continueFixture.calls.starts, ['continue']);
  assert.equal(continueFixture.shell.snapshot().runStartMode, 'continue');
  assert.equal(continueFixture.shell.getRunPhase(), 'intro');
  continueFixture.shell.dispose();
});

test('New Game enters intro only after start preparation and clears the previous Camera yaw', async () => {
  let releasePreparation;
  const preparation = new Promise(resolve => { releasePreparation = resolve; });
  const fixture = createFixture({
    runConfiguration: preparation.then(() => ({ cameraYaw: 1.25 })),
  });
  fixture.elements.get('start-button').dispatch('click');
  assert.equal(fixture.shell.getRunPhase(), 'menu');
  assert.equal(fixture.elements.get('start-button').disabled, true);
  releasePreparation();
  await preparation;
  await Promise.resolve();
  assert.equal(fixture.shell.getRunPhase(), 'intro');
  assert.equal(fixture.shell.snapshot().camera.yaw, 1.25);
  const player = { x: 0, z: 0, facingY: 0 };
  fixture.shell.updatePlayer({
    deltaSeconds: 1,
    player,
    scaleProfile: getW6ScaleProfile('MAX'),
  });
  assert.equal(fixture.shell.snapshot().gameplayTimeMs, 1_000);
  fixture.shell.dispose();
});

test('W8 finite camera projection keeps target height out of camera Y and resets every Scale', () => {
  const fixture = createFixture();
  fixture.elements.get('start-button').dispatch('click');
  const player = { x: 0, z: 0, facingY: 0 };
  finishIntro(fixture, player);
  const unitsPerMeter = 256;
  const renderLocal = { x: 400, z: -250 };

  for (const [stageIndex, stageId] of ['MAX', 'TINY', 'MID', 'MAX'].entries()) {
    const profile = getW6ScaleProfile(stageId);
    fixture.shell.updatePlayer({ deltaSeconds: 0, player, scaleProfile: profile });
    fixture.shell.updateCamera({ renderLocal, scaleProfile: profile, unitsPerMeter });
    const state = fixture.shell.snapshot();
    const rootY = state.playerVertical.rootY;
    const expectedPitch = stageIndex === 0 ? 0.45 : profile.stage.cameraPitch;
    const horizontal = Math.cos(expectedPitch)
      * profile.cameraDistanceMeters * unitsPerMeter;
    const vertical = (Math.sin(expectedPitch) * profile.cameraDistanceMeters
      + profile.cameraHeightMeters) * unitsPerMeter;
    assert.equal(state.camera.pitch, expectedPitch, stageId);
    assert.equal(state.camera.distanceMeters, profile.cameraDistanceMeters, stageId);
    assert.ok(Math.abs(fixture.camera.position.x - renderLocal.x) < 1e-9, stageId);
    assert.ok(Math.abs(fixture.camera.position.y - (rootY * unitsPerMeter + vertical)) < 1e-9, stageId);
    assert.ok(Math.abs(fixture.camera.position.z - (renderLocal.z + horizontal)) < 1e-9, stageId);
    assert.equal(
      fixture.camera.near,
      profile.stage.cameraNear / 40 * unitsPerMeter,
      stageId,
    );
    assert.deepEqual(fixture.camera.lookTarget, {
      x: renderLocal.x,
      y: (rootY + profile.cameraTargetHeightMeters) * unitsPerMeter,
      z: renderLocal.z,
    });
  }

  const maxProfile = getW6ScaleProfile('MAX');
  fixture.globalObject.dispatch('wheel', { deltaY: 1_000_000 });
  assert.equal(fixture.shell.snapshot().camera.distanceMeters, maxProfile.stage.cameraMaxDistance / 40);
  fixture.globalObject.dispatch('wheel', { deltaY: -1_000_000 });
  assert.equal(fixture.shell.snapshot().camera.distanceMeters, maxProfile.stage.cameraMinDistance / 40);
  fixture.shell.updatePlayer({ deltaSeconds: 0, player, scaleProfile: getW6ScaleProfile('TINY') });
  assert.equal(
    fixture.shell.snapshot().camera.distanceMeters,
    getW6ScaleProfile('TINY').cameraDistanceMeters,
  );
  fixture.shell.dispose();
});

test('finite camera shake is XY-only and decays equally at 30, 60, and 120fps', () => {
  const run = (fps, frames) => {
    const fixture = createFixture();
    fixture.globalObject.Math = { random: () => 1 };
    fixture.elements.get('start-button').dispatch('click');
    const player = finishIntro(fixture);
    const profile = getW6ScaleProfile('MAX');
    fixture.shell.applyCameraShake(450);
    let baselineZ;
    let sawPositiveX = false;
    for (let frame = 0; frame < frames; frame += 1) {
      fixture.shell.updateCamera({
        renderLocal: { x: 0, z: 0 }, scaleProfile: profile, unitsPerMeter: 40,
        deltaSeconds: 1 / fps,
      });
      const cameraState = fixture.shell.snapshot().camera;
      baselineZ = Math.cos(cameraState.yaw)
        * cameraState.distanceMeters * Math.cos(cameraState.pitch) * 40;
      assert.ok(Math.abs(fixture.camera.position.z - baselineZ) < 1e-9);
      sawPositiveX ||= fixture.camera.position.x > 0;
    }
    const result = fixture.shell.snapshot().camera.shake;
    assert.equal(sawPositiveX, true);
    fixture.shell.dispose();
    return result;
  };
  const at30 = run(30, 30);
  const at60 = run(60, 60);
  const at120 = run(120, 120);
  assert.ok(Math.abs(at30 - at60) < 1e-12);
  assert.ok(Math.abs(at60 - at120) < 1e-12);
});

test('W7 experience shell restores movement, jump, camera, scale, attacks, save and load controls', () => {
  const fixture = createFixture();
  fixture.elements.get('start-button').dispatch('click');
  assert.equal(fixture.shell.isPaused(), false);
  assert.equal(fixture.documentObject.pointerLockElement, fixture.canvas);

  const player = { x: 0, z: 0, facingY: 0 };
  const profile = getW6ScaleProfile('MAX');
  finishIntro(fixture, player, profile);
  fixture.globalObject.dispatch('keydown', { code: 'KeyD' });
  fixture.shell.updatePlayer({ deltaSeconds: 1, player, scaleProfile: profile });
  fixture.globalObject.dispatch('keyup', { code: 'KeyD' });
  assert.equal(player.x, profile.movementMetersPerSecond);
  assert.equal(player.z, 0);

  fixture.globalObject.dispatch('keydown', { code: 'Space' });
  fixture.shell.updatePlayer({ deltaSeconds: 1 / 60, player, scaleProfile: profile });
  const airborne = fixture.shell.snapshot().playerVertical;
  assert.equal(airborne.grounded, false);
  assert.ok(airborne.rootY > airborne.groundRootY);
  fixture.globalObject.dispatch('keydown', { code: 'KeyQ' });
  fixture.globalObject.dispatch('keydown', { code: 'KeyF' });
  fixture.globalObject.dispatch('keydown', { code: 'Tab' });
  fixture.globalObject.dispatch('keydown', { code: 'Digit1' });
  fixture.globalObject.dispatch('keydown', { code: 'KeyP' });
  fixture.globalObject.dispatch('keydown', { code: 'KeyL' });
  assert.deepEqual(fixture.calls.attacks, ['single', 'double']);
  assert.equal(fixture.worldState.activeScaleStageId, 'TINY');
  assert.equal(fixture.calls.saves, 1);
  assert.equal(fixture.calls.loads, 1);
  fixture.globalObject.dispatch('keydown', { code: 'Tab' });

  fixture.globalObject.dispatch('mousemove', { movementX: 10, movementY: 5 });
  fixture.globalObject.dispatch('wheel', { deltaY: 20 });
  fixture.shell.updateCamera({ renderLocal: { x: 4, z: 7 }, scaleProfile: profile, unitsPerMeter: 40 });
  assert.notEqual(fixture.shell.snapshot().camera.yaw, 0);
  assert.ok(Number.isFinite(fixture.camera.position.x));
  assert.ok(Number.isFinite(fixture.camera.position.y));
  assert.ok(Number.isFinite(fixture.camera.position.z));
  fixture.shell.dispose();
});

test('document Pointer Lock exit opens settings immediately and relock click cannot attack', () => {
  const fixture = createFixture();
  fixture.elements.get('start-button').dispatch('click');
  finishIntro(fixture);
  fixture.documentObject.exitPointerLock();
  assert.equal(fixture.shell.isPaused(), true);
  assert.equal(fixture.elements.get('settings-modal').style.display, 'flex');
  assert.equal(fixture.shell.snapshot().camera.shake, 0);

  fixture.elements.get('settings-close-btn').dispatch('click');
  assert.equal(fixture.shell.isPaused(), false);
  fixture.documentObject.pointerLockElement = null;
  fixture.globalObject.dispatch('mousedown', { button: 0 });
  fixture.globalObject.dispatch('mouseup', { button: 0 });
  assert.deepEqual(fixture.calls.attacks, []);
  fixture.shell.dispose();
});

test('Boss Acid movement multiplier scales normal and sprint movement without changing inputs', () => {
  const fixture = createFixture();
  fixture.elements.get('start-button').dispatch('click');
  const player = { x: 0, z: 0, facingY: 0 };
  const profile = getW6ScaleProfile('MAX');
  finishIntro(fixture, player, profile);
  fixture.globalObject.dispatch('keydown', { code: 'KeyD' });
  fixture.shell.updatePlayer({
    deltaSeconds: 1, player, scaleProfile: profile, movementMultiplier: 0.75,
  });
  assert.equal(player.x, profile.movementMetersPerSecond * 0.75);
  fixture.globalObject.dispatch('keydown', { code: 'ShiftLeft' });
  fixture.shell.updatePlayer({
    deltaSeconds: 1, player, scaleProfile: profile, movementMultiplier: 0.75,
  });
  assert.equal(player.x, profile.movementMetersPerSecond * 0.75 * (1 + 1.45));
  fixture.globalObject.dispatch('keyup', { code: 'KeyD' });
  fixture.globalObject.dispatch('keyup', { code: 'ShiftLeft' });
  fixture.shell.dispose();
});

test('finite Scale movement ratios remain 0.5, 0.75, and 1 while Shift sprint remains 1.45', () => {
  for (const [stageId, ratio] of [['TINY', 0.5], ['MID', 0.75], ['MAX', 1]]) {
    const fixture = createFixture();
    fixture.elements.get('start-button').dispatch('click');
    const profile = getW6ScaleProfile(stageId);
    const player = finishIntro(fixture, { x: 0, z: 0, facingY: 0 }, profile);
    fixture.globalObject.dispatch('keydown', { code: 'KeyD' });
    fixture.shell.updatePlayer({ deltaSeconds: 1, player, scaleProfile: profile });
    assert.equal(player.x, getW6ScaleProfile('MAX').movementMetersPerSecond * ratio);
    player.x = 0;
    fixture.globalObject.dispatch('keydown', { code: 'ShiftLeft' });
    fixture.shell.updatePlayer({ deltaSeconds: 1, player, scaleProfile: profile });
    assert.equal(player.x, profile.movementMetersPerSecond * 1.45);
    fixture.shell.dispose();
  }
});

test('Tab and Scale remain available while advanced Developer commands stay isolated when OFF', () => {
  const fixture = createFixture({ exposeDeveloperTools: true });
  fixture.elements.get('start-button').dispatch('click');
  fixture.globalObject.dispatch('keydown', { code: 'Digit1' });
  fixture.globalObject.dispatch('keydown', { code: 'KeyQ' });
  fixture.globalObject.dispatch('keydown', { code: 'KeyF' });
  fixture.globalObject.dispatch('keydown', { code: 'KeyP' });
  fixture.globalObject.dispatch('keydown', { code: 'KeyL' });
  fixture.elements.get('debug-spawn-boss-btn').dispatch('click');
  assert.equal(fixture.worldState.activeScaleStageId, 'MAX');
  assert.deepEqual(fixture.calls.attacks, []);
  assert.equal(fixture.calls.saves, 0);
  assert.equal(fixture.calls.loads, 0);
  assert.equal(fixture.calls.bossSpawns, 0);

  fixture.globalObject.dispatch('keydown', { code: 'Tab' });
  assert.equal(fixture.shell.snapshot().debugOpen, true);
  fixture.globalObject.dispatch('keydown', { code: 'Digit1' });
  assert.equal(fixture.worldState.activeScaleStageId, 'TINY');
  fixture.globalObject.dispatch('keydown', { code: 'Tab' });
  assert.equal(fixture.shell.snapshot().debugOpen, false);
  assert.equal(fixture.shell.isPaused(), false);
  fixture.shell.dispose();
});

test('Tree LOD overlay is a diagnostics-only transient toggle independent from the Developer Tools modal', () => {
  const fixture = createFixture({ treeLodDiagnosticsAvailable: true });
  const offToggle = fixture.elements.get('debug-tree-lod-overlay-off-btn');
  const onToggle = fixture.elements.get('debug-tree-lod-overlay-on-btn');
  assert.equal(fixture.shell.snapshot().treeLodOverlayEnabled, false);
  assert.equal(offToggle.textContent, 'OFF');
  assert.equal(onToggle.textContent, 'ON');
  assert.equal(offToggle.disabled, false);
  assert.equal(onToggle.disabled, false);
  assert.equal(offToggle.getAttribute('aria-pressed'), 'true');
  assert.equal(onToggle.getAttribute('aria-pressed'), 'false');
  assert.equal(offToggle.classList.contains('debug-on'), true);

  fixture.elements.get('start-button').dispatch('click');
  fixture.shell.openDebug();
  onToggle.dispatch('click');
  assert.equal(fixture.shell.snapshot().treeLodOverlayEnabled, true);
  assert.deepEqual(fixture.calls.treeLodOverlays, [true]);
  assert.equal(onToggle.getAttribute('aria-pressed'), 'true');
  assert.equal(offToggle.getAttribute('aria-pressed'), 'false');
  assert.equal(onToggle.classList.contains('debug-on'), true);

  fixture.elements.get('debug-close-btn').dispatch('click');
  assert.equal(fixture.shell.snapshot().debugOpen, false);
  assert.equal(fixture.shell.snapshot().treeLodOverlayEnabled, true);
  assert.deepEqual(fixture.calls.treeLodOverlays, [true]);

  fixture.shell.openDebug();
  offToggle.dispatch('click');
  assert.equal(fixture.shell.snapshot().treeLodOverlayEnabled, false);
  assert.deepEqual(fixture.calls.treeLodOverlays, [true, false]);
  assert.equal(offToggle.getAttribute('aria-pressed'), 'true');
  assert.equal(onToggle.getAttribute('aria-pressed'), 'false');
  assert.equal(offToggle.classList.contains('debug-on'), true);
  fixture.shell.dispose();

  let diagnosticsOn = true;
  const dynamic = createFixture({ treeLodDiagnosticsAvailable: () => diagnosticsOn });
  dynamic.elements.get('start-button').dispatch('click');
  dynamic.elements.get('debug-tree-lod-overlay-on-btn').dispatch('click');
  assert.equal(dynamic.shell.snapshot().treeLodOverlayEnabled, true);
  diagnosticsOn = false;
  dynamic.shell.openDebug();
  assert.equal(dynamic.shell.snapshot().treeLodOverlayEnabled, false);
  assert.deepEqual(dynamic.calls.treeLodOverlays, [true, false]);
  assert.equal(dynamic.elements.get('debug-tree-lod-overlay-on-btn').disabled, true);
  assert.equal(dynamic.elements.get('set-tree-lod-overlay').checked, false);
  assert.equal(dynamic.elements.get('set-tree-lod-overlay').disabled, true);
  dynamic.shell.dispose();

  const unavailable = createFixture();
  const unavailableOffToggle = unavailable.elements.get('debug-tree-lod-overlay-off-btn');
  const unavailableOnToggle = unavailable.elements.get('debug-tree-lod-overlay-on-btn');
  assert.equal(unavailable.shell.snapshot().treeLodOverlayEnabled, false);
  assert.equal(unavailableOffToggle.disabled, true);
  assert.equal(unavailableOnToggle.disabled, true);
  assert.equal(unavailableOffToggle.getAttribute('aria-disabled'), 'true');
  assert.equal(unavailableOnToggle.getAttribute('aria-disabled'), 'true');
  unavailableOnToggle.dispatch('click');
  assert.deepEqual(unavailable.calls.treeLodOverlays, []);
  assert.equal(unavailable.shell.snapshot().treeLodOverlayEnabled, false);
  unavailable.shell.dispose();

  const settingsSync = createFixture({
    exposeDeveloperTools: true,
    treeLodDiagnosticsAvailable: true,
  });
  const treeLodSetting = settingsSync.elements.get('set-tree-lod-overlay');
  const settingsOnToggle = settingsSync.elements.get('debug-tree-lod-overlay-on-btn');
  assert.equal(settingsOnToggle.disabled, false);
  assert.equal(treeLodSetting.checked, false);
  assert.equal(settingsOnToggle.disabled, false);
  settingsOnToggle.dispatch('click');
  assert.equal(settingsSync.shell.snapshot().treeLodOverlayEnabled, true);
  assert.equal(treeLodSetting.checked, true);
  treeLodSetting.checked = false;
  treeLodSetting.dispatch('change');
  assert.equal(settingsSync.shell.snapshot().treeLodOverlayEnabled, false);
  settingsSync.elements.get('debug-tree-lod-overlay-on-btn').dispatch('click');
  settingsSync.elements.get('debug-tree-lod-overlay-off-btn').dispatch('click');
  assert.equal(treeLodSetting.checked, false);
  assert.deepEqual(settingsSync.calls.treeLodOverlays, [true, false, true, false]);
  settingsSync.shell.dispose();

  const reloaded = createFixture({
    exposeDeveloperTools: true,
    developerToolsEnabled: true,
    treeLodDiagnosticsAvailable: true,
  });
  assert.equal(reloaded.elements.get('set-developer-tools').checked, true);
  assert.equal(reloaded.elements.get('debug-tree-lod-overlay-on-btn').disabled, false);
  assert.equal(reloaded.shell.snapshot().treeLodOverlayEnabled, false);
  assert.equal(reloaded.elements.get('set-tree-lod-overlay').checked, false);
  reloaded.shell.dispose();
});

test('playing diagnostics HUD stays live after Debug closes without pausing gameplay', () => {
  const fixture = createFixture({ exposeDeveloperTools: true, developerToolsEnabled: true });
  const diagnosticsHud = fixture.elements.get('gameplay-diagnostics-hud');
  const offToggle = fixture.elements.get('debug-gameplay-diagnostics-off-btn');
  const onToggle = fixture.elements.get('debug-gameplay-diagnostics-on-btn');
  const revisionBeforeToggle = fixture.worldState.revision;
  assert.equal(onToggle.listenerCount('click'), 1);
  assert.equal(fixture.shell.snapshot().gameplayDiagnosticsHudEnabled, false);
  assert.equal(diagnosticsHud.style.display, 'none');
  assert.equal(offToggle.getAttribute('aria-pressed'), 'true');

  fixture.elements.get('start-button').dispatch('click');
  const player = finishIntro(fixture, { x: 193.25, z: -48.5, facingY: 0 });
  fixture.shell.openDebug();
  assert.equal(fixture.shell.isPaused(), true);
  const pausedAt = fixture.shell.snapshot().gameplayTimeMs;
  onToggle.dispatch('click');
  assert.equal(fixture.shell.snapshot().gameplayDiagnosticsHudEnabled, true);
  assert.equal(diagnosticsHud.style.display, 'block');
  assert.equal(onToggle.getAttribute('aria-pressed'), 'true');
  assert.equal(fixture.worldState.revision, revisionBeforeToggle);

  fixture.shell.renderHud({
    fps: 59.6,
    gameplaySnapshot: {
      state: {
        player: { ...player, hp: 64, maxHp: 100, score: 42 }, activeScaleStageId: 'MID',
        nuclearCooldownMs: 0, manualBoss: null,
        destroyedFeatureCount: 2, destroyedEntityCount: 3,
      },
      activeTankCount: 0, activeSimulationChunkCount: 9,
      simulatedEntityCount: 4, simulatedStaticTargetCount: 5,
    },
    runtimeSnapshot: {
      centerChunkX: 12, centerChunkZ: -4, renderedCount: 9, activeDataCount: 25,
      performance: { frame: { p50: 6, p95: 10.25, max: 15 } },
    },
    presentationSnapshot: { renderDistancePreset: 'standard' },
    workerSnapshot: { mode: 'worker', fallbackOccurred: false },
    saveStatus: 'saved',
    renderInfo: { drawCalls: 17 },
    resources: null,
    debugDetailsEnabled: true,
    fullDiagnosticHtml: 'FULL DIAGNOSTIC CONTENT MUST NOT LEAK',
  });
  const compact = diagnosticsHud.textContent;
  for (const expected of [
    'FPS 60', 'Frame p95 10.25 ms', 'Player 193.25', '-48.50', 'Chunk 12,-4',
    'Scale MID', 'HP 64/100', 'Score 42', 'Worker worker',
    'Render Distance standard', 'Draw Calls 17',
  ]) assert.match(compact, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(compact, /FULL DIAGNOSTIC CONTENT MUST NOT LEAK/);
  assert.doesNotMatch(compact, /Stable destruction|Simulation/);

  fixture.shell.updatePlayer({
    deltaSeconds: 1,
    player,
    scaleProfile: getW6ScaleProfile('MAX'),
  });
  assert.equal(fixture.shell.snapshot().gameplayTimeMs, pausedAt);
  fixture.elements.get('debug-close-btn').dispatch('click');
  assert.equal(fixture.shell.isPaused(), false);
  assert.equal(diagnosticsHud.style.display, 'block');
  fixture.shell.updatePlayer({
    deltaSeconds: 1,
    player,
    scaleProfile: getW6ScaleProfile('MAX'),
  });
  assert.equal(fixture.shell.snapshot().gameplayTimeMs, pausedAt + 1_000);
  for (let cycle = 0; cycle < 3; cycle += 1) {
    fixture.shell.openDebug();
    fixture.elements.get('debug-close-btn').dispatch('click');
  }
  assert.equal(onToggle.listenerCount('click'), 1);

  fixture.shell.openDebug();
  offToggle.dispatch('click');
  assert.equal(fixture.shell.snapshot().gameplayDiagnosticsHudEnabled, false);
  assert.equal(diagnosticsHud.style.display, 'none');
  assert.equal(diagnosticsHud.textContent, '');
  assert.equal(fixture.worldState.revision, revisionBeforeToggle);
  fixture.shell.dispose();
});

test('normal HUD is a read-only adapter and no Boss UI appears without a manual Boss', () => {
  const fixture = createFixture();
  const gameplaySnapshot = {
    state: {
      player: { hp: 75, maxHp: 100, score: 300 }, activeScaleStageId: 'MID',
      destroyedFeatureCount: 2, destroyedEntityCount: 1,
    },
    activeSimulationChunkCount: 9, simulatedEntityCount: 8, simulatedStaticTargetCount: 44,
  };
  const before = structuredClone(gameplaySnapshot);
  fixture.shell.renderHud({
    fps: 60,
    gameplaySnapshot,
    runtimeSnapshot: {
      centerChunkX: 1, centerChunkZ: -2, renderedCount: 9, activeDataCount: 25,
      performance: { frame: { p50: 6, p95: 11, max: 20 } },
    },
    saveStatus: 'saved', renderInfo: { drawCalls: 12, geometries: 8 },
    resources: { sharedMaterialCount: 7 },
  });
  assert.deepEqual(gameplaySnapshot, before);
  assert.equal(fixture.elements.get('score').textContent, '$3,000,000');
  assert.equal(fixture.elements.get('hp-number').textContent, 75);
  assert.equal(fixture.elements.get('hp-bar-fill').style.width, '75%');
  assert.equal(fixture.elements.get('boss-ui').style.display, 'none');
  assert.equal(fixture.elements.get('charge-ui').style.display, 'none');
  assert.equal(fixture.elements.get('atomic-cd-label').textContent, 'SCALE SANDBOX: LOCKED');
  fixture.shell.dispose();
});

test('GP-SAVE-04 exposes storage failure in normal UI and keeps fallback Continue available', () => {
  const html = readFileSync(resolve(repoRoot, 'infinite-world-sandbox.html'), 'utf8');
  assert.match(html, /<div id="save-warning" role="alert" aria-live="assertive"><\/div>/);

  const fixture = createFixture();
  const gameplaySnapshot = {
    state: {
      player: { hp: 100, maxHp: 100, score: 0 }, activeScaleStageId: 'MAX',
      destroyedFeatureCount: 0, destroyedEntityCount: 0,
    },
    activeSimulationChunkCount: 9, simulatedEntityCount: 0, simulatedStaticTargetCount: 0,
  };
  fixture.shell.renderHud({ fps: 60, gameplaySnapshot, saveStatus: 'unavailable' });
  const warning = fixture.elements.get('save-warning');
  assert.equal(warning.style.display, 'block');
  assert.match(warning.textContent, /SAVE UNAVAILABLE/);
  assert.equal(fixture.elements.get('debug-modal').style.display, 'none');

  fixture.shell.setContinueAvailable(true);
  fixture.shell.renderHud({ fps: 60, gameplaySnapshot, saveStatus: 'fallback' });
  assert.equal(fixture.elements.get('continue-button').disabled, false);
  assert.equal(fixture.elements.get('continue-button').style.display, 'block');
  assert.equal(warning.style.display, 'none');
  fixture.shell.dispose();
});

test('Player movement supplies the formal Tiny, Mid, and Max radius to horizontal collision', () => {
  for (const stageId of ['TINY', 'MID', 'MAX']) {
    const collisionInputs = [];
    const fixture = createFixture({
      resolvePlayerHorizontalMovement(input) {
        collisionInputs.push({ ...input });
        return {
          x: input.startX + input.displacementX,
          z: input.startZ + input.displacementZ,
          collided: false,
        };
      },
    });
    fixture.elements.get('start-button').dispatch('click');
    const profile = getW6ScaleProfile(stageId);
    const player = finishIntro(fixture, { x: 0, z: 0, facingY: 0 }, profile);
    collisionInputs.length = 0;
    fixture.globalObject.dispatch('keydown', { code: 'KeyD' });
    fixture.shell.updatePlayer({ deltaSeconds: 1 / 60, player, scaleProfile: profile });
    const input = collisionInputs.at(-1);
    assert.equal(input.playerRadiusMeters, getScalePlayerVerticalMetrics(profile).radiusMeters);
    assert.equal(input.displacementX, profile.movementMetersPerSecond / 60);
    assert.equal(Math.abs(input.displacementZ), 0);
    fixture.shell.dispose();
  }
});

test('horizontal collision preserves Sprint, airborne X/Z, and final terrain sampling', () => {
  const collisionInputs = [];
  const fixture = createFixture({
    resolvePlayerHorizontalMovement(input) {
      collisionInputs.push({ ...input });
      return {
        x: input.startX + input.displacementX * 0.5,
        z: input.startZ + input.displacementZ * 0.5,
        collided: true,
      };
    },
  });
  fixture.elements.get('start-button').dispatch('click');
  const profile = getW6ScaleProfile('MAX');
  const player = finishIntro(fixture, { x: 0, z: 0, facingY: 0 }, profile);
  player.x = 0;
  player.z = 0;
  collisionInputs.length = 0;
  fixture.globalObject.dispatch('keydown', { code: 'KeyD' });
  fixture.globalObject.dispatch('keydown', { code: 'ShiftLeft' });
  fixture.globalObject.dispatch('keydown', { code: 'Space' });
  const update = fixture.shell.updatePlayer({ deltaSeconds: 1 / 60, player, scaleProfile: profile });
  const desiredDistance = profile.movementMetersPerSecond * 1.45 / 60;
  assert.equal(collisionInputs.at(-1).displacementX, desiredDistance);
  assert.equal(player.x, desiredDistance * 0.5);
  assert.equal(update.movement.sprint, true);
  assert.equal(update.horizontalCollision.collided, true);
  assert.equal(update.vertical.grounded, false);
  assert.equal(update.vertical.terrainHeightMeters, 1 + player.x * 0.01);
  fixture.shell.dispose();
});

test('debug mode and Developer Tools changes preserve the finite normal HUD state', () => {
  const fixture = createFixture();
  fixture.elements.get('start-button').dispatch('click');
  finishIntro(fixture);
  const gameplaySnapshot = {
    state: {
      player: { hp: 64, maxHp: 100, score: 42 }, activeScaleStageId: 'MAX',
      nuclearCooldownMs: 0, manualBoss: null, destroyedFeatureCount: 0, destroyedEntityCount: 0,
    },
    activeTankCount: 0, activeSimulationChunkCount: 9, simulatedEntityCount: 0, simulatedStaticTargetCount: 0,
  };
  const render = () => fixture.shell.renderHud({
    fps: 60, gameplaySnapshot,
    runtimeSnapshot: {
      centerChunkX: 0, centerChunkZ: 0, renderedCount: 9, activeDataCount: 25,
      performance: { frame: { p50: 6, p95: 10, max: 15 } },
    },
    saveStatus: 'saved', renderInfo: {}, resources: { sharedMaterialCount: 1 },
  });
  render();
  const before = {
    score: fixture.elements.get('score').textContent,
    hp: fixture.elements.get('hp-number').textContent,
    atomic: fixture.elements.get('atomic-cd-label').textContent,
  };
  fixture.shell.openDebug();
  render();
  fixture.worldState.setDeveloperTools(true);
  render();
  fixture.elements.get('debug-close-btn').dispatch('click');
  render();
  assert.deepEqual({
    score: fixture.elements.get('score').textContent,
    hp: fixture.elements.get('hp-number').textContent,
    atomic: fixture.elements.get('atomic-cd-label').textContent,
  }, before);
  fixture.shell.dispose();
});

test('Boss HP keeps the finite immediate fill, 500ms damage lag, and tick-ready overlay', () => {
  const fixture = createFixture();
  fixture.elements.get('start-button').dispatch('click');
  finishIntro(fixture);
  const renderBoss = hp => fixture.shell.renderHud({
    fps: 60,
    gameplaySnapshot: {
      state: {
        player: { hp: 100, maxHp: 100, score: 0 }, activeScaleStageId: 'MAX',
        manualBoss: { alive: true, hp, maxHp: 100 }, nuclearCooldownMs: 0,
        destroyedFeatureCount: 0, destroyedEntityCount: 0,
      },
      activeTankCount: 0, activeSimulationChunkCount: 9,
      simulatedEntityCount: 1, simulatedStaticTargetCount: 0,
    },
    runtimeSnapshot: {
      centerChunkX: 0, centerChunkZ: 0, renderedCount: 9, activeDataCount: 25,
      performance: { frame: { p50: 6, p95: 10, max: 15 } },
    },
    saveStatus: 'saved', renderInfo: {}, resources: { sharedMaterialCount: 1 },
  });
  fixture.setNow(0); renderBoss(100);
  fixture.setNow(100); renderBoss(50);
  assert.equal(fixture.elements.get('boss-hp-fill').style.width, '50%');
  assert.equal(fixture.elements.get('boss-hp-damage').style.width, '100%');
  fixture.setNow(599); renderBoss(50);
  assert.equal(fixture.elements.get('boss-hp-damage').style.width, '100%');
  fixture.setNow(601); renderBoss(50);
  assert.equal(fixture.elements.get('boss-hp-damage').style.width, '50%');
  assert.equal(fixture.elements.get('boss-ui').style.display, 'block');
  fixture.shell.dispose();
});

test('debug stays transient while HUD visibility and settings use the existing World State', () => {
  const fixture = createFixture();
  fixture.elements.get('start-button').dispatch('click');
  fixture.globalObject.dispatch('keydown', { code: 'KeyH' });
  assert.equal(fixture.bodyClasses.has('hud-hidden'), true);
  assert.equal(fixture.worldState.experience.hudHidden, true);
  fixture.elements.get('set-vol').value = '0.25';
  fixture.elements.get('set-vol').dispatch('input');
  assert.equal(fixture.worldState.experience.settings.volume, 0.25);
  fixture.elements.get('set-antialias').checked = false;
  fixture.elements.get('set-antialias').dispatch('change');
  assert.equal(fixture.worldState.experience.settings.antialias, false);
  fixture.elements.get('set-render-distance').value = 'short';
  fixture.elements.get('set-render-distance').dispatch('change');
  assert.equal(fixture.worldState.experience.settings.renderDistance, 'short');
  assert.equal(fixture.elements.get('antialias-note').style.display, 'block');
  fixture.globalObject.dispatch('keydown', { code: 'Tab' });
  assert.equal(fixture.shell.snapshot().debugOpen, true);
  assert.equal(fixture.shell.isPaused(), true);
  fixture.elements.get('debug-close-btn').dispatch('click');
  fixture.elements.get('set-home-btn').dispatch('click');
  assert.equal(fixture.calls.returnTitles, 1);
  assert.equal(fixture.calls.homeResets, 0);
  assert.equal(fixture.shell.snapshot().mode, 'menu');
  fixture.shell.dispose();
});

test('Debug UI opens repeatedly without duplicate listeners and renders current bounded diagnostics', () => {
  const fixture = createFixture();
  fixture.elements.get('start-button').dispatch('click');
  finishIntro(fixture);
  const mouseUpListeners = fixture.globalObject.listenerCount('mouseup');
  const keyDownListeners = fixture.globalObject.listenerCount('keydown');
  const revisionBeforeDebug = fixture.worldState.revision;

  for (let index = 0; index < 5; index += 1) {
    fixture.shell.openDebug();
    assert.equal(fixture.elements.get('debug-modal').style.display, 'flex');
    assert.equal(fixture.shell.isPaused(), true);
    fixture.elements.get('debug-close-btn').dispatch('click');
    assert.equal(fixture.elements.get('debug-modal').style.display, 'none');
  }
  assert.equal(fixture.globalObject.listenerCount('mouseup'), mouseUpListeners);
  assert.equal(fixture.globalObject.listenerCount('keydown'), keyDownListeners);
  assert.equal(fixture.worldState.revision, revisionBeforeDebug);

  const distanceBeforePause = fixture.shell.snapshot().camera.distanceMeters;
  fixture.shell.openDebug();
  fixture.globalObject.dispatch('wheel', { deltaY: 100 });
  assert.equal(fixture.shell.snapshot().camera.distanceMeters, distanceBeforePause);
  const longDiagnostic = `Stable ID ${'diagnostic-without-breaks-'.repeat(100)}`;
  const gameplaySnapshot = {
    state: {
      player: { hp: 64, maxHp: 100, score: 42 }, activeScaleStageId: 'MAX',
      nuclearCooldownMs: 0, manualBoss: null,
      destroyedFeatureCount: 2, destroyedEntityCount: 3,
    },
    activeTankCount: 1, activeSimulationChunkCount: 9,
    simulatedEntityCount: 4, simulatedStaticTargetCount: 5,
  };
  fixture.shell.renderHud({
    fps: 59.6,
    gameplaySnapshot,
    runtimeSnapshot: {
      centerChunkX: 12, centerChunkZ: -8, renderedCount: 9, activeDataCount: 25,
      performance: { frame: { p50: 6, p95: 10, max: 15 } },
    },
    presentationSnapshot: {
      midgroundChunkCount: 16, clipmapMeshCount: 1, renderDistancePreset: 'standard',
    },
    workerSnapshot: {
      mode: 'worker', pendingCount: 2, fallbackOccurred: false,
    },
    saveStatus: 'saved',
    renderInfo: { drawCalls: 7, geometries: 8 },
    resources: { sharedMaterialCount: 9 },
    fullDiagnosticHtml: longDiagnostic,
    debugDetailsEnabled: true,
  });
  const summary = fixture.elements.get('debug-summary').textContent;
  assert.match(summary, /FPS 60/);
  assert.match(summary, /Chunk 12,-8/);
  assert.match(summary, /Worker worker  Pending 2  Fallback no/);
  assert.match(summary, /Save saved/);
  assert.match(summary, /Render Distance standard/);
  assert.equal(fixture.elements.get('debug-runtime-details').innerHTML, longDiagnostic);

  fixture.shell.renderHud({
    fps: 30,
    gameplaySnapshot,
    runtimeSnapshot: {
      centerChunkX: -2, centerChunkZ: 4, renderedCount: 9, activeDataCount: 25,
      performance: { frame: { p50: 20, p95: 30, max: 40 } },
    },
    presentationSnapshot: {
      midgroundChunkCount: 16, clipmapMeshCount: 1, renderDistancePreset: 'short',
    },
    workerSnapshot: {
      mode: 'inline-fallback', pendingCount: 0, fallbackOccurred: true,
    },
    saveStatus: 'fallback',
    renderInfo: { drawCalls: 3, geometries: 4 },
    resources: { sharedMaterialCount: 5 },
    fullDiagnosticHtml: 'latest diagnostics',
    debugDetailsEnabled: true,
  });
  assert.match(fixture.elements.get('debug-summary').textContent, /FPS 30/);
  assert.match(fixture.elements.get('debug-summary').textContent, /Chunk -2,4/);
  assert.match(fixture.elements.get('debug-summary').textContent, /Worker inline-fallback/);
  assert.match(fixture.elements.get('debug-summary').textContent, /Save fallback/);
  assert.match(fixture.elements.get('debug-summary').textContent, /Render Distance short/);
  assert.equal(fixture.elements.get('debug-runtime-details').innerHTML, 'latest diagnostics');

  fixture.shell.renderHud({
    fps: 60, gameplaySnapshot, saveStatus: 'saved', debugDetailsEnabled: false,
  });
  assert.equal(fixture.elements.get('debug-summary').textContent, 'Runtime diagnostics unavailable');
  assert.equal(fixture.elements.get('debug-runtime-details').innerHTML, '');

  fixture.elements.get('debug-close-btn').dispatch('click');
  fixture.globalObject.dispatch('wheel', { deltaY: 100 });
  assert.notEqual(fixture.shell.snapshot().camera.distanceMeters, distanceBeforePause);
  fixture.shell.dispose();
});

test('GP-LIFE-01 routes title and home reset through independent callbacks', () => {
  const fixture = createFixture();
  fixture.elements.get('start-button').dispatch('click');
  const player = { x: 37, z: -21, facingY: 1.25 };
  finishIntro(fixture, player);
  const playerBeforeTitle = { ...player };

  fixture.elements.get('set-home-btn').dispatch('click');
  assert.equal(fixture.calls.returnTitles, 1);
  assert.equal(fixture.calls.homeResets, 0);
  assert.deepEqual(player, playerBeforeTitle);
  assert.equal(fixture.shell.snapshot().mode, 'menu');

  fixture.elements.get('set-reset-btn').dispatch('click');
  assert.equal(fixture.calls.returnTitles, 1);
  assert.equal(fixture.calls.homeResets, 1);
  fixture.shell.dispose();
});

test('zero HP enters Game Over and Retry delegates to the existing runtime restart', async () => {
  const fixture = createFixture();
  fixture.elements.get('start-button').dispatch('click');
  const player = { x: 0, z: 0, facingY: 0 };
  const profile = getW6ScaleProfile('MAX');
  finishIntro(fixture, player, profile);
  fixture.globalObject.dispatch('keydown', { code: 'Space' });
  fixture.shell.updatePlayer({ deltaSeconds: 1 / 60, player, scaleProfile: profile });
  assert.equal(fixture.shell.snapshot().playerVertical.grounded, false);
  const deadHud = {
    fps: 60,
    gameplaySnapshot: {
      state: {
        player: { hp: 0, maxHp: 100, score: 450 }, activeScaleStageId: 'MAX',
        destroyedFeatureCount: 0, destroyedEntityCount: 0,
      },
      activeSimulationChunkCount: 9, simulatedEntityCount: 1, simulatedStaticTargetCount: 1,
    },
    runtimeSnapshot: {
      centerChunkX: 0, centerChunkZ: 0, renderedCount: 9, activeDataCount: 25,
      performance: { frame: { p50: 6, p95: 10, max: 20 } },
    },
    saveStatus: 'saved', renderInfo: {}, resources: { sharedMaterialCount: 1 },
  };
  fixture.shell.renderHud(deadHud);
  assert.equal(fixture.shell.getRunPhase(), 'dying');
  assert.equal(fixture.elements.get('game-over').style.display, 'none');
  fixture.shell.updatePlayer({ deltaSeconds: 3, player, scaleProfile: profile });
  fixture.shell.renderHud(deadHud);
  assert.equal(fixture.shell.snapshot().mode, 'gameover');
  assert.equal(fixture.elements.get('game-over').style.display, 'flex');
  assert.equal(fixture.elements.get('final-score').textContent, '$4,500,000');
  fixture.elements.get('restart-button').dispatch('click');
  await Promise.resolve();
  assert.equal(fixture.calls.restarts, 1);
  assert.equal(fixture.shell.snapshot().mode, 'playing');
  assert.equal(fixture.shell.snapshot().playerVertical.grounded, true);
  assert.equal(fixture.shell.snapshot().playerVertical.velocityMetersPerSecond, 0);
  fixture.shell.dispose();
});

test('held Space repeats the finite jump after landing without adding a midair impulse', () => {
  const fixture = createFixture();
  fixture.elements.get('start-button').dispatch('click');
  const player = { x: 0, z: 0, facingY: 0 };
  const profile = getW6ScaleProfile('MAX');
  finishIntro(fixture, player, profile);
  fixture.globalObject.dispatch('keydown', { code: 'Space', repeat: false });
  const initialVelocity = fixture.shell.snapshot().playerVertical.velocityMetersPerSecond;
  fixture.globalObject.dispatch('keydown', { code: 'Space', repeat: true });
  fixture.globalObject.dispatch('keydown', { code: 'Space', repeat: true });
  assert.equal(fixture.shell.snapshot().playerVertical.velocityMetersPerSecond, initialVelocity);

  let landed = false;
  for (let frame = 0; frame < 600 && !landed; frame += 1) {
    landed = fixture.shell.updatePlayer({
      deltaSeconds: 1 / 120, player, scaleProfile: profile,
    }).landed;
    fixture.globalObject.dispatch('keydown', { code: 'Space', repeat: true });
  }
  assert.equal(landed, true);
  assert.equal(fixture.shell.snapshot().playerVertical.grounded, true);
  assert.equal(fixture.shell.snapshot().playerVertical.velocityMetersPerSecond, 0);
  fixture.shell.updatePlayer({ deltaSeconds: 1 / 120, player, scaleProfile: profile });
  assert.equal(fixture.shell.snapshot().playerVertical.grounded, false);
  fixture.globalObject.dispatch('keyup', { code: 'Space' });
  fixture.shell.dispose();
});

test('a playable airborne-to-grounded transition emits one finite-parity landing and intro does not', () => {
  const fixture = createFixture();
  fixture.elements.get('start-button').dispatch('click');
  const player = { x: 2, z: 3, facingY: 0 };
  const profile = getW6ScaleProfile('MAX');
  finishIntro(fixture, player, profile);
  assert.deepEqual(fixture.calls.landings, []);

  fixture.globalObject.dispatch('keydown', { code: 'Space', repeat: false });
  fixture.globalObject.dispatch('keyup', { code: 'Space' });
  for (let frame = 0; frame < 600 && !fixture.shell.snapshot().playerVertical.grounded; frame += 1) {
    fixture.shell.updatePlayer({ deltaSeconds: 1 / 120, player, scaleProfile: profile });
  }
  assert.equal(fixture.calls.landings.length, 1);
  assert.deepEqual(fixture.calls.landings[0], {
    x: 2,
    z: 3,
    scaleStageId: 'MAX',
    terrainHeightMeters: 1.08,
  });
  fixture.shell.updatePlayer({ deltaSeconds: 1, player, scaleProfile: profile });
  assert.equal(fixture.calls.landings.length, 1);
  fixture.shell.dispose();
});

test('W7D mouse charge releases nuclear input only after the protected threshold and exposes manual Boss debug', () => {
  const fixture = createFixture();
  fixture.elements.get('start-button').dispatch('click');
  finishIntro(fixture);
  fixture.globalObject.dispatch('keydown', { code: 'Space' });
  fixture.globalObject.dispatch('mousedown', { button: 0 });
  fixture.globalObject.dispatch('mousedown', { button: 2 });
  fixture.setNow(1800);
  fixture.shell.updateCamera({
    renderLocal: { x: 0, z: 0 }, scaleProfile: getW6ScaleProfile('MAX'), unitsPerMeter: 40,
  });
  assert.ok(fixture.shell.snapshot().camera.chargeZoom > 0);
  fixture.globalObject.dispatch('mouseup', { button: 0 });
  assert.deepEqual(fixture.calls.nuclear, [{
    airborne: true,
    chargeMs: 1800,
    issuedAt: 1800,
    originY: fixture.shell.snapshot().playerVertical.rootY,
  }]);
  assert.equal(fixture.calls.attacks.length, 0);
  assert.equal(fixture.shell.snapshot().camera.chargeZoom, 0);

  fixture.elements.get('debug-spawn-boss-btn').dispatch('click');
  assert.equal(fixture.calls.bossSpawns, 1);
  assert.equal(fixture.shell.triggerNuclearEffect(), true);
  assert.equal(fixture.elements.get('nuclear-flash').style.opacity, '0');
  fixture.shell.dispose();
});

test('Atomic charge can start while grounded and retains the airborne release contract', () => {
  const fixture = createFixture({ useCombatCommands: true });
  fixture.elements.get('start-button').dispatch('click');
  finishIntro(fixture);
  assert.equal(fixture.shell.snapshot().playerVertical.grounded, true);
  fixture.shell.renderHud({
    fps: 60,
    gameplaySnapshot: {
      state: {
        player: { hp: 100, maxHp: 100, score: 0 }, activeScaleStageId: 'MAX',
        nuclearCooldownMs: 0, destroyedFeatureCount: 0, destroyedEntityCount: 0,
      },
      activeTankCount: 0, activeSimulationChunkCount: 9,
      simulatedEntityCount: 0, simulatedStaticTargetCount: 0,
    },
    runtimeSnapshot: {
      centerChunkX: 0, centerChunkZ: 0, renderedCount: 9, activeDataCount: 25,
      performance: { frame: { p50: 6, p95: 10, max: 15 } },
    },
    saveStatus: 'saved', renderInfo: {}, resources: { sharedMaterialCount: 1 },
  });
  fixture.globalObject.dispatch('mousedown', { button: 0 });
  fixture.globalObject.dispatch('mousedown', { button: 2 });
  assert.equal(fixture.calls.combatCommands.at(-1).type, 'charge-start');
  assert.notEqual(fixture.shell.snapshot().nuclearChargeStartedAt, null);
  fixture.setNow(1_800);
  fixture.globalObject.dispatch('mouseup', { button: 0 });
  assert.deepEqual(fixture.calls.nuclear, [{
    airborne: false,
    chargeMs: 1_800,
    issuedAt: 1_800,
    originY: fixture.shell.snapshot().playerVertical.rootY,
  }]);
  fixture.shell.dispose();
});

test('GP-INPUT-01 charge resolution suppresses the remaining physical mouseup exactly once', async t => {
  const beginPlaying = (options = {}) => {
    const fixture = createFixture(options);
    fixture.elements.get('start-button').dispatch('click');
    finishIntro(fixture);
    return fixture;
  };
  const pressBoth = fixture => {
    fixture.globalObject.dispatch('mousedown', { button: 0 });
    fixture.globalObject.dispatch('mousedown', { button: 2 });
  };

  for (const [label, releasedButton, remainingButton] of [
    ['left-first', 0, 2],
    ['right-first', 2, 0],
  ]) {
    await t.test(`${label} Atomic release ignores the other button mouseup`, () => {
      const fixture = beginPlaying();
      pressBoth(fixture);
      fixture.setNow(W7_NUCLEAR_CONTRACT.chargeThresholdMs + 100);
      fixture.globalObject.dispatch('mouseup', { button: releasedButton });
      fixture.globalObject.dispatch('mouseup', { button: remainingButton });
      assert.equal(fixture.calls.nuclear.length, 1);
      assert.deepEqual(fixture.calls.attacks, []);
      fixture.shell.dispose();
    });
  }

  await t.test('a rejected Atomic release still suppresses the remaining mouseup', () => {
    const fixture = beginPlaying({ nuclearReleaseResult: { accepted: false, reason: 'airborne-required' } });
    pressBoth(fixture);
    fixture.setNow(W7_NUCLEAR_CONTRACT.chargeThresholdMs + 100);
    fixture.globalObject.dispatch('mouseup', { button: 0 });
    fixture.globalObject.dispatch('mouseup', { button: 2 });
    assert.equal(fixture.calls.nuclear.length, 1);
    assert.deepEqual(fixture.calls.attacks, []);
    fixture.shell.dispose();
  });

  await t.test('short charge emits only the double Claw and suppresses the remaining mouseup', () => {
    const fixture = beginPlaying();
    pressBoth(fixture);
    fixture.setNow(W7_NUCLEAR_CONTRACT.chargeThresholdMs - 1);
    fixture.globalObject.dispatch('mouseup', { button: 2 });
    fixture.globalObject.dispatch('mouseup', { button: 0 });
    assert.deepEqual(fixture.calls.attacks, ['double']);
    assert.deepEqual(fixture.calls.nuclear, []);
    fixture.shell.dispose();
  });

  await t.test('normal left and right clicks remain distinct CombatCommands', () => {
    const fixture = beginPlaying({ useCombatCommands: true });
    fixture.globalObject.dispatch('mousedown', { button: 0 });
    fixture.globalObject.dispatch('mouseup', { button: 0 });
    fixture.globalObject.dispatch('mousedown', { button: 2 });
    fixture.globalObject.dispatch('mouseup', { button: 2 });
    assert.deepEqual(
      fixture.calls.combatCommands.map(command => command.type),
      ['left-claw', 'right-claw'],
    );
    fixture.shell.dispose();
  });

  await t.test('suppression is consumed once and cannot swallow the next new click', () => {
    const fixture = beginPlaying({ useCombatCommands: true });
    renderAtomicReady(fixture);
    pressBoth(fixture);
    fixture.setNow(W7_NUCLEAR_CONTRACT.chargeThresholdMs + 100);
    fixture.globalObject.dispatch('mouseup', { button: 0 });
    fixture.globalObject.dispatch('mouseup', { button: 2 });
    fixture.globalObject.dispatch('mousedown', { button: 2 });
    fixture.globalObject.dispatch('mouseup', { button: 2 });
    assert.deepEqual(
      fixture.calls.combatCommands.map(command => command.type),
      ['charge-start', 'right-claw'],
    );
    assert.equal(fixture.calls.nuclear.length, 1);
    fixture.shell.dispose();
  });

  await t.test('pause clears suppression and an unmatched physical release cannot attack after resume', () => {
    const fixture = beginPlaying({ useCombatCommands: true });
    renderAtomicReady(fixture);
    pressBoth(fixture);
    fixture.setNow(W7_NUCLEAR_CONTRACT.chargeThresholdMs + 100);
    fixture.globalObject.dispatch('mouseup', { button: 0 });
    fixture.shell.openSettings();
    fixture.shell.resume();
    fixture.globalObject.dispatch('mouseup', { button: 2 });
    assert.deepEqual(
      fixture.calls.combatCommands.map(command => command.type),
      ['charge-start'],
    );
    fixture.shell.dispose();
  });

  await t.test('menu and blur clear suppression before the next click', async () => {
    for (const transition of ['menu', 'blur']) {
      const fixture = beginPlaying({ useCombatCommands: true });
      renderAtomicReady(fixture);
      pressBoth(fixture);
      fixture.setNow(W7_NUCLEAR_CONTRACT.chargeThresholdMs + 100);
      fixture.globalObject.dispatch('mouseup', { button: 0 });
      if (transition === 'menu') {
        await fixture.shell.returnTitle();
        fixture.shell.start('new');
        finishIntro(fixture);
      } else {
        fixture.globalObject.dispatch('blur');
      }
      fixture.globalObject.dispatch('mousedown', { button: 2 });
      fixture.globalObject.dispatch('mouseup', { button: 2 });
      assert.deepEqual(
        fixture.calls.combatCommands.map(command => command.type),
        ['charge-start', 'right-claw'],
        transition,
      );
      fixture.shell.dispose();
    }
  });

  await t.test('Atomic-unavailable fallback emits one double Claw and no release commands', () => {
    const fixture = beginPlaying({ useCombatCommands: true });
    pressBoth(fixture);
    fixture.globalObject.dispatch('mouseup', { button: 0 });
    fixture.globalObject.dispatch('mouseup', { button: 2 });
    assert.deepEqual(
      fixture.calls.combatCommands.map(command => command.type),
      ['both-claws'],
    );
    assert.deepEqual(fixture.calls.nuclear, []);
    fixture.shell.dispose();
  });
});

test('GP-INPUT-02 settings and Debug cancel attack input until a fresh resumed click', async t => {
  const beginPlaying = () => {
    const fixture = createFixture({ useCombatCommands: true });
    fixture.elements.get('start-button').dispatch('click');
    finishIntro(fixture);
    renderAtomicReady(fixture);
    return fixture;
  };
  const pressBoth = fixture => {
    fixture.globalObject.dispatch('mousedown', { button: 0 });
    fixture.globalObject.dispatch('mousedown', { button: 2 });
    assert.deepEqual(
      fixture.calls.combatCommands.map(command => command.type),
      ['charge-start'],
    );
  };

  for (const [label, pause, resume] of [
    ['settings', fixture => fixture.shell.openSettings(), fixture => fixture.shell.resume()],
    ['Debug', fixture => fixture.shell.openDebug(), fixture => fixture.shell.resume()],
  ]) {
    await t.test(`${label} cancels an Atomic charge and ignores both paused releases`, () => {
      const fixture = beginPlaying();
      pressBoth(fixture);
      pause(fixture);
      fixture.setNow(W7_NUCLEAR_CONTRACT.chargeThresholdMs + 100);
      fixture.globalObject.dispatch('mouseup', { button: 0 });
      fixture.globalObject.dispatch('mouseup', { button: 2 });
      assert.equal(fixture.shell.isPaused(), true);
      assert.deepEqual(
        fixture.calls.combatCommands.map(command => command.type),
        ['charge-start'],
      );
      assert.deepEqual(fixture.calls.nuclear, []);

      fixture.globalObject.dispatch('mousedown', { button: 0 });
      fixture.globalObject.dispatch('mouseup', { button: 0 });
      assert.deepEqual(
        fixture.calls.combatCommands.map(command => command.type),
        ['charge-start'],
      );

      resume(fixture);
      fixture.globalObject.dispatch('mouseup', { button: 2 });
      fixture.globalObject.dispatch('mousedown', { button: 0 });
      fixture.globalObject.dispatch('mouseup', { button: 0 });
      assert.deepEqual(
        fixture.calls.combatCommands.map(command => command.type),
        ['charge-start', 'left-claw'],
      );
      fixture.shell.dispose();
    });

    await t.test(`${label} cancels a short charge without a paused double or single Claw`, () => {
      const fixture = beginPlaying();
      pressBoth(fixture);
      pause(fixture);
      fixture.setNow(W7_NUCLEAR_CONTRACT.chargeThresholdMs - 1);
      fixture.globalObject.dispatch('mouseup', { button: 2 });
      fixture.globalObject.dispatch('mouseup', { button: 0 });
      assert.deepEqual(
        fixture.calls.combatCommands.map(command => command.type),
        ['charge-start'],
      );
      assert.deepEqual(fixture.calls.nuclear, []);
      fixture.shell.dispose();
    });
  }

  await t.test('GP-INPUT-01 release suppression remains correct after resume', () => {
    const fixture = beginPlaying();
    pressBoth(fixture);
    fixture.setNow(W7_NUCLEAR_CONTRACT.chargeThresholdMs + 100);
    fixture.globalObject.dispatch('mouseup', { button: 0 });
    fixture.globalObject.dispatch('mouseup', { button: 2 });
    assert.deepEqual(
      fixture.calls.combatCommands.map(command => command.type),
      ['charge-start'],
    );
    assert.equal(fixture.calls.nuclear.length, 1);
    fixture.shell.dispose();
  });
});

test('W7B extends the W6 runtime without a second gameplay state, entity registry or save system', () => {
  const source = readFileSync(resolve(repoRoot, 'src/infinite-world/experience-shell.js'), 'utf8');
  assert.match(source, /createInputController/);
  assert.match(source, /finiteWorldUnitsToMeters/);
  assert.doesNotMatch(source, /new\s+InfiniteWorldState|new\s+InfiniteWorldSaveStore|new\s+Map\s*\(/);
  assert.doesNotMatch(source, /\bplayerHp\b|\bownedScore\b|\bdestroyedStableIds\b/);
});
