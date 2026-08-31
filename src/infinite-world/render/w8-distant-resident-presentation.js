import { LOGICAL_CHUNK_SIZE_METERS, UNITS_PER_METER } from '../chunk-coordinates.js';

/**
 * Distant Building residents.
 *
 * Human NPCs are simulated only inside the small rendered set around the player, so the
 * people who live in a Settlement used to appear as the player walked up and vanish again
 * behind them, while the Buildings they belong to stayed visible far further out. This lane
 * draws those residents at distance without simulating them: no AI, no collision, no
 * gameplay participation - only a figure standing where that person stands.
 *
 * They are not stand-ins. Identity and placement both come from the shared resident kernel
 * that Full residency uses, verified to agree on identity and to 0.000000 m on position, so
 * the far figure and the simulated NPC are the same person in the same spot. That is what
 * makes the handoff invisible, and it is also why drawing both briefly is harmless: the two
 * meshes coincide exactly.
 *
 * Separating appearance from simulation is what keeps this cheap and keeps it clear of the
 * gameplay residency contract, which deliberately holds simulation to its 3x3 owner set.
 */

export const W8_DISTANT_RESIDENT_PRESENTATION_SCHEMA = 'w8-distant-resident-presentation-1';

// The authored Human, in metres. Finite units are 40 per metre and the production Human
// visual scale is 0.5, so the figure below is the same one the near tier draws.
const FINITE_UNITS_PER_METER = 40;
const HUMAN_VISUAL_SCALE = 0.5;
const HUMAN_PARTS = Object.freeze([
  Object.freeze({
    geometry: 'box',
    position: Object.freeze([0, 45, 0]),
    scale: Object.freeze([45, 90, 45]),
    colorHex: 0x3366ff,
  }),
  Object.freeze({
    geometry: 'sphere',
    position: Object.freeze([0, 110, 0]),
    scale: Object.freeze([30, 30, 30]),
    colorHex: 0xffccaa,
  }),
]);

function createResidentGeometry(THREE) {
  const positions = [];
  const normals = [];
  const colors = [];
  const indices = [];
  const matrix = new THREE.Matrix4();
  const translation = new THREE.Vector3();
  const scale = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const color = new THREE.Color();
  const toRender = value => (value / FINITE_UNITS_PER_METER) * HUMAN_VISUAL_SCALE * UNITS_PER_METER;

  for (const part of HUMAN_PARTS) {
    const geometry = part.geometry === 'sphere'
      ? new THREE.SphereGeometry(0.5, 6, 5) : new THREE.BoxGeometry(1, 1, 1);
    translation.set(
      toRender(part.position[0]), toRender(part.position[1]), toRender(part.position[2]),
    );
    scale.set(toRender(part.scale[0]), toRender(part.scale[1]), toRender(part.scale[2]));
    matrix.compose(translation, quaternion, scale);
    geometry.applyMatrix4(matrix);

    const offset = positions.length / 3;
    const sourcePosition = geometry.getAttribute('position');
    const sourceNormal = geometry.getAttribute('normal');
    color.setHex(part.colorHex);
    for (let index = 0; index < sourcePosition.count; index += 1) {
      positions.push(
        sourcePosition.getX(index), sourcePosition.getY(index), sourcePosition.getZ(index),
      );
      normals.push(
        sourceNormal.getX(index), sourceNormal.getY(index), sourceNormal.getZ(index),
      );
      colors.push(color.r, color.g, color.b);
    }
    const sourceIndex = geometry.getIndex();
    if (sourceIndex) {
      for (let index = 0; index < sourceIndex.count; index += 1) {
        indices.push(offset + sourceIndex.getX(index));
      }
    } else {
      for (let index = 0; index < sourcePosition.count; index += 1) indices.push(offset + index);
    }
    geometry.dispose();
  }

  // Body and head ride one geometry with baked vertex colours, so a whole Settlement's
  // population is one draw call rather than two meshes per person.
  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  merged.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  merged.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  merged.setIndex(indices);
  merged.computeBoundingSphere?.();
  return merged;
}

