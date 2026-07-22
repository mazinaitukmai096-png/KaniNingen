import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  createExperienceCameraState,
  createInfiniteExperienceShell,
} from '../src/infinite-world/experience-shell.js';
import { getW6ScaleProfile } from '../src/infinite-world/gameplay-contract.js';

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
}

function createElement() {
  return Object.assign(new FakeEventTarget(), {
    style: {}, textContent: '', value: '', checked: false, dataset: {},
  });
}

function createFixture() {
  const ids = [
    'start-screen', 'start-button', 'lobby-settings-btn', 'ui', 'crosshair', 'compass',
    'compass-arrow', 'fps-counter', 'score', 'scale-label', 'hp-number', 'hp-bar-fill',
    'atomic-status', 'boss-ui', 'charge-ui', 'news-ticker', 'settings-modal',
    'settings-close-btn', 'set-home-btn', 'set-reset-btn', 'resume-overlay', 'debug-modal',
    'debug-close-btn', 'debug-summary', 'debug-spawn-boss-btn', 'set-mouse', 'val-mouse', 'set-vol', 'val-vol',
    'set-quality', 'set-fps-counter', 'set-fps-cap', 'set-shake', 'val-shake', 'final-score',
    'game-over', 'restart-button',
    'nuclear-flash',
  ];
  const elements = new Map(ids.map(id => [id, createElement()]));
  elements.get('set-quality').value = 'high';
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
    activeScaleStageId: 'MAX',
    experience: {
      hudHidden: false,
      settings: {
        mouseSensitivity: 1, volume: 0.5, quality: 'high', showFps: false,
        fpsCap: 0, cameraShake: 1,
      },
    },
    setScaleStage(stageId) { this.activeScaleStageId = stageId; },
    updateExperience(patch) {
      this.experience = {
        ...this.experience,
        ...patch,
        settings: { ...this.experience.settings, ...(patch.settings ?? {}) },
      };
    },
  };
  const calls = {
    attacks: [], saves: 0, loads: 0, homes: 0, restarts: 0,
    nuclear: [], bossSpawns: 0,
  };
  const shell = createInfiniteExperienceShell({
    globalObject, documentObject, canvas, camera, playerMarker, worldState,
    initialScaleProfile: getW6ScaleProfile('MAX'),
    getTerrainHeightMeters: (x, z) => 1 + x * 0.01 + z * 0.02,
    onAttack: mode => calls.attacks.push(mode),
    onSave: () => { calls.saves += 1; },
    onLoad: () => { calls.loads += 1; },
    onHome: () => { calls.homes += 1; },
    onRestart: () => { calls.restarts += 1; },
    onNuclearRelease: input => { calls.nuclear.push(input); },
    onSpawnManualBoss: () => { calls.bossSpawns += 1; },
  });
  return {
    shell, globalObject, documentObject, canvas, camera, playerMarker, worldState,
    calls, elements, bodyClasses, setNow(value) { now = value; },
  };
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

test('W7 experience shell restores movement, jump, camera, scale, attacks, save and load controls', () => {
  const fixture = createFixture();
  fixture.elements.get('start-button').dispatch('click');
  assert.equal(fixture.shell.isPaused(), false);
  assert.equal(fixture.documentObject.pointerLockElement, fixture.canvas);

  const player = { x: 0, z: 0, facingY: 0 };
  const profile = getW6ScaleProfile('MAX');
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
  fixture.globalObject.dispatch('keydown', { code: 'Digit1' });
  fixture.globalObject.dispatch('keydown', { code: 'KeyP' });
  fixture.globalObject.dispatch('keydown', { code: 'KeyL' });
  assert.deepEqual(fixture.calls.attacks, ['single', 'double']);
  assert.equal(fixture.worldState.activeScaleStageId, 'TINY');
  assert.equal(fixture.calls.saves, 1);
  assert.equal(fixture.calls.loads, 1);

  fixture.globalObject.dispatch('mousemove', { movementX: 10, movementY: 5 });
  fixture.globalObject.dispatch('wheel', { deltaY: 20 });
  fixture.shell.updateCamera({ renderLocal: { x: 4, z: 7 }, scaleProfile: profile, unitsPerMeter: 40 });
  assert.notEqual(fixture.shell.snapshot().camera.yaw, 0);
  assert.ok(Number.isFinite(fixture.camera.position.x));
  assert.ok(Number.isFinite(fixture.camera.position.y));
  assert.ok(Number.isFinite(fixture.camera.position.z));
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
  assert.equal(fixture.elements.get('scale-label').textContent, 'MID');
  assert.equal(fixture.elements.get('hp-number').textContent, 75);
  assert.equal(fixture.elements.get('hp-bar-fill').style.width, '75%');
  assert.equal(fixture.elements.get('boss-ui').style.display, 'none');
  assert.equal(fixture.elements.get('charge-ui').style.display, 'none');
  assert.equal(fixture.elements.get('atomic-status').textContent, 'ATOMIC: MAX SCALE ONLY');
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
  fixture.globalObject.dispatch('keydown', { code: 'Tab' });
  assert.equal(fixture.shell.snapshot().debugOpen, true);
  assert.equal(fixture.shell.isPaused(), true);
  fixture.elements.get('debug-close-btn').dispatch('click');
  fixture.elements.get('set-home-btn').dispatch('click');
  assert.equal(fixture.calls.homes, 1);
  assert.equal(fixture.shell.snapshot().mode, 'menu');
  fixture.shell.dispose();
});

