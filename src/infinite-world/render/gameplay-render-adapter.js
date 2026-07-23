import {
  LOGICAL_CHUNK_SIZE_METERS,
  RENDER_CHUNK_SIZE,
  chunkRenderPosition,
  createChunkKey,
  logicalWorldToRenderLocal,
  parseChunkKey,
} from '../chunk-coordinates.js';
import {
  PRODUCTION_VISUAL_UNITS_PER_METER,
  createProductionVisualAssetLibrary,
} from './production-visual-assets.js';
import { W7_NUCLEAR_CONTRACT } from '../gameplay-contract.js';

function requireConstructor(THREE, name) {
  if (typeof THREE?.[name] !== 'function') throw new TypeError(`THREE.${name} is required`);
  return THREE[name];
}

export class GameplayRenderAdapter {
  constructor({ THREE, scene, renderChunkSize = RENDER_CHUNK_SIZE, visualAssets = null } = {}) {
    if (!scene || typeof scene.add !== 'function' || typeof scene.remove !== 'function') {
      throw new TypeError('a Three.js scene is required');
    }
    const Group = requireConstructor(THREE, 'Group');
    this.THREE = THREE;
    this.scene = scene;
    this.renderChunkSize = renderChunkSize;
    this.unitsPerMeter = renderChunkSize / LOGICAL_CHUNK_SIZE_METERS;
    this.origin = { renderOriginChunkX: 0, renderOriginChunkZ: 0 };
    this.root = new Group();
    this.root.name = 'w6-gameplay-root';
    this.scene.add(this.root);
    this.combatRoot = new Group();
    this.combatRoot.name = 'w7-core-combat-root';
    this.scene.add(this.combatRoot);
    this.visualAssets = visualAssets ?? createProductionVisualAssetLibrary({ THREE });
    this.ownsVisualAssets = visualAssets === null;
    this.loaded = new Map();
    this.entityMeshes = new Map();
    this.projectileMeshes = new Map();
    this.effectMeshes = new Map();
    this.presentationPool = [];
    this.activePresentationEffects = [];
    this.presentationPoolLimit = 96;
    this.playerPresentation = null;
    this.playerAttackPresentation = { left: null, right: null, charging: false };
    this.playerChargePhase = 0;
    this.playerChargeElapsedSeconds = 0;
    this.playerLocomotionY = 0;
    this.playerPresentationOffsetUnits = { x: 0, y: 0, z: 0 };
    this.manualBossEntry = null;
    this.reinforcementMeshes = new Map();
    this.disposed = false;
    this.counts = {
      loaded: 0, unloaded: 0, created: 0, removed: 0, rebased: 0,
      transientCreated: 0, transientRemoved: 0,
    };
  }

