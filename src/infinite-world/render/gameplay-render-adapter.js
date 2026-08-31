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
import {
  W7_NUCLEAR_CONTRACT,
  W8_NUCLEAR_PRESENTATION_CONTRACT,
  finiteWorldUnitsToMeters,
} from '../gameplay-contract.js';
import {
  WORLD_STREAMING_EVENT,
  WORLD_STREAMING_STREAM,
  WORLD_STREAMING_TARGET,
} from '../world-streaming-telemetry.js';
import {
  hasDrawableInCompletedFrame,
  isCompletedRenderFrameReceipt,
} from '../visual-continuity.js';

function requireConstructor(THREE, name) {
  if (typeof THREE?.[name] !== 'function') throw new TypeError(`THREE.${name} is required`);
  return THREE[name];
}

const FINITE_PARTICLE_DRAG_PER_SECOND = -60 * Math.log(0.98);
const FINITE_PARTICLE_GRAVITY_PER_SECOND = finiteWorldUnitsToMeters(1_500);

function presentationRandom(sequence, index, salt = 0) {
  let value = ((sequence ?? 0) * 0x9e3779b1 + index * 0x85ebca6b + salt * 0xc2b2ae35) >>> 0;
  value ^= value >>> 16; value = Math.imul(value, 0x7feb352d);
  value ^= value >>> 15; value = Math.imul(value, 0x846ca68b);
  value ^= value >>> 16;
  return (value >>> 0) / 0x1_0000_0000;
}

function draggedDistance(initialVelocity, elapsedSeconds) {
  return initialVelocity * (1 - Math.exp(-FINITE_PARTICLE_DRAG_PER_SECOND * elapsedSeconds))
    / FINITE_PARTICLE_DRAG_PER_SECOND;
}

function draggedVerticalDistance(initialVelocity, elapsedSeconds, gravity = FINITE_PARTICLE_GRAVITY_PER_SECOND) {
  const drag = FINITE_PARTICLE_DRAG_PER_SECOND;
  return (initialVelocity + gravity / drag) * (1 - Math.exp(-drag * elapsedSeconds)) / drag
    - gravity * elapsedSeconds / drag;
}

// Debris comes to rest where it lands instead of sinking through the ground.
// Freezing the shared motion clock at touchdown stops the arc, the horizontal
// slide and the tumble together, which is what leaves a scattered field of
// wreckage lying around for the rest of the effect's lifetime.
function settledDebrisMotionSeconds(initialVerticalVelocity, elapsedSeconds) {
  const landingSeconds = Math.max(
    0,
    2 * initialVerticalVelocity / FINITE_PARTICLE_GRAVITY_PER_SECOND,
  );
  return Math.min(elapsedSeconds, landingSeconds);
}

