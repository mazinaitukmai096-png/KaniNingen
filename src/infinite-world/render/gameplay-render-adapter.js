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
import { PRODUCTION_TANK_VISUAL_SCALE } from '../../world-scale-rebalance.js';

const FINITE_TANK_MUZZLE_FORWARD_METERS = 112 * PRODUCTION_TANK_VISUAL_SCALE
  / PRODUCTION_VISUAL_UNITS_PER_METER;

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
    const InstancedMesh = requireConstructor(THREE, 'InstancedMesh');
    const Object3D = requireConstructor(THREE, 'Object3D');
    this.effectTransform = new Object3D();
    this.effectInstancePools = new Map();
    const effectPoolSpecs = Object.freeze({
      flash: Object.freeze({ geometry: 'sphere', material: 'atomicFlash', capacity: 96 }),
      debris: Object.freeze({ geometry: 'box', material: 'charred', capacity: 384 }),
      blood: Object.freeze({ geometry: 'box', material: 'blood', capacity: 192 }),
      wind: Object.freeze({ geometry: 'windArc', material: 'wind', capacity: 96 }),
      shockwave: Object.freeze({ geometry: 'torus', material: 'shockwave', capacity: 288 }),
      smoke: Object.freeze({ geometry: 'sphere', material: 'smoke', capacity: 384 }),
      scorch: Object.freeze({ geometry: 'sphere', material: 'scorch', capacity: 96 }),
    });
    for (const [role, spec] of Object.entries(effectPoolSpecs)) {
      const mesh = new InstancedMesh(
        this.visualAssets.geometries[spec.geometry],
        this.visualAssets.materials[spec.material],
        spec.capacity,
      );
      mesh.name = `w8-fixed-effect-pool-${role}`;
      mesh.count = 0;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.userData = { presentationOnly: true, role, capacity: spec.capacity };
      this.combatRoot.add(mesh);
      this.effectInstancePools.set(role, { mesh, capacity: spec.capacity, count: 0 });
    }
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
    }
    if (state.type === 'tank' && parts) {
      const relativeTurret = (state.turretRotationY ?? state.rotationY) - state.rotationY;
      if (parts.turret) parts.turret.rotation.y = relativeTurret;
      if (parts.gun) {
        parts.gun.rotation.y = 0;
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
    this.#syncEffectInstances();
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
    const forward = entry.visualForwardMeters ?? 0;
    entry.mesh.position.set(
      local.x + (entry.state.directionX ?? 0) * forward * this.unitsPerMeter,
      entry.height,
      local.z + (entry.state.directionZ ?? 0) * forward * this.unitsPerMeter,
    );
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
      mesh.scale.setScalar((state.type === 'acid' ? 0.32 : 0.22) * this.unitsPerMeter);
      return {
        mesh,
        state,
        height: (state.type === 'acid' ? 2.4 : 2.05) * this.unitsPerMeter,
        visualForwardMeters: state.type === 'tank-shell' ? FINITE_TANK_MUZZLE_FORWARD_METERS : 0,
      };
    });
    this.#syncTransientSet(this.effectMeshes, [], () => null);
    return true;
  }

  #acquirePresentationEffect(event) {
    let entry = this.presentationPool.find(value => !value.active);
    if (!entry && this.presentationPool.length < this.presentationPoolLimit) {
      entry = { active: false, remainingSeconds: 0, durationSeconds: 0, event: null };
      this.presentationPool.push(entry);
    }
    if (!entry) {
      entry = this.activePresentationEffects.shift();
      entry.active = false;
    }
    entry.active = true;
    entry.event = event;
    entry.remainingSeconds = event.lifetimeSeconds;
    entry.durationSeconds = event.lifetimeSeconds;
    this.activePresentationEffects.push(entry);
    return entry;
  }

  #appendEffectInstance(role, { x, y, z, scaleX, scaleY, scaleZ, rotationX = 0,
    rotationY = 0, rotationZ = 0 }) {
    const pool = this.effectInstancePools.get(role);
    if (!pool || pool.count >= pool.capacity) return false;
    this.effectTransform.position.set(x, y, z);
    this.effectTransform.rotation.set(rotationX, rotationY, rotationZ);
    this.effectTransform.scale.set(scaleX, scaleY, scaleZ);
    this.effectTransform.updateMatrix();
    pool.mesh.setMatrixAt(pool.count, this.effectTransform.matrix);
    pool.count += 1;
    return true;
  }

  #syncEffectInstances() {
    for (const pool of this.effectInstancePools.values()) pool.count = 0;
    for (const entry of this.activePresentationEffects) {
      const event = entry.event;
      if (!event) continue;
      const local = logicalWorldToRenderLocal(
        event.logicalPosition.x,
        event.logicalPosition.z,
        this.origin.renderOriginChunkX,
        this.origin.renderOriginChunkZ,
        this.renderChunkSize,
      );
      const progress = 1 - entry.remainingSeconds / Math.max(entry.durationSeconds, 0.001);
      const intensity = Math.max(0.15, event.intensity);
      const directionHeading = Math.atan2(event.direction?.x ?? 0, event.direction?.z ?? 1);
      const unit = this.unitsPerMeter;
      const base = { x: local.x, z: local.z };
      if (event.type.includes('claw-swish') || event.type === 'boss-sweep') {
        this.#appendEffectInstance('wind', {
          ...base, y: 1.2 * unit,
          scaleX: intensity * 2.4 * unit, scaleY: intensity * 1.2 * unit,
          scaleZ: intensity * 2.4 * unit, rotationY: directionHeading,
        });
        continue;
      }
      if (event.type.startsWith('nuclear')) {
        this.#appendEffectInstance('flash', {
          ...base, y: (2 + progress * 9) * unit,
          scaleX: (2 + progress * 12) * unit,
          scaleY: (2 + progress * 15) * unit,
          scaleZ: (2 + progress * 12) * unit,
        });
        for (let index = 0; index < 8; index += 1) {
          const angle = index * 2.399963 + progress * 0.3;
          const radius = (0.5 + index * 0.22) * unit;
          const puffScale = (1.2 + index * 0.18 + progress * 1.6) * unit;
          this.#appendEffectInstance('smoke', {
            x: base.x + Math.cos(angle) * radius,
            y: (2 + index * 1.8 + progress * 7) * unit,
            z: base.z + Math.sin(angle) * radius,
            scaleX: puffScale * 1.25, scaleY: puffScale, scaleZ: puffScale * 1.25,
          });
        }
        for (let index = 0; index < 3; index += 1) {
          const ringScale = (5 + index * 4 + progress * 18) * unit;
          this.#appendEffectInstance('shockwave', {
            ...base, y: (0.12 + index * 0.06) * unit,
            scaleX: ringScale, scaleY: ringScale, scaleZ: ringScale,
            rotationX: Math.PI / 2,
          });
        }
        this.#appendEffectInstance('scorch', {
          ...base, y: 0.05 * unit,
          scaleX: 8 * unit, scaleY: 0.08 * unit, scaleZ: 8 * unit,
        });
        continue;
      }
      const destructive = event.type.includes('destruction')
        || event.type.includes('landing') || event.type.includes('breach');
      const impact = event.type.includes('impact') || event.type.includes('fire')
        || event.type.includes('spit') || destructive;
      if (impact) this.#appendEffectInstance('flash', {
        ...base, y: (0.45 + progress * 0.8) * unit,
        scaleX: intensity * (0.35 + progress * 1.2) * unit,
        scaleY: intensity * (0.35 + progress * 1.2) * unit,
        scaleZ: intensity * (0.35 + progress * 1.2) * unit,
      });
      if (destructive) for (let index = 0; index < 4; index += 1) {
        const angle = index / 4 * Math.PI * 2 + event.sequence * 0.37;
        const travel = progress * intensity * 2.4 * unit;
        this.#appendEffectInstance('debris', {
          x: base.x + Math.cos(angle) * travel,
          y: (0.3 + Math.sin(progress * Math.PI) * (1.2 + index * 0.25)) * unit,
          z: base.z + Math.sin(angle) * travel,
          scaleX: 0.32 * intensity * unit,
          scaleY: 0.24 * intensity * unit,
          scaleZ: 0.32 * intensity * unit,
          rotationX: progress * 4 + index, rotationY: progress * 5 - index,
        });
      }
      if (event.type.includes('entity-')) for (let index = 0; index < 2; index += 1) {
        const angle = index * Math.PI + event.sequence * 0.19;
        this.#appendEffectInstance('blood', {
          x: base.x + Math.cos(angle) * progress * unit,
          y: (0.25 + Math.sin(progress * Math.PI) * 0.9) * unit,
          z: base.z + Math.sin(angle) * progress * unit,
          scaleX: 0.28 * unit, scaleY: 0.12 * unit, scaleZ: 0.28 * unit,
          rotationY: angle,
        });
      }
      if (event.type.includes('warning') || event.type.includes('breach')) {
        const ringScale = (1 + progress * 5) * intensity * unit;
        this.#appendEffectInstance('shockwave', {
          ...base, y: 0.08 * unit,
          scaleX: ringScale, scaleY: ringScale, scaleZ: ringScale,
          rotationX: Math.PI / 2,
        });
      }
    }
    for (const pool of this.effectInstancePools.values()) {
      pool.mesh.count = pool.count;
      pool.mesh.instanceMatrix.needsUpdate = true;
    }
  }

  consumePresentationEvents(events, { playerMarker = null } = {}) {
    if (this.disposed) return 0;
    this.playerPresentation = playerMarker ?? this.playerPresentation;
    for (const event of events) {
      this.#acquirePresentationEffect(event);
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
        entry.active = false; entry.event = null;
        this.activePresentationEffects.splice(index, 1);
      }
    }
    this.#syncEffectInstances();
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
      const radius = ((segment.userData?.radius ?? Math.max(
        Math.abs(segment.scale.x),
        Math.abs(segment.scale.y),
        Math.abs(segment.scale.z),
      )) + clearanceFiniteUnits) * rootScale;
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
      const segment = mesh.userData.segmentMeshes[index];
      const slither = (state.aiClock ?? 0) * 2.2 - index * 0.58;
      segment.position.x = Math.sin(slither) * (18 + index * 1.6);
      segment.position.y = 80 + Math.sin(slither * 1.35) * 8;
      segment.position.z = -index * 110;
      segment.rotation.y = Math.sin(slither) * 0.12;
      segment.visible = (state.bossBehavior?.segmentHp?.[index] ?? 1) > 0;
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
      parts.gun.rotation.y = 0;
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
      mesh.userData = {
        ...(mesh.userData ?? {}), stableId: state.stableId, ownerChunkKey: key, type: state.type,
      };
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
      effectInstancePools: Object.freeze(Object.fromEntries(
        [...this.effectInstancePools].map(([role, pool]) => [role, Object.freeze({
          count: pool.count, capacity: pool.capacity,
        })]),
      )),
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
    for (const pool of this.effectInstancePools.values()) this.combatRoot.remove(pool.mesh);
    this.effectInstancePools.clear();
    this.presentationPool.length = 0;
    this.activePresentationEffects.length = 0;
    this.scene.remove(this.root);
    this.scene.remove(this.combatRoot);
    if (this.ownsVisualAssets) this.visualAssets.dispose();
    this.disposed = true;
  }
}