export function createW8DistantResidentPresentation({
  THREE,
  root = null,
  // Inside this radius the gameplay tier is drawing the simulated NPC, so the far figure
  // steps aside. Kept well inside that tier's coverage rather than at its edge: an overlap
  // is invisible here because both draw the same person in the same place, whereas a gap
  // would bring back the very disappearance this lane exists to remove.
  nearHandoffRadiusMeters = 20,
  viewerRebuildThresholdMeters = 8,
} = {}) {
  const REQUIRED = ['InstancedMesh', 'Matrix4', 'Quaternion', 'Euler', 'Vector3', 'Color',
    'BoxGeometry', 'SphereGeometry', 'BufferGeometry', 'Float32BufferAttribute'];
  const Material = THREE?.MeshLambertMaterial ?? THREE?.MeshBasicMaterial;
  if (REQUIRED.some(name => typeof THREE?.[name] !== 'function') || typeof Material !== 'function') {
    return null;
  }

  const geometry = createResidentGeometry(THREE);
  const material = new Material({ vertexColors: true, flatShading: true });
  const meshes = new Map();
  const staged = new Map();
  const origins = new Map();
  let currentRoot = root;
  let viewerX = null;
  let viewerZ = null;
  let disposed = false;
  let stagedCount = 0;
  let retiredCount = 0;
  let hiddenCount = 0;

  const matrix = new THREE.Matrix4();
  const quaternion = new THREE.Quaternion();
  const euler = new THREE.Euler();
  const translation = new THREE.Vector3();
  const scale = new THREE.Vector3();

  const isHandedOver = (x, z) => viewerX !== null
    && Math.hypot(x - viewerX, z - viewerZ) <= nearHandoffRadiusMeters;

  const writeMatrices = (mesh, residents, origin) => {
    const originX = (origin?.buildOriginChunkX ?? 0) * LOGICAL_CHUNK_SIZE_METERS;
    const originZ = (origin?.buildOriginChunkZ ?? 0) * LOGICAL_CHUNK_SIZE_METERS;
    let hidden = 0;
    for (let index = 0; index < residents.length; index += 1) {
      const resident = residents[index];
      const handedOver = isHandedOver(resident.x, resident.z);
      if (handedOver) hidden += 1;
      translation.set(
        (resident.x - originX) * UNITS_PER_METER,
        resident.y * UNITS_PER_METER,
        (resident.z - originZ) * UNITS_PER_METER,
      );
      euler.set(0, resident.rotationY ?? 0, 0);
      quaternion.setFromEuler(euler);
      // A handed-over resident collapses to nothing rather than being removed, so the
      // instance order stays stable and no rebuild is needed to bring them back.
      const size = handedOver ? 0 : 1;
      scale.set(size, size, size);
      matrix.compose(translation, quaternion, scale);
      mesh.setMatrixAt(index, matrix);
    }
    if (mesh.instanceMatrix) mesh.instanceMatrix.needsUpdate = true;
    return hidden;
  };

  const refreshHiddenCount = () => {
    hiddenCount = 0;
    for (const [cellKey, mesh] of meshes) {
      hiddenCount += writeMatrices(mesh, staged.get(cellKey) ?? [], origins.get(cellKey));
    }
  };

  return Object.freeze({
    schemaVersion: W8_DISTANT_RESIDENT_PRESENTATION_SCHEMA,

    setRoot(nextRoot) {
      if (currentRoot === nextRoot) return;
      for (const mesh of meshes.values()) {
        mesh.parent?.remove?.(mesh);
        nextRoot?.add?.(mesh);
      }
      currentRoot = nextRoot;
    },

    stage(cellKey, residents, origin) {
      if (disposed || typeof cellKey !== 'string') return false;
      if (!Array.isArray(residents) || residents.length === 0) return false;
      this.retire(cellKey);
      const mesh = new THREE.InstancedMesh(geometry, material, residents.length);
      mesh.name = 'w8-distant-resident-pool';
      mesh.frustumCulled = true;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.userData = { presentationOnly: true, residentCount: residents.length };
      meshes.set(cellKey, mesh);
      staged.set(cellKey, residents);
      origins.set(cellKey, origin);
      writeMatrices(mesh, residents, origin);
      currentRoot?.add?.(mesh);
      stagedCount += 1;
      return true;
    },

    retire(cellKey) {
      const mesh = meshes.get(cellKey);
      if (!mesh) return false;
      mesh.parent?.remove?.(mesh);
      mesh.dispose?.();
      meshes.delete(cellKey);
      staged.delete(cellKey);
      origins.delete(cellKey);
      retiredCount += 1;
      return true;
    },

    /** Only rewrites matrices once the viewer has moved far enough to change a handoff. */
    setViewer(x, z) {
      if (!Number.isFinite(x) || !Number.isFinite(z)) return false;
      if (viewerX !== null
        && Math.hypot(x - viewerX, z - viewerZ) < viewerRebuildThresholdMeters) return false;
      viewerX = x;
      viewerZ = z;
      refreshHiddenCount();
      return true;
    },

    snapshot: () => Object.freeze({
      schemaVersion: W8_DISTANT_RESIDENT_PRESENTATION_SCHEMA,
      cellCount: meshes.size,
      residentCount: [...staged.values()].reduce((sum, value) => sum + value.length, 0),
      handedOverCount: hiddenCount,
      nearHandoffRadiusMeters,
      stagedCount,
      retiredCount,
      disposed,
    }),

    dispose() {
      if (disposed) return;
      disposed = true;
      for (const mesh of meshes.values()) {
        mesh.parent?.remove?.(mesh);
        mesh.dispose?.();
      }
      meshes.clear();
      staged.clear();
      origins.clear();
      geometry.dispose?.();
      material.dispose?.();
    },
  });
}