export class GameplayRenderAdapter {
  constructor({
    THREE,
    scene,
    renderChunkSize = RENDER_CHUNK_SIZE,
    visualAssets = null,
    telemetry = null,
  } = {}) {
    if (!scene || typeof scene.add !== 'function' || typeof scene.remove !== 'function') {
      throw new TypeError('a Three.js scene is required');
    }
    const Group = requireConstructor(THREE, 'Group');
    this.THREE = THREE;
    this.scene = scene;
    this.renderChunkSize = renderChunkSize;
    this.unitsPerMeter = renderChunkSize / LOGICAL_CHUNK_SIZE_METERS;
    this.origin = { renderOriginChunkX: 0, renderOriginChunkZ: 0, rebaseCount: -1 };
    this.root = new Group();
    this.root.name = 'w6-gameplay-root';
    this.scene.add(this.root);
    this.combatRoot = new Group();
    this.combatRoot.name = 'w7-core-combat-root';
    this.scene.add(this.combatRoot);
    this.visualAssets = visualAssets ?? createProductionVisualAssetLibrary({ THREE });
    this.ownsVisualAssets = visualAssets === null;
    this.telemetry = telemetry?.enabled === true ? telemetry : null;
    this.pendingFirstDrawByChunk = new Map();
    this.loaded = new Map();
    this.entityMeshes = new Map();
    this.projectileMeshes = new Map();
    this.effectMeshes = new Map();
    this.presentationPool = [];
    this.activePresentationEffects = [];
    this.presentationPoolLimit = 96;
    this.persistentScars = [];
    this.persistentTankScars = this.persistentScars;
    this.tankScarLimit = 50;
    this.tankRuinLimit = 30;
    const InstancedMesh = requireConstructor(THREE, 'InstancedMesh');
    const Object3D = requireConstructor(THREE, 'Object3D');
    this.effectTransform = new Object3D();
    this.effectInstancePools = new Map();
    const effectPoolSpecs = Object.freeze({
      flash: Object.freeze({ geometry: 'sphere', material: 'atomicFlash', capacity: 96 }),
      debris: Object.freeze({ geometry: 'box', material: 'charred', capacity: 500 }),
      charredImpact: Object.freeze({ geometry: 'box', material: 'charred', capacity: 500 }),
      goldSpark: Object.freeze({ geometry: 'box', material: 'gold', capacity: 600 }),
      atomicWhite: Object.freeze({ geometry: 'box', material: 'atomicFlash', capacity: 64 }),
      atomicOrange: Object.freeze({ geometry: 'box', material: 'atomicOrange', capacity: 64 }),
      atomicRing: Object.freeze({ geometry: 'box', material: 'atomicFlash', capacity: 64 }),
      acid: Object.freeze({ geometry: 'box', material: 'acid', capacity: 384 }),
      whiteParticle: Object.freeze({ geometry: 'box', material: 'whiteEye', capacity: 192 }),
      dizzyStar: Object.freeze({ geometry: 'box', material: 'gold', capacity: 128 }),
      rockDebris: Object.freeze({ geometry: 'dodeca', material: 'rock', capacity: 500 }),
      worldDetailDebris: Object.freeze({ geometry: 'box', material: 'roadSign', capacity: 192 }),
      dust: Object.freeze({ geometry: 'box', material: 'road', capacity: 384 }),
      blood: Object.freeze({ geometry: 'box', material: 'blood', capacity: 192 }),
      wind: Object.freeze({ geometry: 'box', material: 'wind', capacity: 96 }),
      shockwave: Object.freeze({ geometry: 'torus', material: 'shockwave', capacity: 288 }),
      landingOuter: Object.freeze({ geometry: 'landingRing', material: 'landingOuter', capacity: 48 }),
      landingInner: Object.freeze({ geometry: 'landingRing', material: 'landingInner', capacity: 48 }),
      smoke: Object.freeze({ geometry: 'sphere', material: 'smoke', capacity: 384 }),
      scorch: Object.freeze({ geometry: 'sphere', material: 'scorch', capacity: 96 }),
      bloodScar: Object.freeze({ geometry: 'sphere', material: 'blood', capacity: 50 }),
      spark: Object.freeze({ geometry: 'box', material: 'atomicFlash', capacity: 192 }),
      ruin: Object.freeze({ geometry: 'box', material: 'charred', capacity: 90 }),
    });
    for (const [role, spec] of Object.entries(effectPoolSpecs)) {
      const mesh = new InstancedMesh(
        this.visualAssets.geometries[spec.geometry],
        this.visualAssets.materials[spec.material] ?? this.visualAssets.materials.charred,
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
      staleRebasesRejected: 0,
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
    const tankGroundY = state.type === 'tank' && Number.isFinite(state.groundY)
      ? state.groundY
      : 0;
    mesh.position.set(
      localX * this.unitsPerMeter,
      tankGroundY * this.unitsPerMeter,
      localZ * this.unitsPerMeter,
    );
    mesh.rotation.y = state.rotationY;
    mesh.visible = state.alive
      && (state.type !== 'tank'
        || (state.spawned === true && state.sandboxSuppressed !== true));
    const parts = mesh.userData.presentationParts;
    if (state.type === 'human' && parts) {
      mesh.rotation.x = state.aiState === 'tripped' ? Math.PI / 2 : 0;
      mesh.rotation.z = state.aiState === 'fallen' ? Math.PI / 2 : 0;
    }
    if (state.type === 'tank' && parts) {
      mesh.rotation.x = Number.isFinite(state.groundPitch) ? state.groundPitch : 0;
      mesh.rotation.z = Number.isFinite(state.groundRoll) ? state.groundRoll : 0;
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
    const incomingEpoch = Number.isSafeInteger(origin?.rebaseCount) ? origin.rebaseCount : null;
    const currentEpoch = Number.isSafeInteger(this.origin.rebaseCount) && this.origin.rebaseCount >= 0
      ? this.origin.rebaseCount : null;
    if (incomingEpoch !== null && currentEpoch !== null && incomingEpoch < currentEpoch) {
      this.counts.staleRebasesRejected += 1;
      return false;
    }
    if (incomingEpoch !== null && currentEpoch !== null && incomingEpoch === currentEpoch
      && (origin.renderOriginChunkX !== this.origin.renderOriginChunkX
        || origin.renderOriginChunkZ !== this.origin.renderOriginChunkZ)) {
      throw new Error(`Gameplay render origin identity mismatch at epoch ${incomingEpoch}`);
    }
    this.origin = {
      renderOriginChunkX: origin.renderOriginChunkX,
      renderOriginChunkZ: origin.renderOriginChunkZ,
      rebaseCount: incomingEpoch ?? currentEpoch ?? -1,
    };
    for (const entry of this.loaded.values()) this.#positionGroup(entry);
    for (const entry of this.projectileMeshes.values()) this.#positionTransient(entry);
    for (const entry of this.effectMeshes.values()) this.#positionTransient(entry);
    if (this.manualBossEntry) this.#positionManualBoss();
    for (const entry of this.reinforcementMeshes.values()) this.#positionReinforcement(entry);
    this.#syncEffectInstances();
    this.counts.rebased += 1;
    return true;
  }

  #positionTransient(entry) {
    const local = logicalWorldToRenderLocal(
      entry.state.x,
      entry.state.z,
      this.origin.renderOriginChunkX,
      this.origin.renderOriginChunkZ,
      this.renderChunkSize,
    );
    entry.mesh.position.set(
      local.x,
      Number.isFinite(entry.state.y) ? entry.state.y * this.unitsPerMeter : entry.height,
      local.z,
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
          : (this.visualAssets.materials.blood ?? this.visualAssets.materials.gold),
      );
      mesh.name = state.type === 'acid' ? 'boss-acid-projectile' : 'tank-projectile';
      mesh.castShadow = true;
      mesh.scale.setScalar((state.type === 'acid' ? 0.32 : 0.5) * this.unitsPerMeter);
      return {
        mesh,
        state,
        height: (state.type === 'acid' ? 2.4 : 2.05) * this.unitsPerMeter,
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
      const baseY = (event.logicalPosition.y ?? 0) * unit;
      const base = { x: local.x, z: local.z };
      if (event.type === 'finite-target-impact' || event.type === 'finite-target-destruction') {
        const finite = event.presentation ?? {};
        const elapsedSeconds = entry.durationSeconds - entry.remainingSeconds;
        const charredCount = elapsedSeconds <= 2 ? (finite.charredCount ?? 0) : 0;
        const sparkCount = elapsedSeconds <= 2 ? (finite.sparkCount ?? 0) : 0;
        const bloodCount = elapsedSeconds <= 2 ? (finite.bloodCount ?? 0) : 0;
        for (let index = 0; index < charredCount; index += 1) {
          const velocityX = (presentationRandom(event.sequence, index, 10) - 0.5)
            + Math.sin(directionHeading) * 3;
          const velocityY = 3 + presentationRandom(event.sequence, index, 11) * 8;
          const velocityZ = (presentationRandom(event.sequence, index, 12) - 0.5)
            + Math.cos(directionHeading) * 3;
          const motionSeconds = settledDebrisMotionSeconds(velocityY, elapsedSeconds);
          const size = 0.3 * (0.6 + presentationRandom(event.sequence, index, 13) * 0.8);
          this.#appendEffectInstance('charredImpact', {
            x: base.x + draggedDistance(velocityX * 6, motionSeconds) * unit,
            y: baseY + Math.max(0, draggedVerticalDistance(velocityY, motionSeconds)) * unit,
            z: base.z + draggedDistance(velocityZ * 6, motionSeconds) * unit,
            scaleX: size * unit, scaleY: size * unit, scaleZ: size * unit,
            rotationX: (presentationRandom(event.sequence, index, 14) - 0.5) * 12 * motionSeconds,
            rotationY: (presentationRandom(event.sequence, index, 15) - 0.5) * 12 * motionSeconds,
          });
        }
        for (let index = 0; index < sparkCount; index += 1) {
          const velocityX = (presentationRandom(event.sequence, index, 20) - 0.5)
            + Math.sin(directionHeading) * 2.5;
          const velocityY = 4 + presentationRandom(event.sequence, index, 21) * 10;
          const velocityZ = (presentationRandom(event.sequence, index, 22) - 0.5)
            + Math.cos(directionHeading) * 2.5;
          const motionSeconds = settledDebrisMotionSeconds(velocityY, elapsedSeconds);
          const size = 0.2 * (0.6 + presentationRandom(event.sequence, index, 23) * 0.8);
          this.#appendEffectInstance('goldSpark', {
            x: base.x + draggedDistance(velocityX * 8, motionSeconds) * unit,
            y: baseY + Math.max(0, draggedVerticalDistance(velocityY, motionSeconds)) * unit,
            z: base.z + draggedDistance(velocityZ * 8, motionSeconds) * unit,
            scaleX: size * unit, scaleY: size * unit, scaleZ: size * unit,
            rotationX: (presentationRandom(event.sequence, index, 24) - 0.5) * 18 * motionSeconds,
            rotationY: (presentationRandom(event.sequence, index, 25) - 0.5) * 18 * motionSeconds,
          });
        }
        for (let index = 0; index < bloodCount; index += 1) {
          const spray = presentationRandom(event.sequence, index, 30) * Math.PI * 2;
          const speed = 2 + presentationRandom(event.sequence, index, 31) * 8;
          const velocityY = 3 + presentationRandom(event.sequence, index, 32) * 9;
          const motionSeconds = settledDebrisMotionSeconds(velocityY, elapsedSeconds);
          const size = 0.3 * (0.6 + presentationRandom(event.sequence, index, 33) * 0.7);
          this.#appendEffectInstance('blood', {
            x: base.x + draggedDistance(
              Math.cos(spray) * speed + Math.sin(directionHeading) * 4, motionSeconds,
            ) * unit,
            y: baseY + Math.max(0, draggedVerticalDistance(velocityY, motionSeconds)) * unit,
            z: base.z + draggedDistance(
              Math.sin(spray) * speed + Math.cos(directionHeading) * 4, motionSeconds,
            ) * unit,
            // Droplets stay stretched along their fall, matching the finite game.
            scaleX: size * 0.6 * unit, scaleY: size * 1.6 * unit, scaleZ: size * 0.6 * unit,
            rotationX: (presentationRandom(event.sequence, index, 34) - 0.5) * 10 * motionSeconds,
            rotationY: spray,
          });
        }
        for (let index = 0; index < (finite.debrisCount ?? 0); index += 1) {
          const isRock = finite.targetType === 'rock' || finite.targetType === 'pebble';
          const role = isRock ? 'rockDebris' : 'debris';
          // Finite-game launch speeds: rock shards 400-1000 units/s, wreckage
          // 300-720, both biased along the blow that broke the target.
          const speed = isRock
            ? finiteWorldUnitsToMeters(400 + presentationRandom(event.sequence, index, 40) * 600)
            : finiteWorldUnitsToMeters(300 + presentationRandom(event.sequence, index, 40) * 420);
          const scatter = presentationRandom(event.sequence, index, 41) * Math.PI * 2;
          const bias = 0.55 + presentationRandom(event.sequence, index, 42) * 0.9;
          const velocityX = Math.cos(scatter) * speed + Math.sin(directionHeading) * speed * bias;
          const velocityZ = Math.sin(scatter) * speed + Math.cos(directionHeading) * speed * bias;
          const velocityY = finiteWorldUnitsToMeters(
            180 + presentationRandom(event.sequence, index, 43) * 480,
          );
          const motionSeconds = settledDebrisMotionSeconds(velocityY, elapsedSeconds);
          const size = Math.max(0.12, (finite.radiusMeters ?? 0.3) * 0.4)
            * (0.55 + presentationRandom(event.sequence, index, 44) * 0.9);
          this.#appendEffectInstance(role, {
            x: base.x + draggedDistance(velocityX, motionSeconds) * unit,
            y: baseY + Math.max(0, draggedVerticalDistance(velocityY, motionSeconds)) * unit,
            z: base.z + draggedDistance(velocityZ, motionSeconds) * unit,
            scaleX: size * unit, scaleY: size * unit, scaleZ: size * unit,
            rotationX: (presentationRandom(event.sequence, index, 45) - 0.5) * 9 * motionSeconds,
            rotationY: (presentationRandom(event.sequence, index, 46) - 0.5) * 9 * motionSeconds,
          });
        }
        if ((finite.shockwaveRadiusMeters ?? 0) > 0 && elapsedSeconds <= 1) {
          const ringScale = Math.max(0.1,
            finite.shockwaveRadiusMeters * Math.min(1, elapsedSeconds)) * unit;
          this.#appendEffectInstance('shockwave', {
            ...base, y: baseY + 0.08 * unit,
            scaleX: ringScale, scaleY: ringScale, scaleZ: ringScale,
            rotationX: Math.PI / 2,
          });
        }
        continue;
      }
      if (event.type === 'finite-ruin') {
        const ruinScale = event.presentation?.ruinScale ?? 0.85;
        const blockCount = 1 + ((event.sequence ?? 0) % 3);
        for (let index = 0; index < blockCount; index += 1) {
          const angle = index / blockCount * Math.PI * 2 + event.sequence * 0.37;
          this.#appendEffectInstance('ruin', {
            x: base.x + Math.cos(angle) * 0.8 * ruinScale * unit,
            y: baseY + (0.15 + index * 0.1) * ruinScale * unit,
            z: base.z + Math.sin(angle) * 0.8 * ruinScale * unit,
            scaleX: (1.5 + index * 0.35) * ruinScale * unit,
            scaleY: (0.375 + index * 0.18) * ruinScale * unit,
            scaleZ: (1 + (blockCount - index) * 0.3) * ruinScale * unit,
            rotationX: (index - 1) * 0.18, rotationY: angle,
            rotationZ: (1 - index) * 0.14,
          });
        }
        const smokeScale = ruinScale * (0.55 + progress * 0.65) * unit;
        this.#appendEffectInstance('smoke', {
          ...base, y: baseY + (0.8 + progress * 1.5) * unit,
          scaleX: smokeScale * 1.2, scaleY: smokeScale, scaleZ: smokeScale * 1.2,
        });
        continue;
      }
      if (event.type.startsWith('acid-') || event.type === 'boss-landing-acid') {
        const acidCount = event.type === 'acid-debuff'
          ? (event.presentation?.particleCount ?? 2) : (event.presentation?.acidCount ?? 0);
        const dustCount = event.presentation?.dustCount ?? 0;
        for (let index = 0; index < acidCount; index += 1) {
          const angle = index / Math.max(1, acidCount) * Math.PI * 2
            + (event.sequence ?? 0) * 0.29;
          const travel = progress * (0.2 + index * 0.08) * unit;
          this.#appendEffectInstance('acid', {
            x: base.x + Math.cos(angle) * travel,
            y: baseY + (0.2 + Math.sin(progress * Math.PI) * (0.4 + index * 0.03)) * unit,
            z: base.z + Math.sin(angle) * travel,
            scaleX: 0.3 * unit, scaleY: 0.3 * unit, scaleZ: 0.3 * unit,
            rotationX: progress * 5 + index, rotationY: angle,
          });
        }
        for (let index = 0; index < dustCount; index += 1) {
          const angle = index / Math.max(1, dustCount) * Math.PI * 2;
          this.#appendEffectInstance('dust', {
            x: base.x + Math.cos(angle) * progress * unit,
            y: baseY + Math.sin(progress * Math.PI) * 0.6 * unit,
            z: base.z + Math.sin(angle) * progress * unit,
            scaleX: 0.55 * unit, scaleY: 0.55 * unit, scaleZ: 0.55 * unit,
            rotationY: angle,
          });
        }
        if (acidCount > 0 || dustCount > 0
          || event.type === 'acid-spit' || event.type === 'boss-landing-acid') continue;
      }
      if (event.type === 'boss-tail-hit') {
        const count = event.presentation?.particleCount ?? 8;
        for (let index = 0; index < count; index += 1) {
          const angle = index / count * Math.PI * 2;
          this.#appendEffectInstance('whiteParticle', {
            x: base.x + Math.cos(angle) * progress * unit,
            y: baseY + Math.sin(progress * Math.PI) * unit,
            z: base.z + Math.sin(angle) * progress * unit,
            scaleX: 0.5 * unit, scaleY: 0.5 * unit, scaleZ: 0.5 * unit,
            rotationY: angle,
          });
        }
        continue;
      }
      if (event.type === 'boss-segment-break') {
        const elapsedSeconds = entry.durationSeconds - entry.remainingSeconds;
        const bloodCount = elapsedSeconds <= 2 ? (event.presentation?.bloodCount ?? 0) : 0;
        for (let index = 0; index < bloodCount; index += 1) {
          const angle = index / Math.max(1, bloodCount) * Math.PI * 2;
          this.#appendEffectInstance('blood', {
            x: base.x + Math.cos(angle) * progress * 2 * unit,
            y: baseY + Math.sin(progress * Math.PI) * (1 + index % 5) * unit,
            z: base.z + Math.sin(angle) * progress * 2 * unit,
            scaleX: 0.5 * unit, scaleY: 0.5 * unit, scaleZ: 0.5 * unit,
            rotationX: progress * 5 + index, rotationY: angle,
          });
        }
        for (let index = 0; index < (event.presentation?.segmentCount ?? 0); index += 1) {
          const angle = index / Math.max(1, event.presentation.segmentCount) * Math.PI * 2;
          this.#appendEffectInstance('debris', {
            x: base.x + Math.cos(angle) * progress * 8 * unit,
            y: baseY + Math.sin(progress * Math.PI) * 8 * unit,
            z: base.z + Math.sin(angle) * progress * 8 * unit,
            scaleX: 2.5 * unit, scaleY: 2.25 * unit, scaleZ: 2.5 * unit,
            rotationX: progress * 6 + index, rotationY: angle,
          });
        }
        continue;
      }
      if (event.type === 'boss-recover-star') {
        this.#appendEffectInstance('dizzyStar', {
          ...base, y: baseY + Math.sin(progress * Math.PI) * 1.5 * unit,
          scaleX: 0.45 * unit, scaleY: 0.45 * unit, scaleZ: 0.45 * unit,
          rotationX: progress * 8, rotationY: progress * 9,
        });
        continue;
      }
      if (event.type === 'boss-landing') {
        const count = event.presentation?.dustCount ?? 24;
        for (let index = 0; index < count; index += 1) {
          const angle = index / count * Math.PI * 2;
          const travel = progress * (2 + index * 0.25) * unit;
          this.#appendEffectInstance('dust', {
            x: base.x + Math.cos(angle) * travel,
            y: baseY + Math.sin(progress * Math.PI) * (1 + index % 4) * unit,
            z: base.z + Math.sin(angle) * travel,
            scaleX: 2 * unit, scaleY: 2 * unit, scaleZ: 2 * unit,
            rotationX: progress * 4 + index, rotationY: angle,
          });
        }
        continue;
      }
      if (event.type.includes('claw-swish') || event.type === 'boss-sweep') {
        if (event.type === 'boss-sweep') {
          this.#appendEffectInstance('wind', {
            ...base, y: baseY + 1.2 * unit,
            scaleX: intensity * 2.4 * unit, scaleY: intensity * 1.2 * unit,
            scaleZ: intensity * 2.4 * unit, rotationY: directionHeading,
          });
          continue;
        }
        const elapsedSeconds = entry.durationSeconds - entry.remainingSeconds;
        const presentation = event.presentation ?? {};
        const particleCount = presentation.particleCountPerSide ?? 28;
        const particleScale = presentation.particleScale ?? 1;
        const radiusMeters = presentation.arcRadiusMeters ?? finiteWorldUnitsToMeters(180);
        const heading = presentation.heading ?? directionHeading;
        const visualScale = presentation.visualScale ?? 1;
        for (const side of presentation.sides ?? ['right']) {
          const isLeft = side === 'left';
          const startAngle = isLeft ? 1.1 : -1.1;
          const endAngle = isLeft ? -0.3 : 0.3;
          for (let index = 0; index < particleCount; index += 1) {
            const life = 0.45 + presentationRandom(event.sequence, index, isLeft ? 41 : 42) * 0.25;
            if (elapsedSeconds > life) continue;
            const t = index / Math.max(1, particleCount - 1);
            const angleOffset = startAngle + (endAngle - startAngle) * Math.sin(t * Math.PI / 2);
            const finalAngle = heading + angleOffset;
            const localX = Math.sin(angleOffset) * radiusMeters;
            const localZ = Math.cos(angleOffset) * radiusMeters;
            const originX = base.x + (localX * Math.cos(heading) + localZ * Math.sin(heading)) * unit;
            const originZ = base.z + (localZ * Math.cos(heading) - localX * Math.sin(heading)) * unit;
            const speed = finiteWorldUnitsToMeters(
              (45 + presentationRandom(event.sequence, index, isLeft ? 43 : 44) * 35) * particleScale,
            );
            const travel = draggedDistance(speed, elapsedSeconds) * unit;
            const flowSign = isLeft ? 1 : -1;
            const length = finiteWorldUnitsToMeters(
              (8 + presentationRandom(event.sequence, index, isLeft ? 45 : 46) * 6) * particleScale,
            ) * unit;
            const thickness = finiteWorldUnitsToMeters(2.6 * particleScale) * unit;
            const lifeRatio = Math.max(0, (life - elapsedSeconds) / life);
            this.#appendEffectInstance('wind', {
              x: originX + Math.cos(finalAngle) * travel * flowSign,
              y: baseY + finiteWorldUnitsToMeters(
                30 * visualScale
                  + (presentationRandom(event.sequence, index, isLeft ? 47 : 48) - 0.5)
                    * 4 * particleScale,
              ) * unit,
              z: originZ - Math.sin(finalAngle) * travel * flowSign,
              scaleX: thickness * lifeRatio,
              scaleY: length * lifeRatio,
              scaleZ: thickness * lifeRatio,
              rotationY: finalAngle + Math.PI / 2,
              rotationZ: Math.PI / 4,
            });
          }
        }
        continue;
      }
      if (event.type.startsWith('nuclear')) {
        const nuclear = W8_NUCLEAR_PRESENTATION_CONTRACT;
        const elapsedSeconds = entry.durationSeconds - entry.remainingSeconds;
        for (const [role, finiteSize, salt] of [
          ['atomicWhite', 50, 100], ['atomicOrange', 70, 200],
        ]) {
          for (let index = 0; index < nuclear.cloudParticlesPerColor; index += 1) {
            const velocityX = finiteWorldUnitsToMeters(
              (presentationRandom(event.sequence, index, salt) - 0.5) * 1_200,
            );
            const velocityY = finiteWorldUnitsToMeters(
              presentationRandom(event.sequence, index, salt + 1) * 2_200,
            );
            const velocityZ = finiteWorldUnitsToMeters(
              (presentationRandom(event.sequence, index, salt + 2) - 0.5) * 1_200,
            );
            const size = finiteWorldUnitsToMeters(
              finiteSize * 1.4 * (0.6 + presentationRandom(event.sequence, index, salt + 3)),
            ) * unit;
            this.#appendEffectInstance(role, {
              x: base.x + draggedDistance(velocityX, elapsedSeconds) * unit,
              y: baseY + draggedVerticalDistance(velocityY, elapsedSeconds) * unit,
              z: base.z + draggedDistance(velocityZ, elapsedSeconds) * unit,
              scaleX: size, scaleY: size, scaleZ: size,
              rotationX: (presentationRandom(event.sequence, index, salt + 4) - 0.5)
                * 0.2 * elapsedSeconds * 60,
              rotationY: (presentationRandom(event.sequence, index, salt + 5) - 0.5)
                * 0.2 * elapsedSeconds * 60,
            });
          }
        }
        if (elapsedSeconds <= 2) {
          for (let index = 0; index < nuclear.goldSparkCount; index += 1) {
            const velocityX = finiteWorldUnitsToMeters(
              (presentationRandom(event.sequence, index, 300) - 0.5) * 800,
            );
            const velocityY = finiteWorldUnitsToMeters(
              presentationRandom(event.sequence, index, 301) * 900,
            );
            const velocityZ = finiteWorldUnitsToMeters(
              (presentationRandom(event.sequence, index, 302) - 0.5) * 800,
            );
            const size = finiteWorldUnitsToMeters(
              25 * (0.6 + presentationRandom(event.sequence, index, 303)),
            ) * unit;
            this.#appendEffectInstance('goldSpark', {
              x: base.x + draggedDistance(velocityX, elapsedSeconds) * unit,
              y: baseY + draggedVerticalDistance(velocityY, elapsedSeconds) * unit,
              z: base.z + draggedDistance(velocityZ, elapsedSeconds) * unit,
              scaleX: size, scaleY: size, scaleZ: size,
              rotationX: (presentationRandom(event.sequence, index, 304) - 0.5)
                * 0.2 * elapsedSeconds * 60,
              rotationY: (presentationRandom(event.sequence, index, 305) - 0.5)
                * 0.2 * elapsedSeconds * 60,
            });
          }
        }
        if (elapsedSeconds <= nuclear.ringLifetimeSeconds) {
          const ringDecay = FINITE_PARTICLE_DRAG_PER_SECOND;
          const ringSpeedFinite = W7_NUCLEAR_CONTRACT.pushRadius * ringDecay
            / (1 - Math.exp(-ringDecay * nuclear.ringLifetimeSeconds));
          const ringTravel = draggedDistance(
            finiteWorldUnitsToMeters(ringSpeedFinite), elapsedSeconds,
          ) * unit;
          for (let index = 0; index < nuclear.radialRingCount; index += 1) {
            const angle = index / nuclear.radialRingCount * Math.PI * 2;
            this.#appendEffectInstance('atomicRing', {
              x: base.x + Math.cos(angle) * ringTravel,
              y: baseY + draggedVerticalDistance(
                finiteWorldUnitsToMeters(100), elapsedSeconds,
              ) * unit,
              z: base.z + Math.sin(angle) * ringTravel,
              scaleX: finiteWorldUnitsToMeters(320) * unit,
              scaleY: finiteWorldUnitsToMeters(90) * unit,
              scaleZ: finiteWorldUnitsToMeters(320) * unit,
              rotationY: angle,
            });
          }
        }
        for (let index = 0; index < (event.presentation?.segmentCount ?? 0); index += 1) {
          const angle = index / Math.max(1, event.presentation.segmentCount) * Math.PI * 2;
          this.#appendEffectInstance('debris', {
            x: base.x + Math.cos(angle) * progress * 45 * unit,
            y: baseY + Math.sin(progress * Math.PI) * 62.5 * unit,
            z: base.z + Math.sin(angle) * progress * 45 * unit,
            scaleX: 2.8 * unit, scaleY: 2.5 * unit, scaleZ: 2.8 * unit,
            rotationX: progress * 8 + index, rotationY: angle,
          });
        }
        continue;
      }
      if (event.type === 'player-landing-shockwave') {
        const finite = event.presentation ?? {};
        const elapsedFrames = (entry.durationSeconds - entry.remainingSeconds) * 60;
        const initialRadius = finite.initialRadiusMeters ?? finiteWorldUnitsToMeters(10);
        const maximumRadius = finite.maximumRadiusMeters ?? intensity;
        const ringScale = maximumRadius
          - (maximumRadius - initialRadius) * Math.pow(0.88, elapsedFrames);
        const ringRole = finite.ringRole === 'inner' ? 'landingInner' : 'landingOuter';
        const ringPool = this.effectInstancePools.get(ringRole);
        const opacity = Math.max(0, (finite.initialOpacity ?? 0.85) - 0.04 * elapsedFrames);
        if (ringPool?.mesh?.material) {
          ringPool.mesh.material.opacity = opacity;
          if (ringPool.mesh.material.options) ringPool.mesh.material.options.opacity = opacity;
          ringPool.mesh.material.needsUpdate = true;
        }
        this.#appendEffectInstance(ringRole, {
          ...base, y: baseY + finiteWorldUnitsToMeters(4) * unit,
          scaleX: ringScale * unit, scaleY: ringScale * unit, scaleZ: ringScale * unit,
          rotationX: -Math.PI / 2,
        });
        continue;
      }
      if (event.type === 'player-landing-dust') {
        const dustCount = Math.max(4, Math.round(14 * intensity));
        const elapsedSeconds = entry.durationSeconds - entry.remainingSeconds;
        for (let index = 0; index < dustCount; index += 1) {
          const angle = presentationRandom(event.sequence, index, 60) * Math.PI * 2;
          // 10-22.5 is the finite game's launch speed for landing dust. Using it
          // as a travel distance instead blew the puff out into a 20 m ring.
          const speed = (10 + presentationRandom(event.sequence, index, 61) * 12.5) * intensity;
          const velocityY = (2 + presentationRandom(event.sequence, index, 62) * 4) * intensity;
          const motionSeconds = settledDebrisMotionSeconds(velocityY, elapsedSeconds);
          const dustScale = (0.375 + presentationRandom(event.sequence, index, 63) * 0.5)
            * intensity * unit;
          this.#appendEffectInstance('dust', {
            x: base.x + draggedDistance(Math.cos(angle) * speed, motionSeconds) * unit,
            y: baseY + Math.max(0, draggedVerticalDistance(velocityY, motionSeconds)) * unit,
            z: base.z + draggedDistance(Math.sin(angle) * speed, motionSeconds) * unit,
            scaleX: dustScale,
            scaleY: dustScale,
            scaleZ: dustScale,
            rotationX: (presentationRandom(event.sequence, index, 64) - 0.5) * 6 * motionSeconds,
            rotationY: angle,
          });
        }
        continue;
      }
      if (event.type === 'world-detail-destruction') {
        for (let index = 0; index < 6; index += 1) {
          const angle = index / 6 * Math.PI * 2 + (event.sequence ?? 0) * 0.37;
          const travel = progress * (0.4 + index * 0.12) * unit;
          this.#appendEffectInstance('worldDetailDebris', {
            x: base.x + Math.cos(angle) * travel,
            y: baseY + (0.2 + Math.sin(progress * Math.PI) * (0.5 + index * 0.08)) * unit,
            z: base.z + Math.sin(angle) * travel,
            scaleX: 0.16 * unit,
            scaleY: 0.1 * unit,
            scaleZ: 0.16 * unit,
            rotationX: progress * 5 + index,
            rotationY: progress * 4 - index,
          });
        }
        continue;
      }
      if (event.type === 'tank-ruin') {
        for (let index = 0; index < 3; index += 1) {
          const angle = index / 3 * Math.PI * 2 + event.sequence * 0.37;
          const width = intensity * (1.5 + index * 0.35) * unit;
          const height = intensity * (0.38 + index * 0.12) * unit;
          const depth = intensity * (1.1 + (2 - index) * 0.3) * unit;
          this.#appendEffectInstance('ruin', {
            x: base.x + Math.cos(angle) * intensity * 0.55 * unit,
            y: baseY + height * 0.4,
            z: base.z + Math.sin(angle) * intensity * 0.55 * unit,
            scaleX: width,
            scaleY: height,
            scaleZ: depth,
            rotationX: (index - 1) * 0.18,
            rotationY: angle,
            rotationZ: (1 - index) * 0.14,
          });
        }
        const smokeScale = intensity * (0.55 + progress * 0.65) * unit;
        this.#appendEffectInstance('smoke', {
          ...base,
          y: baseY + (0.8 + progress * 1.5) * unit,
          scaleX: smokeScale * 1.2,
          scaleY: smokeScale,
          scaleZ: smokeScale * 1.2,
        });
        continue;
      }
      const destructive = event.type.startsWith('boss-')
        && (event.type.includes('destruction') || event.type.includes('landing')
          || event.type.includes('breach'));
      const tankDestruction = false;
      const impact = event.type.includes('impact') || event.type.includes('fire')
        || event.type.includes('spit') || destructive;
      if (impact) this.#appendEffectInstance('flash', {
        ...base, y: baseY + (0.45 + progress * 0.8) * unit,
        scaleX: intensity * (0.35 + progress * 1.2) * unit,
        scaleY: intensity * (0.35 + progress * 1.2) * unit,
        scaleZ: intensity * (0.35 + progress * 1.2) * unit,
      });
      if (destructive) for (let index = 0; index < 4; index += 1) {
        const angle = index / 4 * Math.PI * 2 + event.sequence * 0.37;
        const travel = progress * intensity * 2.4 * unit;
        this.#appendEffectInstance('debris', {
          x: base.x + Math.cos(angle) * travel,
          y: baseY + (0.3 + Math.sin(progress * Math.PI) * (1.2 + index * 0.25)) * unit,
          z: base.z + Math.sin(angle) * travel,
          scaleX: 0.32 * intensity * unit,
          scaleY: 0.24 * intensity * unit,
          scaleZ: 0.32 * intensity * unit,
          rotationX: progress * 4 + index, rotationY: progress * 5 - index,
        });
      }
      if (tankDestruction) {
        for (let index = 0; index < 6; index += 1) {
          const angle = index / 6 * Math.PI * 2 + (event.sequence ?? 0) * 0.41;
          const travel = (0.4 + progress * 2.8) * intensity * unit;
          const sparkScale = (0.06 + (1 - progress) * 0.12) * intensity * unit;
          this.#appendEffectInstance('spark', {
            x: base.x + Math.cos(angle) * travel,
            y: baseY + (0.45 + Math.sin(progress * Math.PI) * (1 + index * 0.12)) * unit,
            z: base.z + Math.sin(angle) * travel,
            scaleX: sparkScale,
            scaleY: sparkScale * 2.4,
            scaleZ: sparkScale,
            rotationX: progress * 7 + index,
            rotationY: angle,
          });
        }
        for (let index = 0; index < 3; index += 1) {
          const angle = index / 3 * Math.PI * 2 + (event.sequence ?? 0) * 0.23;
          const puffScale = intensity * (0.45 + index * 0.12 + progress * 0.7) * unit;
          this.#appendEffectInstance('smoke', {
            x: base.x + Math.cos(angle) * intensity * 0.35 * unit,
            y: baseY + (0.55 + index * 0.38 + progress * 1.1) * unit,
            z: base.z + Math.sin(angle) * intensity * 0.35 * unit,
            scaleX: puffScale * 1.15, scaleY: puffScale, scaleZ: puffScale * 1.15,
          });
        }
        this.#appendEffectInstance('scorch', {
          ...base, y: baseY + 0.04 * unit,
          scaleX: intensity * 1.8 * unit,
          scaleY: 0.04 * unit,
          scaleZ: intensity * 1.8 * unit,
        });
      }
      if (!tankDestruction && event.type.includes('entity-')) for (let index = 0; index < 2; index += 1) {
        const angle = index * Math.PI + event.sequence * 0.19;
        this.#appendEffectInstance('blood', {
          x: base.x + Math.cos(angle) * progress * unit,
          y: baseY + (0.25 + Math.sin(progress * Math.PI) * 0.9) * unit,
          z: base.z + Math.sin(angle) * progress * unit,
          scaleX: 0.28 * unit, scaleY: 0.12 * unit, scaleZ: 0.28 * unit,
          rotationY: angle,
        });
      }
      if (event.type.includes('warning') || event.type.includes('breach')) {
        const ringScale = (1 + progress * 5) * intensity * unit;
        this.#appendEffectInstance('shockwave', {
          ...base, y: baseY + 0.08 * unit,
          scaleX: ringScale, scaleY: ringScale, scaleZ: ringScale,
          rotationX: Math.PI / 2,
        });
      }
    }
    for (const event of this.persistentScars) {
      const local = logicalWorldToRenderLocal(
        event.logicalPosition.x,
        event.logicalPosition.z,
        this.origin.renderOriginChunkX,
        this.origin.renderOriginChunkZ,
        this.renderChunkSize,
      );
      const radius = Math.max(0.15, event.intensity) * 1.5 * this.unitsPerMeter;
      this.#appendEffectInstance(event.presentation?.scarKind === 'blood' ? 'bloodScar' : 'scorch', {
        x: local.x,
        y: ((event.logicalPosition.y ?? 0) + 0.0375) * this.unitsPerMeter,
        z: local.z,
        scaleX: radius,
        scaleY: 0.04 * this.unitsPerMeter,
        scaleZ: radius,
      });
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
      if (event.type === 'boss-landing-scar' || event.type === 'boss-breach-warning') {
        this.persistentScars.push(Object.freeze({
          ...event,
          type: 'finite-scar',
          presentation: Object.freeze({ scarKind: 'scorch' }),
        }));
        if (this.persistentScars.length > this.tankScarLimit) this.persistentScars.shift();
        if (event.type === 'boss-landing-scar') continue;
      }
      if (event.type === 'finite-target-destruction' || event.type === 'finite-destruction-revisit') {
        const finite = event.presentation ?? {};
        if (finite.scarKind && finite.scarRadiusMeters > 0) {
          this.persistentScars.push(Object.freeze({
            ...event,
            type: 'finite-scar',
            intensity: finite.scarRadiusMeters,
            presentation: Object.freeze({ scarKind: finite.scarKind }),
          }));
          if (this.persistentScars.length > this.tankScarLimit) this.persistentScars.shift();
        }
        if (finite.ruinScale > 0) {
          let ruinCount = 0;
          let oldestRuinIndex = -1;
          for (let index = 0; index < this.activePresentationEffects.length; index += 1) {
            if (!['finite-ruin', 'tank-ruin'].includes(
              this.activePresentationEffects[index].event?.type,
            )) continue;
            ruinCount += 1;
            if (oldestRuinIndex < 0) oldestRuinIndex = index;
          }
          if (ruinCount >= this.tankRuinLimit && oldestRuinIndex >= 0) {
            const [oldest] = this.activePresentationEffects.splice(oldestRuinIndex, 1);
            oldest.active = false;
            oldest.event = null;
          }
          this.#acquirePresentationEffect(Object.freeze({
            ...event,
            type: 'finite-ruin',
            lifetimeSeconds: 15,
          }));
        }
        if (event.type === 'finite-destruction-revisit') continue;
      }
      if (event.type === 'tank-scar') {
        this.persistentTankScars.push(event);
        if (this.persistentTankScars.length > this.tankScarLimit) {
          this.persistentTankScars.shift();
        }
        continue;
      }
      if (event.type === 'tank-ruin') {
        let ruinCount = 0;
        let oldestRuinIndex = -1;
        for (let index = 0; index < this.activePresentationEffects.length; index += 1) {
          if (this.activePresentationEffects[index].event?.type !== 'tank-ruin') continue;
          ruinCount += 1;
          if (oldestRuinIndex < 0) oldestRuinIndex = index;
        }
        if (ruinCount >= this.tankRuinLimit && oldestRuinIndex >= 0) {
          const [oldest] = this.activePresentationEffects.splice(oldestRuinIndex, 1);
          oldest.active = false;
          oldest.event = null;
        }
      }
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
        this.#resetPlayerChargePresentation();
      }
    }
    return events.length;
  }

  clearCombatPresentation() {
    for (const entry of this.activePresentationEffects) {
      entry.active = false;
      entry.event = null;
    }
    this.activePresentationEffects.length = 0;
    this.persistentTankScars.length = 0;
    this.playerAttackPresentation.left = null;
    this.playerAttackPresentation.right = null;
    this.#resetPlayerChargePresentation();
    this.#syncEffectInstances();
    return true;
  }

  clearPlayerChargePresentation() {
    this.#resetPlayerChargePresentation();
    return true;
  }

  #resetPlayerChargePresentation() {
    this.playerAttackPresentation.charging = false;
    this.playerChargeElapsedSeconds = 0;
    this.playerChargePhase = 0;
    this.playerPresentationOffsetUnits.x = 0;
    this.playerPresentationOffsetUnits.z = 0;
    this.playerPresentationOffsetUnits.y = this.playerLocomotionY;
    const parts = this.playerPresentation?.userData?.presentationParts;
    parts?.shell?.material?.color?.setHex?.(0xff4500);
    parts?.shell?.material?.emissive?.setRGB?.(0, 0, 0);
  }

  setPlayerLocomotion({
    movedMeters = 0, elapsedSeconds = 0, grounded = true, intro = false,
  } = {}) {
    const parts = this.playerPresentation?.userData?.presentationParts;
    if (!parts) return false;
    const moving = movedMeters > 0.0001;
    const legPhase = elapsedSeconds * (intro ? 6 : 30);
    const liftPhase = elapsedSeconds * (intro ? 12 : 60);
    const bodyPhase = elapsedSeconds * (intro ? 10 : 25);
    const legLift = intro ? 4 : 10;
    const bodyBounce = intro ? 8 : 20;
    parts.legs.forEach((leg, index) => {
      const offset = index * 0.5;
      leg.rotation.x = moving ? Math.sin(legPhase + offset) * 0.8 : 0;
      leg.position.y = moving && grounded
        ? Math.max(0, Math.sin(liftPhase + offset) * legLift) : 0;
    });
    const locomotionY = moving && grounded
      ? Math.abs(Math.sin(bodyPhase)) * bodyBounce : 0;
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
    entry.mesh.position.set(
      local.x,
      (Number.isFinite(entry.state.groundY) ? entry.state.groundY : 0) * this.unitsPerMeter,
      local.z,
    );
    entry.mesh.rotation.x = Number.isFinite(entry.state.groundPitch)
      ? entry.state.groundPitch
      : 0;
    entry.mesh.rotation.y = entry.state.rotationY;
    entry.mesh.rotation.z = Number.isFinite(entry.state.groundRoll) ? entry.state.groundRoll : 0;
    entry.mesh.visible = entry.state.alive && entry.state.spawned === true
      && entry.state.sandboxSuppressed !== true;
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
    if (!state?.alive || state.spawned !== true) return this.removeReinforcement(state?.stableId);
    const loadedEntity = this.entityMeshes.get(state.stableId);
    if (loadedEntity) {
      this.removeReinforcement(state.stableId);
      this.#positionMesh(loadedEntity.mesh, state, loadedEntity.entry);
      return true;
    }
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

  removeReinforcement(stableId) {
    if (typeof stableId !== 'string' || !stableId) return false;
    const entry = this.reinforcementMeshes.get(stableId);
    if (!entry) return false;
    this.combatRoot.remove(entry.mesh);
    this.reinforcementMeshes.delete(stableId);
    const loadedEntity = this.entityMeshes.get(stableId);
    if (loadedEntity) this.#positionMesh(loadedEntity.mesh, entry.state, loadedEntity.entry);
    this.counts.transientRemoved += 1;
    return true;
  }

  clearReinforcements() {
    for (const stableId of [...this.reinforcementMeshes.keys()]) this.removeReinforcement(stableId);
  }

  async loadChunk(key, entityStates) {
    if (this.disposed) throw new Error('gameplay render adapter is shut down');
    if (this.loaded.has(key)) throw new Error(`gameplay chunk already loaded: ${key}`);
    const incomingIds = new Set();
    for (const state of entityStates) {
      if (incomingIds.has(state.stableId) || this.entityMeshes.has(state.stableId)) {
        throw new Error(`duplicate live gameplay Stable ID: ${state.stableId}`);
      }
      incomingIds.add(state.stableId);
    }
    const { chunkX, chunkZ } = parseChunkKey(key);
    const Group = requireConstructor(this.THREE, 'Group');
    const group = new Group();
    group.name = `w6-gameplay-chunk-${key}`;
    group.userData = { chunkKey: key };
    const entry = { key, chunkX, chunkZ, group, entityIds: new Set() };
    this.#positionGroup(entry);
    try {
      for (const state of entityStates) {
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
      for (const state of entityStates) this.removeReinforcement(state.stableId);
      this.root.add(group);
      this.loaded.set(createChunkKey(chunkX, chunkZ), entry);
      this.counts.loaded += 1;
      if (this.telemetry) {
        const representativeStableId = entityStates.find(state => (
          typeof state?.stableId === 'string' && state.stableId
        ))?.stableId ?? null;
        const details = {
          target: WORLD_STREAMING_TARGET.GAMEPLAY,
          stream: WORLD_STREAMING_STREAM.GAMEPLAY,
          resourceKey: key,
          ownerKey: key,
          stableId: representativeStableId,
          metadata: { entityCount: entityStates.length },
        };
        const published = this.telemetry.record(WORLD_STREAMING_EVENT.PUBLISH, details);
        this.pendingFirstDrawByChunk.set(key, {
          ...details,
          correlationId: published?.correlationId ?? null,
        });
      }
    } catch (error) {
      this.root.remove(group);
      for (const stableId of entry.entityIds) {
        this.entityMeshes.delete(stableId);
        this.counts.created = Math.max(0, this.counts.created - 1);
      }
      group.clear();
      throw error;
    }
  }

  markFirstDraw(receipt) {
    if (!isCompletedRenderFrameReceipt(receipt)) return 0;
    if (!this.telemetry || this.pendingFirstDrawByChunk.size === 0) return 0;
    let recorded = 0;
    for (const [key, details] of this.pendingFirstDrawByChunk) {
      const entry = this.loaded.get(key);
      if (!entry || !hasDrawableInCompletedFrame({ root: entry.group, receipt })) continue;
      this.telemetry.record(WORLD_STREAMING_EVENT.FIRST_DRAW, details);
      this.pendingFirstDrawByChunk.delete(key);
      recorded += 1;
    }
    return recorded;
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
    this.pendingFirstDrawByChunk.delete(key);
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
      renderOrigin: Object.freeze({ ...this.origin }),
      liveChunkGroups: this.loaded.size,
      liveEntityMeshes: this.entityMeshes.size,
      liveProjectileMeshes: this.projectileMeshes.size,
      liveCombatEffectMeshes: this.effectMeshes.size,
      liveManualBossMeshes: this.manualBossEntry ? 1 : 0,
      liveReinforcementMeshes: this.reinforcementMeshes.size,
      presentationPoolCapacity: this.presentationPool.length,
      activePresentationEffectCount: this.activePresentationEffects.length,
      presentationPoolLimit: this.presentationPoolLimit,
      persistentTankScarCount: this.persistentTankScars.length,
      tankScarLimit: this.tankScarLimit,
      tankRuinLimit: this.tankRuinLimit,
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
    this.pendingFirstDrawByChunk.clear();
    this.clearReinforcements();
    for (const pool of this.effectInstancePools.values()) this.combatRoot.remove(pool.mesh);
    this.effectInstancePools.clear();
    this.presentationPool.length = 0;
    this.activePresentationEffects.length = 0;
    this.persistentTankScars.length = 0;
    this.scene.remove(this.root);
    this.scene.remove(this.combatRoot);
    if (this.ownsVisualAssets) this.visualAssets.dispose();
    this.disposed = true;
  }
}