  #scaleMesh(mesh, state) {
    const finiteUnitScale = this.unitsPerMeter / PRODUCTION_VISUAL_UNITS_PER_METER;
    const visualScale = Number(mesh.userData.productionVisualScale ?? 1);
    mesh.scale.set(
      finiteUnitScale * visualScale,
      finiteUnitScale * visualScale,
      finiteUnitScale * visualScale,
    );
  }

  #positionGroup(entry) {
    const position = chunkRenderPosition(
      entry.chunkX,
      entry.chunkZ,
      this.origin.renderOriginChunkX,
      this.origin.renderOriginChunkZ,
      this.renderChunkSize,
    );
    entry.group.position.set(position.x, 0, position.z);
  }

  #positionMesh(mesh, state, entry) {
    const localX = state.x - entry.chunkX * LOGICAL_CHUNK_SIZE_METERS;
    const localZ = state.z - entry.chunkZ * LOGICAL_CHUNK_SIZE_METERS;
    mesh.position.set(
      localX * this.unitsPerMeter,
      0,
      localZ * this.unitsPerMeter,
    );
    mesh.rotation.y = state.rotationY;
    mesh.visible = state.alive && (state.type !== 'tank' || state.spawned === true);
    const parts = mesh.userData.presentationParts;
    if (state.type === 'human' && parts) {
      mesh.rotation.z = state.aiState === 'fallen' ? Math.PI / 2 : 0;
      const stride = Math.sin(state.aiClock * (state.aiState === 'flee' ? 13 : 6)) * 0.48;
      parts.leftArm.rotation.x = stride;
      parts.rightArm.rotation.x = -stride;
      parts.leftLeg.rotation.x = -stride;
      parts.rightLeg.rotation.x = stride;
    }
    if (state.type === 'tank' && parts) {
      const relativeTurret = (state.turretRotationY ?? state.rotationY) - state.rotationY;
      if (parts.turret) parts.turret.rotation.y = relativeTurret;
      if (parts.gun) {
        parts.gun.rotation.y = relativeTurret;
        parts.gun.rotation.x = state.gunPitch ?? 0;
      }
    }
  }

  async rebase(origin) {
    if (this.disposed) throw new Error('gameplay render adapter is shut down');
    this.origin = {
      renderOriginChunkX: origin.renderOriginChunkX,
      renderOriginChunkZ: origin.renderOriginChunkZ,
    };
    for (const entry of this.loaded.values()) this.#positionGroup(entry);
    for (const entry of this.projectileMeshes.values()) this.#positionTransient(entry);
    for (const entry of this.effectMeshes.values()) this.#positionTransient(entry);
    if (this.manualBossEntry) this.#positionManualBoss();
    for (const entry of this.reinforcementMeshes.values()) this.#positionReinforcement(entry);
    this.counts.rebased += 1;
  }

  #positionTransient(entry) {
    const local = logicalWorldToRenderLocal(
      entry.state.x,
      entry.state.z,
      this.origin.renderOriginChunkX,
      this.origin.renderOriginChunkZ,
      this.renderChunkSize,
    );
    entry.mesh.position.set(local.x, entry.height, local.z);
  }

  #syncTransientSet(map, states, createMesh) {
    const desired = new Set(states.map(state => state.id));
    for (const [id, entry] of map) {
      if (desired.has(id)) continue;
      this.combatRoot.remove(entry.mesh);
      map.delete(id);
      this.counts.transientRemoved += 1;
    }
    for (const state of states) {
      let entry = map.get(state.id);
      if (!entry) {
        entry = createMesh(state);
        map.set(state.id, entry);
        this.combatRoot.add(entry.mesh);
        this.counts.transientCreated += 1;
      }
      entry.state = state;
      this.#positionTransient(entry);
    }
  }

  syncTransientCombat(projectiles, effects) {
    if (this.disposed) return false;
    const Mesh = requireConstructor(this.THREE, 'Mesh');
    this.#syncTransientSet(this.projectileMeshes, projectiles, state => {
      const mesh = new Mesh(
        this.visualAssets.geometries.sphere,
        state.type === 'acid'
          ? (this.visualAssets.materials.acid ?? this.visualAssets.materials.gold)
          : this.visualAssets.materials.gold,
      );
      mesh.name = state.type === 'acid' ? 'boss-acid-projectile' : 'tank-projectile';
      mesh.castShadow = true;
      mesh.scale.setScalar(0.5 * this.unitsPerMeter);
      return { mesh, state, height: 0.55 * this.unitsPerMeter };
    });
    this.#syncTransientSet(this.effectMeshes, effects, state => {
      const destructive = state.type.includes('destruction');
      const nuclear = state.type.startsWith('nuclear');
      const mesh = new Mesh(
        this.visualAssets.geometries.dodeca,
        this.visualAssets.materials[destructive ? 'gold' : 'charred'],
      );
      mesh.name = `combat-${state.type}`;
      mesh.scale.setScalar((nuclear ? 9 : destructive ? 1.35 : 0.45) * this.unitsPerMeter);
      return { mesh, state, height: (nuclear ? 5 : destructive ? 0.8 : 0.3) * this.unitsPerMeter };
    });
    return true;
  }

  #acquirePresentationMesh(event) {
    let entry = this.presentationPool.find(value => !value.active);
    if (!entry && this.presentationPool.length < this.presentationPoolLimit) {
      const Mesh = requireConstructor(this.THREE, 'Mesh');
      const mesh = new Mesh(
        this.visualAssets.geometries.dodeca,
        this.visualAssets.materials.scorch ?? this.visualAssets.materials.charred,
      );
      mesh.visible = false;
      mesh.castShadow = true;
      this.combatRoot.add(mesh);
      entry = { mesh, active: false, remainingSeconds: 0, event: null };
      this.presentationPool.push(entry);
    }
    if (!entry) entry = this.activePresentationEffects.shift();
    entry.active = true;
    entry.event = event;
    entry.remainingSeconds = event.lifetimeSeconds;
    entry.mesh.visible = true;
    entry.mesh.name = `w8-presentation-${event.type}`;
    const local = logicalWorldToRenderLocal(
      event.logicalPosition.x,
      event.logicalPosition.z,
      this.origin.renderOriginChunkX,
      this.origin.renderOriginChunkZ,
      this.renderChunkSize,
    );
    entry.mesh.position.set(local.x, 0.35 * this.unitsPerMeter, local.z);
    const scale = Math.max(0.15, event.intensity) * this.unitsPerMeter;
    entry.mesh.scale.set(scale, scale * 0.45, scale);
    this.activePresentationEffects.push(entry);
    return entry;
  }

  consumePresentationEvents(events, { playerMarker = null } = {}) {
    if (this.disposed) return 0;
    this.playerPresentation = playerMarker ?? this.playerPresentation;
    for (const event of events) {
      this.#acquirePresentationMesh(event);
      const parts = this.playerPresentation?.userData?.presentationParts;
      if (parts && event.type.includes('claw')) {
        const left = event.type.includes('left') || event.type.includes('both');
        const right = event.type.includes('right') || event.type.includes('both');
        const both = event.type.includes('both');
        if (left) this.playerAttackPresentation.left = {
          elapsed: 0, duration: both ? 0.28 : 0.25, mode: both ? 'double' : 'single',
        };
        if (right) this.playerAttackPresentation.right = {
          elapsed: 0, duration: both ? 0.28 : 0.25, mode: both ? 'double' : 'single',
        };
      }
      if (event.type === 'charge-start') {
        this.playerAttackPresentation.charging = true;
        this.playerChargeElapsedSeconds = 0;
      }
      if (event.type === 'charge-release') {
        this.playerAttackPresentation.charging = false;
        this.playerChargeElapsedSeconds = 0;
      }
    }
    return events.length;
  }

  setPlayerLocomotion({ movedMeters = 0, walkPhase = 0, grounded = true } = {}) {
    const parts = this.playerPresentation?.userData?.presentationParts;
    if (!parts) return false;
    const moving = movedMeters > 0.0001;
    parts.legs.forEach((leg, index) => {
      const offset = index * 0.5;
      leg.rotation.x = moving ? Math.sin(walkPhase + offset) * 0.8 : 0;
      leg.position.y = moving && grounded
        ? Math.max(0, Math.sin(walkPhase * 2 + offset) * 10) : 0;
    });
    const locomotionY = moving && grounded
      ? Math.abs(Math.sin(walkPhase * 5 / 6)) * 20 : 0;
    this.playerLocomotionY = locomotionY;
    this.playerPresentationOffsetUnits.y = locomotionY;
    parts.visualRoot.userData.locomotionY = locomotionY;
    parts.visualRoot.position.y = 0;
    return true;
  }

  getPlayerPresentationOffsetUnits() {
    return this.playerPresentationOffsetUnits;
  }

  #animateFiniteClaw(side, state) {
    const parts = this.playerPresentation?.userData?.presentationParts;
    const claw = side === 'left' ? parts?.leftClaw : parts?.rightClaw;
    if (!claw || !state) return;
    const sign = side === 'left' ? 1 : -1;
    const progress = Math.min(1, state.elapsed / state.duration);
    let x = sign * 85; let z = 5; let rotationY = 0;
    if (state.mode === 'double') {
      if (progress < 0.4) {
        const t = progress / 0.4;
        z = 5 + 130 * Math.sin(t * Math.PI / 2);
        x = sign * (85 - 35 * Math.sin(t * Math.PI / 2));
        rotationY = -sign * 0.6 * Math.sin(t * Math.PI / 2);
      } else {
        const t = (progress - 0.4) / 0.6;
        z = 135 - 130 * Math.sin(t * Math.PI / 2);
        x = sign * (50 + 35 * Math.sin(t * Math.PI / 2));
        rotationY = -sign * (0.6 - 0.6 * Math.sin(t * Math.PI / 2));
      }
    } else if (progress < 0.35) {
      const t = progress / 0.35;
      x = sign * (85 + 30 * Math.sin(t * Math.PI / 2));
      z = 5 - 15 * Math.sin(t * Math.PI / 2);
      rotationY = sign * 0.4 * Math.sin(t * Math.PI / 2);
    } else {
      const t = (progress - 0.35) / 0.65;
      x = sign * (115 - 65 * Math.sin(t * Math.PI / 2));
      z = -10 + 125 * Math.sin(t * Math.PI / 2);
      rotationY = sign * (0.4 - 1.2 * Math.sin(t * Math.PI / 2));
      if (t > 0.5) {
        const restore = (t - 0.5) / 0.5;
        x += (sign * 85 - x) * restore;
        z += (5 - z) * restore;
        rotationY *= 1 - restore;
      }
    }
    claw.position.set(x, 30, z);
    claw.rotation.y = rotationY;
  }

  updatePresentation(deltaSeconds) {
    for (let index = this.activePresentationEffects.length - 1; index >= 0; index -= 1) {
      const entry = this.activePresentationEffects[index];
      entry.remainingSeconds -= deltaSeconds;
      if (entry.remainingSeconds <= 0) {
        entry.active = false; entry.mesh.visible = false; entry.event = null;
        this.activePresentationEffects.splice(index, 1);
      } else {
        entry.mesh.rotation.y += deltaSeconds * 5;
      }
    }
    const player = this.playerPresentation;
    const parts = player?.userData?.presentationParts;
    for (const side of ['left', 'right']) {
      const state = this.playerAttackPresentation[side];
      if (state) {
        state.elapsed += deltaSeconds;
        this.#animateFiniteClaw(side, state);
        if (state.elapsed >= state.duration) this.playerAttackPresentation[side] = null;
      } else if (parts) {
        const claw = side === 'left' ? parts.leftClaw : parts.rightClaw;
        const targetX = side === 'left' ? 85 : -85;
        claw.position.x += (targetX - claw.position.x) * Math.min(1, deltaSeconds * 15);
        claw.position.y += (30 - claw.position.y) * Math.min(1, deltaSeconds * 15);
        claw.position.z += (5 - claw.position.z) * Math.min(1, deltaSeconds * 15);
        claw.rotation.y += (0 - claw.rotation.y) * Math.min(1, deltaSeconds * 15);
      }
    }
    if (parts) {
      if (this.playerAttackPresentation.charging) this.playerChargeElapsedSeconds += deltaSeconds;
      else this.playerChargeElapsedSeconds = 0;
      const charge = Math.min(1, this.playerChargeElapsedSeconds * 1000
        / W7_NUCLEAR_CONTRACT.chargeThresholdMs);
      this.playerChargePhase += deltaSeconds * 45;
      parts.visualRoot.rotation.z = 0;
      const left = this.playerAttackPresentation.left;
      const right = this.playerAttackPresentation.right;
      const leftProgress = left ? Math.min(1, left.elapsed / left.duration) : 0;
      const rightProgress = right ? Math.min(1, right.elapsed / right.duration) : 0;
      const doubleProgress = left?.mode === 'double' && right?.mode === 'double'
        ? Math.max(leftProgress, rightProgress) : 0;
      parts.visualRoot.rotation.x = doubleProgress
        ? 0.15 * Math.sin(doubleProgress * Math.PI) : 0;
      parts.visualRoot.rotation.y = doubleProgress ? 0
        : 0.08 * Math.sin(leftProgress * Math.PI)
          - 0.08 * Math.sin(rightProgress * Math.PI);
      parts.visualRoot.position.y = 0;
      const chargeAmplitude = charge * 2.5;
      this.playerPresentationOffsetUnits.x = Math.sin(this.playerChargePhase * 1.31)
        * chargeAmplitude;
      this.playerPresentationOffsetUnits.y = this.playerLocomotionY
        + Math.sin(this.playerChargePhase * 1.73) * chargeAmplitude
        + (doubleProgress ? 8 * Math.sin(doubleProgress * Math.PI) : 0);
      this.playerPresentationOffsetUnits.z = Math.cos(this.playerChargePhase * 1.57)
        * chargeAmplitude;
      const playerMaterial = parts.shell?.material;
      if (charge > 0) {
        playerMaterial?.color?.setRGB?.(1, (2 / 3) * (1 - charge), 0);
        playerMaterial?.emissive?.setRGB?.(charge * 0.75, 0, 0);
      } else {
        playerMaterial?.color?.setHex?.(0xff4500);
        playerMaterial?.emissive?.setRGB?.(0, 0, 0);
      }
    }
  }

  resolveBossCameraCollision({ camera, target, clearanceFiniteUnits = 60 } = {}) {
    const entry = this.manualBossEntry;
    const segments = entry?.mesh?.userData?.segmentMeshes ?? [];
    const desiredDistance = camera?.position && target ? Math.hypot(
      camera.position.x - target.x,
      camera.position.y - target.y,
      camera.position.z - target.z,
    ) : 0;
    if (!camera?.position || !entry || !segments.length) {
      return Object.freeze({ collided: false, stableId: null, desiredDistance, resolvedDistance: desiredDistance });
    }
    const root = entry.mesh;
    const cosine = Math.cos(root.rotation.y);
    const sine = Math.sin(root.rotation.y);
    const rootScale = Math.abs(root.scale.x || 1);
    let collided = false;
    for (const segment of segments) {
      if (segment.visible === false) continue;
      const scaledX = segment.position.x * rootScale;
      const scaledZ = segment.position.z * rootScale;
      const centerX = root.position.x + cosine * scaledX + sine * scaledZ;
      const centerY = root.position.y + segment.position.y * Math.abs(root.scale.y || rootScale);
      const centerZ = root.position.z - sine * scaledX + cosine * scaledZ;
      const radius = (Math.max(
        Math.abs(segment.scale.x),
        Math.abs(segment.scale.y),
        Math.abs(segment.scale.z),
      ) + clearanceFiniteUnits) * rootScale;
      let dx = camera.position.x - centerX;
      let dy = camera.position.y - centerY;
      let dz = camera.position.z - centerZ;
      const distance = Math.hypot(dx, dy, dz);
      if (distance >= radius) continue;
      if (distance <= 0.0001) { dx = 0; dy = 1; dz = 0; }
      const scale = radius / Math.max(distance, 0.0001);
      camera.position.set(
        centerX + dx * scale,
        centerY + dy * scale,
        centerZ + dz * scale,
      );
      collided = true;
    }
    const resolvedDistance = target ? Math.hypot(
      camera.position.x - target.x,
      camera.position.y - target.y,
      camera.position.z - target.z,
    ) : desiredDistance;
    return Object.freeze({
      collided,
      stableId: collided ? entry.state.stableId : null,
      desiredDistance,
      resolvedDistance,
    });
  }

  #positionManualBoss() {
    if (!this.manualBossEntry) return;
    const { state, mesh } = this.manualBossEntry;
    const local = logicalWorldToRenderLocal(
      state.x,
      state.z,
      this.origin.renderOriginChunkX,
      this.origin.renderOriginChunkZ,
      this.renderChunkSize,
    );
    mesh.position.set(local.x, (state.bossBehavior?.verticalOffset ?? 0) * this.unitsPerMeter, local.z);
    mesh.rotation.y = state.rotationY;
    for (let index = 0; index < (mesh.userData.segmentMeshes?.length ?? 0); index += 1) {
      mesh.userData.segmentMeshes[index].visible = (state.bossBehavior?.segmentHp?.[index] ?? 1) > 0;
    }
  }

  syncManualBoss(state) {
    if (this.disposed) return false;
    if (!state?.alive) {
      if (this.manualBossEntry) {
        this.combatRoot.remove(this.manualBossEntry.mesh);
        this.manualBossEntry = null;
        this.counts.transientRemoved += 1;
      }
      return true;
    }
    if (this.manualBossEntry?.state.stableId !== state.stableId) {
      if (this.manualBossEntry) {
        this.combatRoot.remove(this.manualBossEntry.mesh);
        this.counts.transientRemoved += 1;
      }
      const mesh = this.visualAssets.createEntityModel('boss');
      mesh.name = 'manual-production-boss';
      mesh.userData = {
        ...(mesh.userData ?? {}), stableId: state.stableId, type: 'boss', manual: true,
      };
      this.#scaleMesh(mesh, state);
      this.manualBossEntry = { mesh, state };
      this.combatRoot.add(mesh);
      this.counts.transientCreated += 1;
    } else {
      this.manualBossEntry.state = state;
    }
    this.#positionManualBoss();
    return true;
  }

  #positionReinforcement(entry) {
    const local = logicalWorldToRenderLocal(
      entry.state.x, entry.state.z,
      this.origin.renderOriginChunkX, this.origin.renderOriginChunkZ,
      this.renderChunkSize,
    );
    entry.mesh.position.set(local.x, 0, local.z);
    entry.mesh.rotation.y = entry.state.rotationY;
    entry.mesh.visible = entry.state.alive && entry.state.spawned === true;
    const parts = entry.mesh.userData.presentationParts;
    const relative = (entry.state.turretRotationY ?? entry.state.rotationY) - entry.state.rotationY;
    if (parts?.turret) parts.turret.rotation.y = relative;
    if (parts?.gun) {
      parts.gun.rotation.y = relative;
      parts.gun.rotation.x = entry.state.gunPitch ?? 0;
    }
  }

  syncReinforcement(state) {
    if (this.disposed) return false;
    let entry = this.reinforcementMeshes.get(state.stableId);
    if (!entry) {
      const mesh = this.visualAssets.createEntityModel('tank');
      mesh.name = 'w8-score-reinforcement-tank';
      mesh.userData = { ...mesh.userData, stableId: state.stableId, reinforcement: true };
      this.#scaleMesh(mesh, state);
      entry = { mesh, state };
      this.reinforcementMeshes.set(state.stableId, entry);
      this.combatRoot.add(mesh);
      this.counts.transientCreated += 1;
    }
    entry.state = state;
    this.#positionReinforcement(entry);
    return true;
  }

  clearReinforcements() {
    for (const entry of this.reinforcementMeshes.values()) this.combatRoot.remove(entry.mesh);
    this.reinforcementMeshes.clear();
  }

  async loadChunk(key, entityStates) {
    if (this.disposed) throw new Error('gameplay render adapter is shut down');
    if (this.loaded.has(key)) throw new Error(`gameplay chunk already loaded: ${key}`);
    const { chunkX, chunkZ } = parseChunkKey(key);
    const Group = requireConstructor(this.THREE, 'Group');
    const group = new Group();
    group.name = `w6-gameplay-chunk-${key}`;
    group.userData = { chunkKey: key };
    const entry = { key, chunkX, chunkZ, group, entityIds: new Set() };
    this.#positionGroup(entry);
    for (const state of entityStates) {
      if (this.entityMeshes.has(state.stableId)) throw new Error(`duplicate live gameplay Stable ID: ${state.stableId}`);
      const mesh = this.visualAssets.createEntityModel(state.type);
      mesh.name = `production-${state.type}`;
      mesh.userData = { stableId: state.stableId, ownerChunkKey: key, type: state.type };
      this.#scaleMesh(mesh, state);
      this.#positionMesh(mesh, state, entry);
      group.add(mesh);
      entry.entityIds.add(state.stableId);
      this.entityMeshes.set(state.stableId, { mesh, entry });
      this.counts.created += 1;
    }
    this.root.add(group);
    this.loaded.set(createChunkKey(chunkX, chunkZ), entry);
    this.counts.loaded += 1;
  }

  syncEntity(state) {
    const live = this.entityMeshes.get(state.stableId);
    if (!live) return false;
    this.#positionMesh(live.mesh, state, live.entry);
    return true;
  }

  async unloadChunk(key) {
    const entry = this.loaded.get(key);
    if (!entry) throw new Error(`gameplay chunk is not loaded: ${key}`);
    this.root.remove(entry.group);
    for (const stableId of entry.entityIds) {
      this.entityMeshes.delete(stableId);
      this.counts.removed += 1;
    }
    entry.group.clear();
    this.loaded.delete(key);
    this.counts.unloaded += 1;
  }

  snapshot() {
    return Object.freeze({
      schemaVersion: 'w6-gameplay-render-adapter-1',
      liveChunkGroups: this.loaded.size,
      liveEntityMeshes: this.entityMeshes.size,
      liveProjectileMeshes: this.projectileMeshes.size,
      liveCombatEffectMeshes: this.effectMeshes.size,
      liveManualBossMeshes: this.manualBossEntry ? 1 : 0,
      liveReinforcementMeshes: this.reinforcementMeshes.size,
      presentationPoolCapacity: this.presentationPool.length,
      activePresentationEffectCount: this.activePresentationEffects.length,
      presentationPoolLimit: this.presentationPoolLimit,
      sharedGeometryCount: this.visualAssets.snapshot().sharedGeometryCount,
      sharedMaterialCount: this.visualAssets.snapshot().sharedMaterialCount,
      sharedDisposed: this.disposed
        && (!this.ownsVisualAssets || this.visualAssets.snapshot().disposed),
      productionVisuals: this.visualAssets.snapshot(),
      counts: Object.freeze({ ...this.counts }),
    });
  }

  async shutdown() {
    if (this.disposed) return;
    for (const key of [...this.loaded.keys()]) await this.unloadChunk(key);
    this.syncTransientCombat([], []);
    this.syncManualBoss(null);
    this.clearReinforcements();
    for (const entry of this.presentationPool) this.combatRoot.remove(entry.mesh);
    this.presentationPool.length = 0;
    this.activePresentationEffects.length = 0;
    this.scene.remove(this.root);
    this.scene.remove(this.combatRoot);
    if (this.ownsVisualAssets) this.visualAssets.dispose();
    this.disposed = true;
  }
}
