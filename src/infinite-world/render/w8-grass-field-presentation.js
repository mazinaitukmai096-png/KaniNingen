import { LOGICAL_CHUNK_SIZE_METERS, UNITS_PER_METER } from '../chunk-coordinates.js';

/**
 * Identity-free Mid Grass presentation.
 *
 * Ambient Grass is generated only by Full residency, which is pinned at 100 m by worker
 * throughput, so beyond that the ground carried no Grass at all. The Mid band instead draws
 * a Grass *field*: deterministic cluster positions with no Stable ID, no Save participation
 * and no entry in the canonical identity audit. Giving these clusters canonical identities
 * is explicitly forbidden - they have no Near counterpart, and "Far-only synthetic Grass
 * objects are forbidden from Macro Natural presence".
 *
 * The canonical distant lane cannot carry them for exactly that reason: registerCanonicalRecord
 * requires a Stable ID and registers the record into canonicalObjects. This module is the
 * parallel lane for content that is a representation of the ground rather than a world object.
 *
 * One cluster holds the blades that a Near-density patch of its cell would hold, so density
 * and silhouette match the Near field while the instance count stays at Tree scale.
 */

export const W8_GRASS_FIELD_PRESENTATION_SCHEMA = 'w8-grass-field-presentation-1';

// Authored Near grass detail: one dark blade and one light blade, in detail-local units.
// Kept in sync with W8_PARITY_FEATURE_PARTS.grass; the Near renderer scales a detail by
// roughly 0.45 m x 0.65 m, which is reproduced here so a cluster reads like Near grass.
const BLADE_PARTS = Object.freeze([
  Object.freeze({
    position: Object.freeze([-0.13, 0.3, 0]),
    scale: Object.freeze([0.08, 0.6, 0.08]),
    rotationZ: -0.16,
    colorHex: 0x376b22,
  }),
  Object.freeze({
    position: Object.freeze([0.12, 0.25, 0.05]),
    scale: Object.freeze([0.07, 0.5, 0.07]),
    rotationZ: 0.2,
    colorHex: 0x75a83a,
  }),
]);
const DETAIL_SIZE_METERS = Object.freeze({ width: 0.45, height: 0.65, depth: 0.45 });

const mix32 = value => {
  let result = value >>> 0;
  result ^= result >>> 16;
  result = Math.imul(result, 0x7feb352d);
  result ^= result >>> 15;
  result = Math.imul(result, 0x846ca68b);
  result ^= result >>> 16;
  return result >>> 0;
};
const unitHash = (a, b) => mix32(Math.imul(a | 0, 0x1f123bb5) ^ Math.imul(b | 0, 0x9e3779b9))
  / 0xffffffff;

function requireConstructor(THREE, name) {
  if (typeof THREE?.[name] !== 'function') throw new TypeError(`THREE.${name} is required`);
  return THREE[name];
}

/**
 * Bakes `detailCount` grass details into one BufferGeometry, scattered across a cell of
 * `cellSizeMeters`. Colors are baked as vertex colors so the whole cluster is one draw call
 * instead of one per blade material.
 */
