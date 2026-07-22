import {
  CAM_MOUSE_ROTATION_SPEED,
  CAM_WHEEL_ZOOM_SCALE,
} from '../constants.js';
import { createInputController } from '../core/input.js';
import { finiteWorldUnitsToMeters } from './gameplay-contract.js';

const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
const money = score => `$${Math.round(score * 10_000).toLocaleString('en-US')}`;

export function createExperienceCameraState(scaleProfile) {
  const stage = scaleProfile.stage;
  return {
    yaw: 0,
    pitch: stage.cameraPitch,
    distanceMeters: scaleProfile.cameraDistanceMeters,
    verticalMeters: 0,
    verticalVelocityMetersPerSecond: 0,
    grounded: true,
    shake: 0,
  };
}

function setVisible(element, visible, display = 'flex') {
  if (element?.style) element.style.display = visible ? display : 'none';
}

export function createInfiniteExperienceShell({
  globalObject = globalThis,
  documentObject = globalObject.document,
  canvas,
  camera,
  playerMarker,
  worldState,
  initialScaleProfile,
  onAttack = () => {},
  onSave = () => {},
  onLoad = () => {},
  onHome = () => {},
  onSettingsChanged = () => {},
} = {}) {
  if (!worldState || typeof worldState.setScaleStage !== 'function') {
    throw new TypeError('experience shell requires the existing InfiniteWorldState');
  }
  const byId = id => documentObject?.getElementById?.(id) ?? null;
  const body = documentObject?.body ?? null;
  const elements = {
    start: byId('start-screen'), startButton: byId('start-button'), lobbySettings: byId('lobby-settings-btn'),
    ui: byId('ui'), crosshair: byId('crosshair'), compass: byId('compass'), compassArrow: byId('compass-arrow'),
    fps: byId('fps-counter'), score: byId('score'), scale: byId('scale-label'), hp: byId('hp-number'),
    hpFill: byId('hp-bar-fill'), atomic: byId('atomic-status'), boss: byId('boss-ui'), charge: byId('charge-ui'),
    news: byId('news-ticker'), settings: byId('settings-modal'), settingsClose: byId('settings-close-btn'),
    home: byId('set-home-btn'), reset: byId('set-reset-btn'), resume: byId('resume-overlay'),
    debug: byId('debug-modal'), debugClose: byId('debug-close-btn'), debugSummary: byId('debug-summary'),
    mouse: byId('set-mouse'), mouseValue: byId('val-mouse'), volume: byId('set-vol'), volumeValue: byId('val-vol'),
    quality: byId('set-quality'), fpsToggle: byId('set-fps-counter'), fpsCap: byId('set-fps-cap'),
    shake: byId('set-shake'), shakeValue: byId('val-shake'), finalScore: byId('final-score'),
  };
  const state = {
    mode: elements.startButton ? 'menu' : 'playing',
    paused: Boolean(elements.startButton),
    hudHidden: false,
    debugOpen: false,
    settingsOpen: false,
    camera: createExperienceCameraState(initialScaleProfile),
    settings: {
      mouseSensitivity: 1,
      volume: 0.5,
      quality: 'high',
      showFps: false,
      fpsCap: 0,
      cameraShake: 1,
    },
  };
  const removers = [];
  const listen = (target, type, listener, options) => {
    if (typeof target?.addEventListener !== 'function') return;
    target.addEventListener(type, listener, options);
    removers.push(() => target.removeEventListener?.(type, listener, options));
  };
  const requestLock = () => {
    if (documentObject?.pointerLockElement !== canvas) canvas?.requestPointerLock?.();
  };
  const leaveLock = () => documentObject?.exitPointerLock?.();

  function syncShellVisibility() {
    body?.classList?.toggle('experience-ready', true);
    body?.classList?.toggle('hud-hidden', state.hudHidden);
    body?.classList?.toggle('debug-open', state.debugOpen);
    setVisible(elements.start, state.mode === 'menu');
    setVisible(elements.ui, state.mode === 'playing');
    setVisible(elements.crosshair, state.mode === 'playing' && !state.paused, 'block');
    setVisible(elements.compass, state.mode === 'playing' && !state.paused, 'block');
    setVisible(elements.settings, state.settingsOpen);
    setVisible(elements.debug, state.debugOpen);
    setVisible(elements.resume, state.mode === 'playing' && state.paused
      && !state.settingsOpen && !state.debugOpen);
    setVisible(elements.fps, state.settings.showFps, 'block');
    setVisible(elements.boss, false);
    setVisible(elements.charge, false);
    setVisible(elements.news, false);
  }

  function resume() {
    if (state.mode !== 'playing') return;
    state.paused = false; state.settingsOpen = false; state.debugOpen = false;
    syncShellVisibility(); requestLock();
  }
  function start() { state.mode = 'playing'; resume(); }
  function openSettings() {
    state.paused = state.mode === 'playing'; state.settingsOpen = true; state.debugOpen = false;
    leaveLock(); syncShellVisibility();
  }
  function openDebug() {
    if (state.mode !== 'playing') return;
    state.paused = true; state.debugOpen = true; state.settingsOpen = false;
    leaveLock(); syncShellVisibility();
  }
  function closeDebug() { state.debugOpen = false; syncShellVisibility(); }
  function returnHome() {
    state.mode = 'menu'; state.paused = true; state.settingsOpen = false; state.debugOpen = false;
    leaveLock(); onHome(); syncShellVisibility();
  }

  listen(elements.startButton, 'click', start);
  listen(elements.lobbySettings, 'click', openSettings);
  listen(elements.settingsClose, 'click', () => (state.mode === 'playing' ? resume() : (state.settingsOpen = false, syncShellVisibility())));
  listen(elements.resume, 'click', resume);
  listen(elements.debugClose, 'click', closeDebug);
  listen(elements.home, 'click', returnHome);
  listen(elements.reset, 'click', () => { onHome(); if (state.mode === 'playing') resume(); });
  for (const button of documentObject?.querySelectorAll?.('[data-scale-stage]') ?? []) {
    listen(button, 'click', () => worldState.setScaleStage(button.dataset.scaleStage));
  }

  const setting = (element, event, apply) => listen(element, event, value => {
    apply(value.target); onSettingsChanged(Object.freeze({ ...state.settings })); syncShellVisibility();
  });
  setting(elements.mouse, 'input', target => {
    state.settings.mouseSensitivity = Number(target.value); if (elements.mouseValue) elements.mouseValue.textContent = state.settings.mouseSensitivity.toFixed(1);
  });
  setting(elements.volume, 'input', target => {
    state.settings.volume = Number(target.value); if (elements.volumeValue) elements.volumeValue.textContent = `${Math.round(state.settings.volume * 100)}%`;
  });
  setting(elements.quality, 'change', target => { state.settings.quality = target.value; });
  setting(elements.fpsToggle, 'change', target => { state.settings.showFps = target.checked === true; });
  setting(elements.fpsCap, 'change', target => { state.settings.fpsCap = Number(target.value); });
  setting(elements.shake, 'input', target => {
    state.settings.cameraShake = Number(target.value); if (elements.shakeValue) elements.shakeValue.textContent = state.settings.cameraShake.toFixed(1);
  });

  const input = createInputController({
    documentTarget: globalObject,
    windowTarget: globalObject,
    onKeyDown(event) {
      const stageId = { Digit1: 'TINY', Digit2: 'MID', Digit3: 'MAX' }[event.code];
      if (stageId) { event.preventDefault?.(); worldState.setScaleStage(stageId); }
      else if (event.code === 'Space' && !state.paused && state.camera.grounded) {
        event.preventDefault?.();
        const profile = state.lastScaleProfile ?? initialScaleProfile;
        state.camera.verticalVelocityMetersPerSecond = finiteWorldUnitsToMeters(profile.stage.jumpVelocity) * 60;
        state.camera.grounded = false;
      } else if (event.code === 'KeyQ' && !state.paused) onAttack('single');
      else if (event.code === 'KeyF' && !state.paused) onAttack('double');
      else if (event.code === 'KeyP') onSave();
      else if (event.code === 'KeyL') onLoad();
      else if (event.code === 'KeyH') { state.hudHidden = !state.hudHidden; syncShellVisibility(); }
      else if (event.code === 'Tab') { event.preventDefault?.(); state.debugOpen ? closeDebug() : openDebug(); }
      else if (event.code === 'Escape' && state.mode === 'playing') openSettings();
    },
    onMouseMove(event) {
      if (state.paused || state.mode !== 'playing') return;
      if (documentObject?.pointerLockElement !== undefined && documentObject.pointerLockElement !== canvas) return;
      const sensitivity = CAM_MOUSE_ROTATION_SPEED * state.settings.mouseSensitivity
        * (state.lastScaleProfile?.stage.cameraRotationSensitivity ?? 1);
      state.camera.yaw -= Number(event.movementX ?? 0) * sensitivity;
      const stage = (state.lastScaleProfile ?? initialScaleProfile).stage;
      state.camera.pitch = clamp(
        state.camera.pitch + Number(event.movementY ?? 0) * sensitivity,
        stage.cameraMinPitch,
        stage.cameraMaxPitch,
      );
    },
    onWheel(event) {
      const profile = state.lastScaleProfile ?? initialScaleProfile;
      state.camera.distanceMeters = clamp(
        state.camera.distanceMeters
          + finiteWorldUnitsToMeters(Number(event.deltaY ?? 0) * CAM_WHEEL_ZOOM_SCALE),
        finiteWorldUnitsToMeters(profile.stage.cameraMinDistance),
        finiteWorldUnitsToMeters(profile.stage.cameraMaxDistance),
      );
    },
    onMouseDown(event) {
      if (state.mode !== 'playing' || state.paused) return;
      if (documentObject && 'pointerLockElement' in documentObject
        && documentObject.pointerLockElement !== canvas) {
        requestLock();
        return;
      }
      if (event.button === 0) onAttack('single');
      if (event.button === 2) onAttack('double');
    },
    onPointerLockChange() {
      if (state.mode !== 'playing') return;
      if (documentObject?.pointerLockElement === canvas) resume();
      else if (!state.settingsOpen && !state.debugOpen) openSettings();
    },
  });

  function updatePlayer({ deltaSeconds, player, scaleProfile }) {
    state.lastScaleProfile = scaleProfile;
    const stage = scaleProfile.stage;
    state.camera.pitch = clamp(state.camera.pitch, stage.cameraMinPitch, stage.cameraMaxPitch);
    state.camera.distanceMeters = clamp(
      state.camera.distanceMeters,
      finiteWorldUnitsToMeters(stage.cameraMinDistance),
      finiteWorldUnitsToMeters(stage.cameraMaxDistance),
    );
    if (!state.paused) {
      const keys = input.getInputSnapshot();
      const forward = Number(keys.isPressed('KeyW')) - Number(keys.isPressed('KeyS'));
      const right = Number(keys.isPressed('KeyD')) - Number(keys.isPressed('KeyA'));
      let dx = -Math.sin(state.camera.yaw) * forward + Math.cos(state.camera.yaw) * right;
      let dz = -Math.cos(state.camera.yaw) * forward - Math.sin(state.camera.yaw) * right;
      const length = Math.hypot(dx, dz);
      if (length > 0) {
        dx /= length; dz /= length;
        const sprint = keys.isPressed('ShiftLeft') || keys.isPressed('ShiftRight');
        const speed = scaleProfile.movementMetersPerSecond * (sprint ? 1.45 : 1);
        player.x += dx * speed * deltaSeconds;
        player.z += dz * speed * deltaSeconds;
        player.facingY = Math.atan2(dx, dz);
      }
      if (!state.camera.grounded) {
        state.camera.verticalVelocityMetersPerSecond += finiteWorldUnitsToMeters(stage.gravity) * 3600 * deltaSeconds;
        state.camera.verticalMeters += state.camera.verticalVelocityMetersPerSecond * deltaSeconds;
        if (state.camera.verticalMeters <= 0) {
          state.camera.verticalMeters = 0; state.camera.verticalVelocityMetersPerSecond = 0; state.camera.grounded = true;
        }
      }
    }
    return Object.freeze({ moved: !state.paused, verticalMeters: state.camera.verticalMeters });
  }

  function updateCamera({ renderLocal, scaleProfile, unitsPerMeter }) {
    const targetY = (scaleProfile.cameraTargetHeightMeters + state.camera.verticalMeters) * unitsPerMeter;
    const horizontal = Math.cos(state.camera.pitch) * state.camera.distanceMeters * unitsPerMeter;
    const vertical = (Math.sin(state.camera.pitch) * state.camera.distanceMeters
      + scaleProfile.cameraHeightMeters) * unitsPerMeter;
    camera.position.set(
      renderLocal.x + Math.sin(state.camera.yaw) * horizontal,
      targetY + vertical,
      renderLocal.z + Math.cos(state.camera.yaw) * horizontal,
    );
    camera.near = scaleProfile.stage.cameraNear;
    camera.updateProjectionMatrix?.();
    camera.lookAt(renderLocal.x, targetY, renderLocal.z);
    playerMarker.position.y = state.camera.verticalMeters * unitsPerMeter;
  }

  function renderHud({ fps, gameplaySnapshot, runtimeSnapshot, saveStatus, renderInfo, resources }) {
    const player = gameplaySnapshot.state.player;
    const hpPercent = player.maxHp ? player.hp / player.maxHp * 100 : 0;
    if (elements.score) elements.score.textContent = money(player.score);
    if (elements.scale) elements.scale.textContent = gameplaySnapshot.state.activeScaleStageId;
    if (elements.hp) elements.hp.textContent = Math.ceil(player.hp);
    if (elements.hpFill?.style) elements.hpFill.style.width = `${clamp(hpPercent, 0, 100)}%`;
    if (elements.fps) elements.fps.textContent = `FPS: ${Math.round(fps)}`;
    if (elements.compassArrow?.style) elements.compassArrow.style.transform = `rotate(${state.camera.yaw}rad)`;
    if (elements.debugSummary) elements.debugSummary.textContent = [
      `Chunk ${runtimeSnapshot.centerChunkX},${runtimeSnapshot.centerChunkZ}  Rendered ${runtimeSnapshot.renderedCount}/9  Data ${runtimeSnapshot.activeDataCount}/25`,
      `Simulation ${gameplaySnapshot.activeSimulationChunkCount}/9  Entities ${gameplaySnapshot.simulatedEntityCount}  Targets ${gameplaySnapshot.simulatedStaticTargetCount}`,
      `Stable destruction ${gameplaySnapshot.state.destroyedFeatureCount + gameplaySnapshot.state.destroyedEntityCount}  Save ${saveStatus}`,
      `Frame p50/p95/max ${runtimeSnapshot.performance.frame.p50.toFixed(2)} / ${runtimeSnapshot.performance.frame.p95.toFixed(2)} / ${runtimeSnapshot.performance.frame.max.toFixed(2)} ms`,
      `Draw ${renderInfo?.drawCalls ?? 'n/a'}  Geometry ${renderInfo?.geometries ?? 'n/a'}  Material ${resources.sharedMaterialCount}`,
    ].join('\n');
  }

  syncShellVisibility();
  return Object.freeze({
    updatePlayer,
    updateCamera,
    renderHud,
    start,
    resume,
    openSettings,
    openDebug,
    returnHome,
    isPaused: () => state.paused,
    snapshot: () => Object.freeze({
      schemaVersion: 'w7-experience-shell-1', mode: state.mode, paused: state.paused,
      hudHidden: state.hudHidden, debugOpen: state.debugOpen,
      camera: Object.freeze({ ...state.camera }), settings: Object.freeze({ ...state.settings }),
    }),
    dispose() { input.dispose(); for (const remove of removers.splice(0)) remove(); },
  });
}
