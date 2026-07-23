import {
  CAM_MOUSE_ROTATION_SPEED,
  CAM_WHEEL_ZOOM_SCALE,
  INTRO_DURATION_MS,
} from '../constants.js';
import { createInputController } from '../core/input.js';
import {
  W7_NUCLEAR_CONTRACT,
  W8_COMBAT_COMMAND_TYPES,
  createCombatCommand,
  finiteWorldUnitsToMeters,
} from './gameplay-contract.js';
import {
  createPlayerVerticalMovementState,
  resetPlayerGrounding,
  snapshotPlayerVerticalMovement,
  stepPlayerVerticalMovement,
  tryStartPlayerJump,
} from './player-vertical-movement.js';

const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
const money = score => `$${Math.round(score * 10_000).toLocaleString('en-US')}`;
const FINITE_MAX_GAMEPLAY_START_PITCH = 0.45;

/** @typedef {'new' | 'continue'} RunStartMode */
/** @typedef {'menu' | 'intro' | 'playing' | 'dying' | 'gameover'} RunPhase */

export function createExperienceCameraState(scaleProfile) {
  const stage = scaleProfile.stage;
  return {
    yaw: 0,
    pitch: stage.cameraPitch,
    distanceMeters: scaleProfile.cameraDistanceMeters,
    shake: 0,
    shakePhase: 0,
    chargeZoom: 0,
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
  getTerrainHeightMeters,
  onAttack = () => {},
  onCombatCommand = null,
  onSave = () => {},
  onLoad = () => {},
  onHome = () => {},
  onRestart = () => {},
  onNuclearRelease = () => {},
  onSpawnManualBoss = () => {},
  onSettingsChanged = () => {},
  onStartRun = () => true,
  continueAvailable = false,
} = {}) {
  if (!worldState || typeof worldState.setScaleStage !== 'function') {
    throw new TypeError('experience shell requires the existing InfiniteWorldState');
  }
  if (typeof getTerrainHeightMeters !== 'function') {
    throw new TypeError('experience shell requires the formal Terrain height resolver');
  }
  const byId = id => documentObject?.getElementById?.(id) ?? null;
  const body = documentObject?.body ?? null;
  const persistedExperience = worldState.experience ?? {
    hudHidden: false,
    settings: {
      mouseSensitivity: 1, volume: 0.5, quality: 'high', showFps: false,
      fpsCap: 0, cameraShake: 1,
    },
  };
  const elements = {
    start: byId('start-screen'), startButton: byId('start-button'), continueButton: byId('continue-button'),
    lobbySettings: byId('lobby-settings-btn'),
    ui: byId('ui'), crosshair: byId('crosshair'), compass: byId('compass'), compassArrow: byId('compass-arrow'),
    fps: byId('fps-counter'), score: byId('score'), scale: byId('scale-label'), hp: byId('hp-number'),
    hpFill: byId('hp-bar-fill'), hpLag: byId('hp-bar-lag'), atomic: byId('atomic-status'), boss: byId('boss-ui'), charge: byId('charge-ui'),
    chargeFill: byId('charge-bar-fill'), chargeLabel: byId('charge-label'),
    bossFill: byId('boss-hp-fill'), bossDamage: byId('boss-hp-damage'), bossTitle: byId('boss-title'),
    news: byId('news-ticker'), settings: byId('settings-modal'), settingsClose: byId('settings-close-btn'),
    home: byId('set-home-btn'), reset: byId('set-reset-btn'), resume: byId('resume-overlay'),
    debug: byId('debug-modal'), debugClose: byId('debug-close-btn'), debugSummary: byId('debug-summary'),
    mouse: byId('set-mouse'), mouseValue: byId('val-mouse'), volume: byId('set-vol'), volumeValue: byId('val-vol'),
    quality: byId('set-quality'), fpsToggle: byId('set-fps-counter'), fpsCap: byId('set-fps-cap'),
    shake: byId('set-shake'), shakeValue: byId('val-shake'), finalScore: byId('final-score'),
    gameOver: byId('game-over'), restart: byId('restart-button'),
    spawnBoss: byId('debug-spawn-boss-btn'),
    developerTools: byId('set-developer-tools'),
    developerSection: byId('developer-tools-section'),
    nuclearFlash: byId('nuclear-flash'),
    scaleButtons: [...(documentObject?.querySelectorAll?.('[data-scale-stage]') ?? [])],
  };
  const state = {
    mode: elements.startButton ? 'menu' : 'playing',
    paused: Boolean(elements.startButton),
    hudHidden: persistedExperience.hudHidden,
    debugOpen: false,
    settingsOpen: false,
    bossActive: false,
    threatActive: false,
    newsActive: false,
    attackButtons: new Set(),
    nuclearChargeStartedAt: null,
    canNuclearCharge: false,
    camera: createExperienceCameraState(initialScaleProfile),
    playerVertical: createPlayerVerticalMovementState(),
    jumpHeld: false,
    lastPlayer: null,
    lastScaleProfile: initialScaleProfile,
    settings: { ...persistedExperience.settings },
    suppressedMouseUps: new Set(),
    runPhase: elements.startButton ? 'menu' : 'playing',
    runStartMode: null,
    gameplayTimeMs: 0,
    deathStartedAtMs: null,
    startPending: false,
    continueAvailable: continueAvailable === true,
    bossLastHpPercent: 100,
    bossDamagePercent: 100,
    bossDamageTargetPercent: 100,
    bossDamageDelayUntil: 0,
  };
  const removers = [];
  const developerToolsEnabled = () => worldState.developerTools === true
    || typeof worldState.setDeveloperTools !== 'function'
    || elements.developerTools === null;
  const listen = (target, type, listener, options) => {
    if (typeof target?.addEventListener !== 'function') return;
    target.addEventListener(type, listener, options);
    removers.push(() => target.removeEventListener?.(type, listener, options));
  };
  const requestLock = () => {
    if (documentObject?.pointerLockElement !== canvas) {
      try {
        const request = canvas?.requestPointerLock?.();
        request?.catch?.(() => {});
      } catch { /* unavailable in automation or embedded documents */ }
    }
  };
  const leaveLock = () => documentObject?.exitPointerLock?.();

  function syncShellVisibility() {
    body?.classList?.toggle('experience-ready', true);
    body?.classList?.toggle('hud-hidden', state.hudHidden);
    body?.classList?.toggle('debug-open', state.debugOpen);
    setVisible(elements.start, state.mode === 'menu');
    setVisible(elements.ui, state.mode === 'playing', 'block');
    setVisible(elements.crosshair, state.runPhase === 'playing' && !state.paused, 'block');
    setVisible(elements.compass, state.runPhase === 'playing' && !state.paused && state.threatActive, 'block');
    setVisible(elements.settings, state.settingsOpen);
    setVisible(elements.debug, state.debugOpen);
    setVisible(elements.developerSection, true, 'block');
    setVisible(elements.resume, state.mode === 'playing' && state.paused
      && !state.settingsOpen && !state.debugOpen);
    setVisible(elements.fps, state.settings.showFps, 'block');
    setVisible(elements.boss, state.runPhase === 'playing' && state.bossActive);
    setVisible(elements.charge, state.runPhase === 'playing' && state.nuclearChargeStartedAt !== null);
    setVisible(elements.news, state.runPhase === 'playing' && state.newsActive);
    setVisible(elements.gameOver, state.mode === 'gameover');
    if (elements.continueButton) {
      elements.continueButton.disabled = !state.continueAvailable || state.startPending;
      setVisible(elements.continueButton, state.continueAvailable, 'block');
    }
    if (elements.startButton) elements.startButton.disabled = state.startPending;
  }

  function syncSettingsControls() {
    if (elements.mouse) elements.mouse.value = String(state.settings.mouseSensitivity);
    if (elements.mouseValue) elements.mouseValue.textContent = state.settings.mouseSensitivity.toFixed(1);
    if (elements.volume) elements.volume.value = String(state.settings.volume);
    if (elements.volumeValue) elements.volumeValue.textContent = `${Math.round(state.settings.volume * 100)}%`;
    if (elements.quality) elements.quality.value = state.settings.quality;
    if (elements.fpsToggle) elements.fpsToggle.checked = state.settings.showFps;
    if (elements.fpsCap) elements.fpsCap.value = String(state.settings.fpsCap);
    if (elements.shake) elements.shake.value = String(state.settings.cameraShake);
    if (elements.shakeValue) elements.shakeValue.textContent = state.settings.cameraShake.toFixed(1);
    if (elements.developerTools) elements.developerTools.checked = worldState.developerTools === true;
  }

  function persistExperience(patch) {
    if (typeof worldState.updateExperience === 'function') worldState.updateExperience(patch);
  }

  function resetPlayerVerticalMovement({
    player = state.lastPlayer,
    scaleProfile = state.lastScaleProfile ?? initialScaleProfile,
  } = {}) {
    if (!player) {
      Object.assign(state.playerVertical, createPlayerVerticalMovementState());
      return snapshotPlayerVerticalMovement(state.playerVertical);
    }
    state.lastPlayer = player;
    state.lastScaleProfile = scaleProfile;
    return resetPlayerGrounding(state.playerVertical, {
      terrainHeightMeters: getTerrainHeightMeters(player.x, player.z),
      scaleProfile,
    });
  }

  function resume() {
    if (state.mode !== 'playing') return;
    state.paused = false; state.settingsOpen = false; state.debugOpen = false;
    syncShellVisibility(); requestLock();
  }
  function resetFiniteGameplayStartCamera({ cameraYaw } = {}) {
    const profile = state.lastScaleProfile ?? initialScaleProfile;
    if (Number.isFinite(cameraYaw)) state.camera.yaw = cameraYaw;
    state.camera.distanceMeters = profile.cameraDistanceMeters;
    state.camera.pitch = profile.stage.id === 'MAX'
      ? FINITE_MAX_GAMEPLAY_START_PITCH : profile.stage.cameraPitch;
    state.camera.shake = 0;
    state.camera.chargeZoom = 0;
  }
  function enterRun(startMode, runConfiguration = {}) {
    state.mode = 'playing';
    state.runPhase = 'intro';
    state.runStartMode = startMode;
    state.gameplayTimeMs = 0;
    state.deathStartedAtMs = null;
    state.startPending = false;
    resetFiniteGameplayStartCamera(runConfiguration);
    resetPlayerVerticalMovement();
    resume();
    return true;
  }
  function start(startMode = 'new', options = {}) {
    if (!['new', 'continue'].includes(startMode)) throw new RangeError('start mode must be new or continue');
    if (state.startPending || (startMode === 'continue' && !state.continueAvailable)) return false;
    state.startPending = true;
    syncShellVisibility();
    let result;
    try { result = onStartRun(startMode, options); }
    catch (error) { state.startPending = false; syncShellVisibility(); throw error; }
    if (result?.then) {
      return result.then(accepted => {
        if (accepted === false) {
          state.startPending = false; syncShellVisibility(); return false;
        }
        return enterRun(startMode, accepted && typeof accepted === 'object' ? accepted : {});
      }, error => {
        state.startPending = false; syncShellVisibility(); throw error;
      });
    }
    if (result === false) { state.startPending = false; syncShellVisibility(); return false; }
    return enterRun(startMode, result && typeof result === 'object' ? result : {});
  }
  function openSettings() {
    state.paused = state.mode === 'playing'; state.settingsOpen = true; state.debugOpen = false;
    leaveLock(); syncShellVisibility();
  }
  function openDebug() {
    if (state.mode !== 'playing') return;
    state.paused = true; state.debugOpen = true; state.settingsOpen = false;
    leaveLock(); syncShellVisibility();
  }
  function closeDebug() {
    state.debugOpen = false;
    if (state.mode === 'playing') resume();
    else syncShellVisibility();
  }
  async function returnHome() {
    state.mode = 'menu'; state.runPhase = 'menu'; state.paused = true;
    state.settingsOpen = false; state.debugOpen = false;
    leaveLock(); syncShellVisibility();
    await onHome();
    resetPlayerVerticalMovement();
  }
  async function restart() {
    const runConfiguration = await onRestart();
    state.mode = 'playing';
    state.runPhase = 'intro';
    state.runStartMode = 'new';
    state.gameplayTimeMs = 0;
    state.deathStartedAtMs = null;
    state.paused = false;
    resetPlayerVerticalMovement();
    resetFiniteGameplayStartCamera(
      runConfiguration && typeof runConfiguration === 'object' ? runConfiguration : {},
    );
    syncShellVisibility();
    requestLock();
  }

  listen(elements.startButton, 'click', () => { void start('new'); });
  listen(elements.continueButton, 'click', () => { void start('continue'); });
  listen(elements.lobbySettings, 'click', openSettings);
  listen(elements.settingsClose, 'click', () => (state.mode === 'playing' ? resume() : (state.settingsOpen = false, syncShellVisibility())));
  listen(elements.resume, 'click', resume);
  listen(elements.debugClose, 'click', closeDebug);
  listen(elements.home, 'click', () => { void returnHome(); });
  listen(elements.restart, 'click', () => { void restart(); });
  listen(elements.spawnBoss, 'click', () => {
    if (developerToolsEnabled()) void onSpawnManualBoss();
  });
  listen(elements.reset, 'click', () => {
    void Promise.resolve(onHome()).then(() => {
      resetPlayerVerticalMovement();
      if (state.mode === 'playing') resume();
    });
  });
  for (const button of documentObject?.querySelectorAll?.('[data-scale-stage]') ?? []) {
    listen(button, 'click', () => worldState.setScaleStage(button.dataset.scaleStage));
  }

  const setting = (element, event, apply) => listen(element, event, value => {
    apply(value.target);
    persistExperience({ settings: state.settings });
    onSettingsChanged(Object.freeze({ ...state.settings }));
    syncShellVisibility();
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
  listen(elements.developerTools, 'change', event => {
    worldState.setDeveloperTools?.(event.target.checked === true);
    syncShellVisibility();
  });

  function emitCombat(type, options = {}) {
    const aimHeading = Math.atan2(-Math.sin(state.camera.yaw), -Math.cos(state.camera.yaw));
    if (state.lastPlayer) state.lastPlayer.facingY = aimHeading;
    worldState.updatePlayer?.({ facingY: aimHeading });
    if (typeof onCombatCommand === 'function') {
      return onCombatCommand(createCombatCommand(type, options));
    }
    const legacyMode = type === W8_COMBAT_COMMAND_TYPES.BOTH ? 'double' : 'single';
    return onAttack(legacyMode);
  }

  const input = createInputController({
    documentTarget: globalObject,
    windowTarget: globalObject,
    onKeyDown(event) {
      const stageId = { Digit1: 'TINY', Digit2: 'MID', Digit3: 'MAX' }[event.code];
      if (stageId && state.debugOpen) { event.preventDefault?.(); worldState.setScaleStage(stageId); }
      else if (event.code === 'Space') {
        event.preventDefault?.();
        const canStart = !state.jumpHeld && !state.paused && state.runPhase === 'playing';
        state.jumpHeld = true;
        if (canStart) tryStartPlayerJump(state.playerVertical, state.lastScaleProfile ?? initialScaleProfile);
      } else if (event.code === 'KeyQ' && !state.paused && state.runPhase === 'playing' && developerToolsEnabled()) {
        emitCombat(W8_COMBAT_COMMAND_TYPES.RIGHT);
      } else if (event.code === 'KeyF' && !state.paused && state.runPhase === 'playing' && developerToolsEnabled()) {
        emitCombat(W8_COMBAT_COMMAND_TYPES.BOTH);
      }
      else if (event.code === 'KeyP' && developerToolsEnabled()) onSave();
      else if (event.code === 'KeyL' && developerToolsEnabled()) onLoad();
      else if (event.code === 'KeyH') {
        state.hudHidden = !state.hudHidden;
        persistExperience({ hudHidden: state.hudHidden });
        syncShellVisibility();
      }
      else if (event.code === 'Tab') {
        event.preventDefault?.(); state.debugOpen ? closeDebug() : openDebug();
      }
      else if (event.code === 'Escape' && state.mode === 'playing') openSettings();
    },
    onKeyUp(event) {
      if (event.code === 'Space') state.jumpHeld = false;
    },
    onMouseMove(event) {
      if (state.paused || state.runPhase !== 'playing') return;
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
      if (state.runPhase === 'intro') return;
      const profile = state.lastScaleProfile ?? initialScaleProfile;
      state.camera.distanceMeters = clamp(
        state.camera.distanceMeters
          + finiteWorldUnitsToMeters(Number(event.deltaY ?? 0) * CAM_WHEEL_ZOOM_SCALE),
        finiteWorldUnitsToMeters(profile.stage.cameraMinDistance),
        finiteWorldUnitsToMeters(profile.stage.cameraMaxDistance),
      );
    },
    onMouseDown(event) {
      if (state.runPhase !== 'playing' || state.paused) return;
      if (documentObject && 'pointerLockElement' in documentObject
        && documentObject.pointerLockElement !== canvas) {
        requestLock();
        return;
      }
      if (event.button !== 0 && event.button !== 2) return;
      state.attackButtons.add(event.button);
      if (state.attackButtons.has(0) && state.attackButtons.has(2)) {
        const chargeEligible = typeof onCombatCommand !== 'function' || state.canNuclearCharge;
        if (state.nuclearChargeStartedAt === null && chargeEligible) {
          state.nuclearChargeStartedAt = globalObject.performance?.now?.() ?? Date.now();
          if (typeof onCombatCommand === 'function') emitCombat(W8_COMBAT_COMMAND_TYPES.CHARGE_START);
          syncShellVisibility();
        } else if (!chargeEligible) {
          state.suppressedMouseUps.add(0); state.suppressedMouseUps.add(2);
          emitCombat(W8_COMBAT_COMMAND_TYPES.BOTH);
        }
      }
    },
    onMouseUp(event) {
      if (event.button !== 0 && event.button !== 2) return;
      if (state.suppressedMouseUps.delete(event.button)) {
        state.attackButtons.delete(event.button);
        return;
      }
      const wasCharging = state.nuclearChargeStartedAt !== null;
      const releasedAt = globalObject.performance?.now?.() ?? Date.now();
      const chargeMs = wasCharging ? releasedAt - state.nuclearChargeStartedAt : 0;
      state.attackButtons.delete(event.button);
      if (wasCharging) {
        state.attackButtons.clear();
        state.nuclearChargeStartedAt = null;
        if (chargeMs >= W7_NUCLEAR_CONTRACT.chargeThresholdMs) {
          void onNuclearRelease({ airborne: !state.playerVertical.grounded, chargeMs });
        } else {
          emitCombat(W8_COMBAT_COMMAND_TYPES.BOTH, { issuedAt: releasedAt });
        }
        syncShellVisibility();
      } else if (state.runPhase === 'playing' && !state.paused) {
        emitCombat(event.button === 0
          ? W8_COMBAT_COMMAND_TYPES.LEFT : W8_COMBAT_COMMAND_TYPES.RIGHT, { issuedAt: releasedAt });
      }
    },
    onPointerLockChange() {
      if (state.mode !== 'playing') return;
      if (documentObject?.pointerLockElement === canvas) resume();
      else if (!state.settingsOpen && !state.debugOpen) openSettings();
    },
  });

  function updatePlayer({ deltaSeconds, player, scaleProfile }) {
    const previousStageId = state.lastScaleProfile?.stage?.id;
    state.lastPlayer = player;
    state.lastScaleProfile = scaleProfile;
    const stage = scaleProfile.stage;
    if (previousStageId !== stage.id) {
      state.camera.pitch = stage.cameraPitch;
      state.camera.distanceMeters = scaleProfile.cameraDistanceMeters;
      state.camera.shake = 0;
      state.camera.chargeZoom = 0;
    } else {
      state.camera.pitch = clamp(state.camera.pitch, stage.cameraMinPitch, stage.cameraMaxPitch);
      state.camera.distanceMeters = clamp(
        state.camera.distanceMeters,
        finiteWorldUnitsToMeters(stage.cameraMinDistance),
        finiteWorldUnitsToMeters(stage.cameraMaxDistance),
      );
    }
    if (!state.paused && ['intro', 'playing', 'dying'].includes(state.runPhase)) {
      state.gameplayTimeMs += deltaSeconds * 1000;
      if (state.runPhase === 'intro' && state.gameplayTimeMs >= INTRO_DURATION_MS) {
        state.runPhase = 'playing';
        syncShellVisibility();
      }
    }
    if (!state.paused && ['intro', 'playing'].includes(state.runPhase)) {
      const keys = input.getInputSnapshot();
      const intro = state.runPhase === 'intro';
      const forward = intro ? 1 : Number(keys.isPressed('KeyW')) - Number(keys.isPressed('KeyS'));
      const right = intro ? 0 : Number(keys.isPressed('KeyD')) - Number(keys.isPressed('KeyA'));
      let dx = -Math.sin(state.camera.yaw) * forward + Math.cos(state.camera.yaw) * right;
      let dz = -Math.cos(state.camera.yaw) * forward - Math.sin(state.camera.yaw) * right;
      const length = Math.hypot(dx, dz);
      if (length > 0) {
        dx /= length; dz /= length;
        const sprint = keys.isPressed('ShiftLeft') || keys.isPressed('ShiftRight');
        const speed = scaleProfile.movementMetersPerSecond * (intro ? 0.35 : sprint ? 1.45 : 1);
        player.x += dx * speed * deltaSeconds;
        player.z += dz * speed * deltaSeconds;
        player.facingY = Math.atan2(dx, dz);
      }
    }
    const vertical = stepPlayerVerticalMovement(state.playerVertical, {
      deltaSeconds: state.paused ? 0 : deltaSeconds,
      terrainHeightMeters: getTerrainHeightMeters(player.x, player.z),
      scaleProfile,
    });
    return Object.freeze({ moved: !state.paused, vertical });
  }

  function updateCamera({
    renderLocal, scaleProfile, unitsPerMeter, playerPresentationOffsetMeters = 0,
  }) {
    const playerRootY = (state.playerVertical.rootY ?? state.playerVertical.groundRootY ?? 0)
      + playerPresentationOffsetMeters;
    const targetY = (scaleProfile.cameraTargetHeightMeters + playerRootY) * unitsPerMeter;
    const now = globalObject.performance?.now?.() ?? Date.now();
    const chargeRatio = state.nuclearChargeStartedAt === null ? 0 : clamp(
      (now - state.nuclearChargeStartedAt - 250) / W7_NUCLEAR_CONTRACT.chargeThresholdMs,
      0,
      1,
    );
    const targetChargeZoom = chargeRatio * 0.12;
    state.camera.chargeZoom += (targetChargeZoom - state.camera.chargeZoom)
      * (state.nuclearChargeStartedAt === null ? 0.12 : 0.15);
    const activeDistanceMeters = state.camera.distanceMeters * (1 - state.camera.chargeZoom);
    const horizontal = Math.cos(state.camera.pitch) * activeDistanceMeters * unitsPerMeter;
    const vertical = (Math.sin(state.camera.pitch) * activeDistanceMeters
      + scaleProfile.cameraHeightMeters) * unitsPerMeter;
    state.camera.shakePhase += 1.61803398875;
    const shakeRender = state.camera.shake * state.settings.cameraShake * unitsPerMeter;
    const shakeX = Math.sin(state.camera.shakePhase * 2.31) * shakeRender;
    const shakeY = Math.sin(state.camera.shakePhase * 3.17) * shakeRender * 0.55;
    const shakeZ = Math.cos(state.camera.shakePhase * 1.87) * shakeRender;
    state.camera.shake *= 0.88;
    if (state.camera.shake < 0.001) state.camera.shake = 0;
    const targetCamera = {
      x: renderLocal.x + Math.sin(state.camera.yaw) * horizontal + shakeX,
      y: playerRootY * unitsPerMeter + vertical + shakeY,
      z: renderLocal.z + Math.cos(state.camera.yaw) * horizontal + shakeZ,
    };
    let lookAtY = targetY;
    if (state.runPhase === 'intro') {
      const introT = clamp(state.gameplayTimeMs / INTRO_DURATION_MS, 0, 1);
      const panT = Math.min(1, introT / 0.15);
      const eased = introT < 0.3 ? 0 : ((introT - 0.3) / 0.7) ** 2;
      const trackX = finiteWorldUnitsToMeters(150 + 50 * Math.sin(panT * Math.PI / 2));
      const trackY = finiteWorldUnitsToMeters(10 + 10 * Math.sin(panT * Math.PI / 2));
      const trackZ = finiteWorldUnitsToMeters(300 + 80 * Math.sin(panT * Math.PI / 2));
      const facing = state.lastPlayer?.facingY ?? 0;
      const cosine = Math.cos(facing); const sine = Math.sin(facing);
      const trackCamera = {
        x: renderLocal.x + (trackX * cosine + trackZ * sine) * unitsPerMeter
          + Math.sin(state.gameplayTimeMs * 0.0025) * finiteWorldUnitsToMeters(3) * unitsPerMeter * (1 - eased),
        y: (playerRootY + trackY) * unitsPerMeter
          + Math.cos(state.gameplayTimeMs * 0.0032) * finiteWorldUnitsToMeters(2) * unitsPerMeter * (1 - eased),
        z: renderLocal.z + (-trackX * sine + trackZ * cosine) * unitsPerMeter,
      };
      camera.position.set(
        trackCamera.x + (targetCamera.x - trackCamera.x) * eased,
        trackCamera.y + (targetCamera.y - trackCamera.y) * eased,
        trackCamera.z + (targetCamera.z - trackCamera.z) * eased,
      );
      const trackLookAtY = (playerRootY + finiteWorldUnitsToMeters(
        40 + 30 * Math.sin(panT * Math.PI / 2),
      )) * unitsPerMeter;
      lookAtY = trackLookAtY + (targetY - trackLookAtY) * eased;
    } else camera.position.set(targetCamera.x, targetCamera.y, targetCamera.z);
    camera.near = finiteWorldUnitsToMeters(scaleProfile.stage.cameraNear) * unitsPerMeter;
    camera.updateProjectionMatrix?.();
    camera.lookAt(renderLocal.x, lookAtY, renderLocal.z);
    playerMarker.position.y = playerRootY * unitsPerMeter;
  }

  function renderHud({
    fps, gameplaySnapshot, runtimeSnapshot, presentationSnapshot = null,
    saveStatus, renderInfo, resources,
  }) {
    const savedExperience = gameplaySnapshot.state.experience;
    if (savedExperience) {
      const settingsChanged = Object.entries(savedExperience.settings)
        .some(([key, value]) => state.settings[key] !== value);
      state.hudHidden = savedExperience.hudHidden;
      if (settingsChanged) {
        state.settings = { ...savedExperience.settings };
        syncSettingsControls();
        onSettingsChanged(Object.freeze({ ...state.settings }));
      }
    }
    const player = gameplaySnapshot.state.player;
    for (const button of elements.scaleButtons) {
      button.classList?.toggle?.(
        'debug-on',
        button.dataset?.scaleStage === gameplaySnapshot.state.activeScaleStageId,
      );
    }
    const hpPercent = player.maxHp ? player.hp / player.maxHp * 100 : 0;
    if (elements.score) elements.score.textContent = money(player.score);
    if (elements.scale) elements.scale.textContent = gameplaySnapshot.state.activeScaleStageId;
    if (elements.hp) elements.hp.textContent = Math.ceil(player.hp);
    if (elements.hpFill?.style) elements.hpFill.style.width = `${clamp(hpPercent, 0, 100)}%`;
    if (elements.hpLag?.style) elements.hpLag.style.width = `${clamp(hpPercent, 0, 100)}%`;
    if (elements.fps) elements.fps.textContent = `FPS: ${Math.round(fps)}`;
    if (elements.compassArrow?.style) {
      elements.compassArrow.style.transform = `translate(-50%,-60%) rotate(${state.camera.yaw}rad)`;
    }
    const boss = gameplaySnapshot.state.manualBoss;
    state.bossActive = boss?.alive === true;
    state.threatActive = state.bossActive || gameplaySnapshot.activeTankCount > 0;
    state.canNuclearCharge = gameplaySnapshot.state.activeScaleStageId === W7_NUCLEAR_CONTRACT.allowedScaleStageId
      && (gameplaySnapshot.state.nuclearCooldownMs ?? 0) <= 0
      && !state.playerVertical.grounded;
    state.newsActive = state.bossActive;
    if (elements.bossFill?.style && boss) {
      const bossPercent = clamp(boss.hp / boss.maxHp * 100, 0, 100);
      const now = globalObject.performance?.now?.() ?? Date.now();
      if (!state.bossActive || bossPercent > state.bossLastHpPercent) {
        state.bossDamagePercent = bossPercent;
        state.bossDamageTargetPercent = bossPercent;
      } else if (bossPercent < state.bossLastHpPercent) {
        state.bossDamageTargetPercent = bossPercent;
        state.bossDamageDelayUntil = now + 500;
      }
      if (now >= state.bossDamageDelayUntil) state.bossDamagePercent = state.bossDamageTargetPercent;
      state.bossLastHpPercent = bossPercent;
      elements.bossFill.style.width = `${bossPercent}%`;
      if (elements.bossDamage?.style) {
        elements.bossDamage.style.width = `${state.bossDamagePercent}%`;
      }
    } else if (!boss) {
      state.bossLastHpPercent = 100;
      state.bossDamagePercent = 100;
      state.bossDamageTargetPercent = 100;
      state.bossDamageDelayUntil = 0;
    }
    if (elements.bossTitle && boss) {
      elements.bossTitle.textContent = boss.hp / boss.maxHp <= 0.5
        ? '【狂暴怒り】ギガ・ミミズ' : 'ギガ・ミミズ';
    }
    const cooldownMs = gameplaySnapshot.state.nuclearCooldownMs ?? 0;
    if (elements.atomic) {
      elements.atomic.textContent = gameplaySnapshot.state.activeScaleStageId !== W7_NUCLEAR_CONTRACT.allowedScaleStageId
        ? 'ATOMIC: MAX SCALE ONLY'
        : cooldownMs > 0 ? `ATOMIC CD: ${(cooldownMs / 1000).toFixed(1)}s` : 'ATOMIC: READY';
      elements.atomic.classList?.toggle?.('inactive', cooldownMs > 0
        || gameplaySnapshot.state.activeScaleStageId !== W7_NUCLEAR_CONTRACT.allowedScaleStageId);
    }
    if (state.nuclearChargeStartedAt !== null) {
      const elapsed = (globalObject.performance?.now?.() ?? Date.now()) - state.nuclearChargeStartedAt;
      const progress = clamp(elapsed / W7_NUCLEAR_CONTRACT.chargeThresholdMs, 0, 1);
      if (elements.chargeFill?.style) elements.chargeFill.style.width = `${progress * 100}%`;
      if (elements.chargeLabel) elements.chargeLabel.textContent = progress >= 1
        ? 'AIR RELEASE TO DETONATE' : 'ATOMIC CHARGING...';
    }
    if (elements.spawnBoss) {
      elements.spawnBoss.disabled = state.bossActive || !developerToolsEnabled();
      elements.spawnBoss.textContent = state.bossActive
        ? 'BOSS ACTIVE'
        : developerToolsEnabled() ? 'SPAWN MANUAL BOSS' : 'ENABLE IN SETTINGS';
    }
    syncShellVisibility();
    if (player.hp <= 0 && ['intro', 'playing'].includes(state.runPhase)) {
      state.runPhase = 'dying';
      state.deathStartedAtMs = state.gameplayTimeMs;
      state.attackButtons.clear();
      state.nuclearChargeStartedAt = null;
      syncShellVisibility();
    }
    if (state.runPhase === 'dying'
      && state.gameplayTimeMs - state.deathStartedAtMs >= 3_000) {
      state.mode = 'gameover'; state.runPhase = 'gameover'; state.paused = true;
      leaveLock();
      if (elements.finalScore) elements.finalScore.textContent = money(player.score);
      syncShellVisibility();
    }
    if (elements.debugSummary) elements.debugSummary.textContent = [
      `Chunk ${runtimeSnapshot.centerChunkX},${runtimeSnapshot.centerChunkZ}  Rendered ${runtimeSnapshot.renderedCount}/9  Data ${runtimeSnapshot.activeDataCount}/25`,
      `Midground ${presentationSnapshot?.midgroundChunkCount ?? 0}/16  Clipmap ${presentationSnapshot?.clipmapMeshCount ?? 0}/1`,
      `Simulation ${gameplaySnapshot.activeSimulationChunkCount}/9  Entities ${gameplaySnapshot.simulatedEntityCount}  Targets ${gameplaySnapshot.simulatedStaticTargetCount}`,
      `Stable destruction ${gameplaySnapshot.state.destroyedFeatureCount + gameplaySnapshot.state.destroyedEntityCount}  Save ${saveStatus}`,
      `Frame p50/p95/max ${runtimeSnapshot.performance.frame.p50.toFixed(2)} / ${runtimeSnapshot.performance.frame.p95.toFixed(2)} / ${runtimeSnapshot.performance.frame.max.toFixed(2)} ms`,
      `Draw ${renderInfo?.drawCalls ?? 'n/a'}  Geometry ${renderInfo?.geometries ?? 'n/a'}  Material ${resources.sharedMaterialCount}`,
    ].join('\n');
  }

  syncSettingsControls();
  syncShellVisibility();
  return Object.freeze({
    updatePlayer,
    updateCamera,
    resetPlayerVerticalMovement,
    renderHud,
    applyCameraShake(amountFiniteWorldUnits) {
      const amountMeters = finiteWorldUnitsToMeters(amountFiniteWorldUnits);
      state.camera.shake = Math.max(state.camera.shake, amountMeters);
      return state.camera.shake;
    },
    triggerNuclearEffect() {
      if (!elements.nuclearFlash?.style) return false;
      elements.nuclearFlash.style.opacity = '1';
      globalObject.setTimeout?.(() => { elements.nuclearFlash.style.opacity = '0'; }, 300);
      return true;
    },
    start,
    resume,
    openSettings,
    openDebug,
    returnHome,
    isPaused: () => state.paused,
    getMode: () => state.mode,
    getRunPhase: () => state.runPhase,
    setContinueAvailable(available) {
      state.continueAvailable = available === true;
      syncShellVisibility();
      return state.continueAvailable;
    },
    snapshot: () => Object.freeze({
      schemaVersion: 'w8-experience-shell-2', mode: state.mode, runPhase: state.runPhase,
      runStartMode: state.runStartMode,
      gameplayTimeMs: state.gameplayTimeMs,
      persistentGameplayTimeMs: worldState.gameplayTimeMs ?? state.gameplayTimeMs,
      paused: state.paused,
      hudHidden: state.hudHidden, debugOpen: state.debugOpen,
      camera: Object.freeze({ ...state.camera }),
      playerVertical: snapshotPlayerVerticalMovement(state.playerVertical),
      settings: Object.freeze({ ...state.settings }),
    }),
    dispose() { input.dispose(); for (const remove of removers.splice(0)) remove(); },
  });
}