function createClusterGeometry(THREE, { detailCount, cellSizeMeters }) {
  const BoxGeometry = requireConstructor(THREE, 'BoxGeometry');
  const BufferGeometry = requireConstructor(THREE, 'BufferGeometry');
  const Float32BufferAttribute = requireConstructor(THREE, 'Float32BufferAttribute');
  const Matrix4 = requireConstructor(THREE, 'Matrix4');
  const Euler = requireConstructor(THREE, 'Euler');
  const Quaternion = requireConstructor(THREE, 'Quaternion');
  const Vector3 = requireConstructor(THREE, 'Vector3');
  const Color = requireConstructor(THREE, 'Color');

  const positions = [];
  const normals = [];
  const colors = [];
  const indices = [];
  const matrix = new Matrix4();
  const quaternion = new Quaternion();
  const euler = new Euler();
  const translation = new Vector3();
  const scale = new Vector3();
  const color = new Color();
  const spread = cellSizeMeters * 0.5;

  // Stratified jitter rather than uniform random. With this many blades a uniform draw
  // leaves visible clumps and bald patches, and the gaps line up along cluster boundaries
  // where two cells meet. A jittered grid keeps coverage even at no runtime cost: the
  // scatter is baked into the shared geometry once.
  const strata = Math.max(1, Math.ceil(Math.sqrt(detailCount)));
  const strideMeters = (cellSizeMeters / strata);
  for (let detail = 0; detail < detailCount; detail += 1) {
    const strataX = detail % strata;
    const strataZ = Math.floor(detail / strata) % strata;
    const offsetX = -spread + (strataX + unitHash(detail, 11)) * strideMeters;
    const offsetZ = -spread + (strataZ + unitHash(detail, 23)) * strideMeters;
    const yaw = unitHash(detail, 37) * Math.PI * 2;
    const detailScale = 0.85 + unitHash(detail, 53) * 0.4;

    for (const part of BLADE_PARTS) {
      const geometry = new BoxGeometry(1, 1, 1);
      euler.set(0, yaw, part.rotationZ);
      quaternion.setFromEuler(euler);
      translation.set(
        offsetX + part.position[0] * DETAIL_SIZE_METERS.width * detailScale,
        part.position[1] * DETAIL_SIZE_METERS.height * detailScale,
        offsetZ + part.position[2] * DETAIL_SIZE_METERS.depth * detailScale,
      ).multiplyScalar(UNITS_PER_METER);
      scale.set(
        part.scale[0] * DETAIL_SIZE_METERS.width * detailScale * UNITS_PER_METER,
        part.scale[1] * DETAIL_SIZE_METERS.height * detailScale * UNITS_PER_METER,
        part.scale[2] * DETAIL_SIZE_METERS.depth * detailScale * UNITS_PER_METER,
      );
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
  }

  const merged = new BufferGeometry();
  merged.setAttribute('position', new Float32BufferAttribute(positions, 3));
  merged.setAttribute('normal', new Float32BufferAttribute(normals, 3));
  merged.setAttribute('color', new Float32BufferAttribute(colors, 3));
  merged.setIndex(indices);
  merged.computeBoundingSphere?.();
  return merged;
}

export function createW8GrassFieldPresentation({
  THREE,
  root = null,
  detailCount = 16,
  cellSizeMeters = 8,
  density = 1,
  // Distance compensation. A thin upright blade falls below one pixel of width as it
  // recedes, so it thins out or flickers instead of reading as grassland - raising the
  // count only multiplies what disappears. Widening far blades keeps their apparent size
  // roughly constant. Applied per instance through the existing matrix, so it costs no
  // extra triangles and no extra instances.
  distanceScaleStartMeters = 100,
  distanceScaleEndMeters = 368,
  distanceScaleMaximum = 2.2,
  viewerRebuildThresholdMeters = 24,
} = {}) {
  // The Grass field is presentation-only, so an environment without the full THREE surface
  // (isolated harnesses run against a minimal fake) simply goes without it rather than
  // breaking the Distant presentation it hangs off.
  const REQUIRED = ['InstancedMesh', 'Matrix4', 'Quaternion', 'Euler', 'Vector3', 'Color',
    'BoxGeometry', 'BufferGeometry', 'Float32BufferAttribute'];
  const Material = THREE?.MeshLambertMaterial ?? THREE?.MeshBasicMaterial;
  if (REQUIRED.some(name => typeof THREE?.[name] !== 'function') || typeof Material !== 'function') {
    return null;
  }
  const InstancedMesh = THREE.InstancedMesh;
  const Matrix4 = THREE.Matrix4;
  const Quaternion = THREE.Quaternion;
  const Euler = THREE.Euler;
  const Vector3 = THREE.Vector3;

  const geometry = createClusterGeometry(THREE, { detailCount, cellSizeMeters });
  const material = new Material({ vertexColors: true, flatShading: true });
  const meshes = new Map();
  const staged = new Map();
  const stagedClusters = new Map();
  const stagedOrigins = new Map();
  let currentRoot = root;
  let currentDensity = Math.max(0, Math.min(1, density));
  let disposed = false;
  let viewerX = null;
  let viewerZ = null;
  let stagedCount = 0;
  let retiredCount = 0;

  const matrix = new Matrix4();
  const quaternion = new Quaternion();
  const euler = new Euler();
  const translation = new Vector3();
  const scale = new Vector3();

  const visibleCount = total => Math.round(total * currentDensity);

  // Smooth ramp: no compensation in the Near band, easing to the maximum at the world
  // boundary. A gradual curve matters - a sharp one makes grass visibly shrink as the
  // player runs toward it.
  const distanceScale = (x, z) => {
    if (viewerX === null || viewerZ === null) return 1;
    const distance = Math.hypot(x - viewerX, z - viewerZ);
    const span = distanceScaleEndMeters - distanceScaleStartMeters;
    if (!(span > 0) || distance <= distanceScaleStartMeters) return 1;
    const t = Math.min(1, (distance - distanceScaleStartMeters) / span);
    return 1 + (distanceScaleMaximum - 1) * (t * t * (3 - 2 * t));
  };

  const buildMesh = (clusters, origin) => {
    const mesh = new InstancedMesh(geometry, material, Math.max(1, clusters.length));
    mesh.name = 'w8-grass-field-cluster-pool';
    mesh.frustumCulled = true;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.userData = {
      presentationOnly: true,
      identityFree: true,
      clusterCount: clusters.length,
      detailsPerCluster: detailCount,
    };
    const originX = (origin?.buildOriginChunkX ?? 0) * LOGICAL_CHUNK_SIZE_METERS;
    const originZ = (origin?.buildOriginChunkZ ?? 0) * LOGICAL_CHUNK_SIZE_METERS;
    for (let index = 0; index < clusters.length; index += 1) {
      const cluster = clusters[index];
      translation.set(
        (cluster.x - originX) * UNITS_PER_METER,
        cluster.y * UNITS_PER_METER,
        (cluster.z - originZ) * UNITS_PER_METER,
      );
      euler.set(0, cluster.rotationY ?? 0, 0);
      quaternion.setFromEuler(euler);
      const variation = (cluster.variation ?? 1) * distanceScale(cluster.x, cluster.z);
      scale.set(variation, variation, variation);
      matrix.compose(translation, quaternion, scale);
      mesh.setMatrixAt(index, matrix);
    }
    if (mesh.instanceMatrix) mesh.instanceMatrix.needsUpdate = true;
    mesh.count = visibleCount(clusters.length);
    return mesh;
  };

  return Object.freeze({
    schemaVersion: W8_GRASS_FIELD_PRESENTATION_SCHEMA,

    setRoot(nextRoot) {
      if (currentRoot === nextRoot) return;
      for (const mesh of meshes.values()) {
        mesh.parent?.remove?.(mesh);
        nextRoot?.add?.(mesh);
      }
      currentRoot = nextRoot;
    },

    /**
     * Stages one macro cell's Grass field. `origin` supplies the build origin the parent root
     * is expressed in, so cluster world positions land in the same space as the rest of the
     * Distant presentation and follow its floating-origin rebasing for free.
     */
    stage(cellKey, grassField, origin) {
      if (disposed || typeof cellKey !== 'string') return false;
      const clusters = grassField?.clusters;
      if (!Array.isArray(clusters) || clusters.length === 0) return false;
      this.retire(cellKey);
      const mesh = buildMesh(clusters, origin);
      meshes.set(cellKey, mesh);
      staged.set(cellKey, clusters.length);
      stagedClusters.set(cellKey, clusters);
      stagedOrigins.set(cellKey, origin ?? null);
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
      stagedClusters.delete(cellKey);
      stagedOrigins.delete(cellKey);
      retiredCount += 1;
      return true;
    },

    /**
     * Viewer position drives distance compensation. Matrices are only rewritten once the
     * viewer has moved past a threshold, so this costs nothing on a normal frame.
     */
    setViewer(x, z) {
      if (!Number.isFinite(x) || !Number.isFinite(z) || disposed) return false;
      if (viewerX !== null && Math.hypot(x - viewerX, z - viewerZ) < viewerRebuildThresholdMeters) {
        return false;
      }
      viewerX = x;
      viewerZ = z;
      for (const [cellKey, clusters] of stagedClusters) {
        const previous = meshes.get(cellKey);
        if (!previous) continue;
        const rebuilt = buildMesh(clusters, stagedOrigins.get(cellKey));
        previous.parent?.remove?.(previous);
        previous.dispose?.();
        meshes.set(cellKey, rebuilt);
        currentRoot?.add?.(rebuilt);
      }
      return true;
    },

    /** Density is the primary load control: it trims instances without changing reach. */
    setDensity(value) {
      const next = Math.max(0, Math.min(1, Number(value)));
      if (!Number.isFinite(next) || next === currentDensity) return currentDensity;
      currentDensity = next;
      for (const [cellKey, mesh] of meshes) {
        mesh.count = visibleCount(staged.get(cellKey) ?? mesh.userData.clusterCount ?? 0);
      }
      return currentDensity;
    },

    snapshot: () => Object.freeze({
      schemaVersion: W8_GRASS_FIELD_PRESENTATION_SCHEMA,
      cellCount: meshes.size,
      clusterCount: [...staged.values()].reduce((sum, value) => sum + value, 0),
      visibleClusterCount: [...meshes.values()].reduce((sum, mesh) => sum + (mesh.count ?? 0), 0),
      detailsPerCluster: detailCount,
      density: currentDensity,
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
      stagedClusters.clear();
      stagedOrigins.clear();
      geometry.dispose?.();
      material.dispose?.();
    },
  });
}