test('zero HP enters Game Over and Retry delegates to the existing runtime restart', async () => {
  const fixture = createFixture();
  fixture.elements.get('start-button').dispatch('click');
  const player = { x: 0, z: 0, facingY: 0 };
  const profile = getW6ScaleProfile('MAX');
  fixture.shell.updatePlayer({ deltaSeconds: 0, player, scaleProfile: profile });
  fixture.globalObject.dispatch('keydown', { code: 'Space' });
  fixture.shell.updatePlayer({ deltaSeconds: 1 / 60, player, scaleProfile: profile });
  assert.equal(fixture.shell.snapshot().playerVertical.grounded, false);
  fixture.shell.renderHud({
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
  });
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

test('Space is edge-triggered and held or repeated keydown cannot add another jump impulse', () => {
  const fixture = createFixture();
  fixture.elements.get('start-button').dispatch('click');
  const player = { x: 0, z: 0, facingY: 0 };
  const profile = getW6ScaleProfile('MAX');
  fixture.shell.updatePlayer({ deltaSeconds: 0, player, scaleProfile: profile });
  fixture.globalObject.dispatch('keydown', { code: 'Space', repeat: false });
  const initialVelocity = fixture.shell.snapshot().playerVertical.velocityMetersPerSecond;
  fixture.globalObject.dispatch('keydown', { code: 'Space', repeat: true });
  fixture.globalObject.dispatch('keydown', { code: 'Space', repeat: true });
  assert.equal(fixture.shell.snapshot().playerVertical.velocityMetersPerSecond, initialVelocity);

  for (let frame = 0; frame < 600 && !fixture.shell.snapshot().playerVertical.grounded; frame += 1) {
    fixture.shell.updatePlayer({ deltaSeconds: 1 / 120, player, scaleProfile: profile });
    fixture.globalObject.dispatch('keydown', { code: 'Space', repeat: true });
  }
  assert.equal(fixture.shell.snapshot().playerVertical.grounded, true);
  assert.equal(fixture.shell.snapshot().playerVertical.velocityMetersPerSecond, 0);
  fixture.shell.updatePlayer({ deltaSeconds: 1, player, scaleProfile: profile });
  assert.equal(fixture.shell.snapshot().playerVertical.grounded, true);

  fixture.globalObject.dispatch('keyup', { code: 'Space' });
  fixture.globalObject.dispatch('keydown', { code: 'Space', repeat: false });
  assert.equal(fixture.shell.snapshot().playerVertical.grounded, false);
  fixture.shell.dispose();
});

test('W7D mouse charge releases nuclear input only after the protected threshold and exposes manual Boss debug', () => {
  const fixture = createFixture();
  fixture.elements.get('start-button').dispatch('click');
  fixture.globalObject.dispatch('keydown', { code: 'Space' });
  fixture.globalObject.dispatch('mousedown', { button: 0 });
  fixture.globalObject.dispatch('mousedown', { button: 2 });
  fixture.setNow(1800);
  fixture.globalObject.dispatch('mouseup', { button: 0 });
  assert.deepEqual(fixture.calls.nuclear, [{ airborne: true, chargeMs: 1800 }]);
  assert.equal(fixture.calls.attacks.length, 0);

  fixture.elements.get('debug-spawn-boss-btn').dispatch('click');
  assert.equal(fixture.calls.bossSpawns, 1);
  assert.equal(fixture.shell.triggerNuclearEffect(), true);
  assert.equal(fixture.elements.get('nuclear-flash').style.opacity, '0');
  fixture.shell.dispose();
});

test('W7B extends the W6 runtime without a second gameplay state, entity registry or save system', () => {
  const source = readFileSync(resolve(repoRoot, 'src/infinite-world/experience-shell.js'), 'utf8');
  assert.match(source, /createInputController/);
  assert.match(source, /finiteWorldUnitsToMeters/);
  assert.doesNotMatch(source, /new\s+InfiniteWorldState|new\s+InfiniteWorldSaveStore|new\s+Map\s*\(/);
  assert.doesNotMatch(source, /\bplayerHp\b|\bownedScore\b|\bdestroyedStableIds\b/);
});
