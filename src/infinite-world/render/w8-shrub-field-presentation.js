import {
  LOGICAL_CHUNK_SIZE_METERS,
  RENDER_BLOCK_CHUNK_RADIUS,
  UNITS_PER_METER,
  logicalWorldToOwnedChunk,
  squareChunkCoordinates,
} from '../chunk-coordinates.js';
import { isRenderedOwnerChunk } from '../chunk-streaming-plan.js';
import { W8_WORLD_DETAIL_CONTRACTS } from '../gameplay-contract.js';
import { W8_PARITY_FEATURE_PARTS } from './w8-parity-visual-assets.js';

/**
 * Bush presentation past the render block.
 *
 * Ambient Bush is authored only by Full residency, pinned at 100 m by worker throughput, so
 * the ground beyond that carried no Bush at all while the Trees and Buildings among them
 * stayed visible to the Settlement distance.
 *
 * This is the Grass field's lane, not the Grass field's content. Grass is an identity-free
 * representation of the ground: its clusters have no Stable ID and no Near counterpart, which
 * is exactly why they cannot ride the canonical distant lane. A Bush is the opposite - it is
 * a World Object with a Stable ID, and the canonical distant lane refuses it for the opposite
 * reason: "Bush is Near-only decoration and is forbidden from Macro Natural presence" is a
 * contract about *which objects Macro Natural publishes*, and widening it for Bush would
 * reopen the far-only-synthetic hole that clause exists to close. So Bush keeps its identity
 * and travels beside Macro Natural presence rather than inside it, and this module draws it.
 *
 * The instances here are therefore not stand-ins. Stable ID, position, rotation and size all
 * come from the shared ambient kernel that Full residency uses, so a Bush drawn here is the
 * same Bush the Near tier draws, from the same numbers.
 *
 * Handoff is by owner Chunk against the render block - the 3x3 Chunks the renderer actually
 * projects, and therefore the only Chunks whose ambient Bushes the near tier draws. This lane
 * draws every other Bush.
 *
 * It was first written against the Full residency boundary instead, on the reasoning that
 * Full residency is the only tier that authors ambient Bush. It is - but authoring and
 * drawing are different tiers, and the gap between them is not small: 145 Chunks against 9.
 * Measured in the running game, that handed 794 Bushes to a near tier drawing 48 of them, so
 * 746 were suppressed here and drawn by nobody, in a ring that moved with the player. Which
 * tier draws an object is the only question a draw handoff may ask.
 *
 * The handoff is exact in the steady state and briefly inexact across a crossing, because the
 * near tier projects and retires its Chunks over a few frames while this lane switches on the
 * frame the viewer's Chunk changes. Measured over 467 frames and 4 crossings: 12 frames
 * disagreed, all within two frames of a crossing. Eleven were the near tier still holding a
 * leaving Chunk, which draws those Bushes twice at identical transforms and is invisible. One
 * was the other way - two Bushes handed over one frame before the entering Chunk was
 * projected, a real two-instance gap lasting one frame. That is the near tier's projection
 * latency rather than anything decided here, it predates this lane, and at two instances for
 * one frame it is left alone deliberately rather than unnoticed.
 *
 * Frame budget, deliberately split, and the two halves go opposite ways:
 *
 * - Staging *shares* the Macro coarse world's publication budget, one cell per frame, the
 *   same one the Grass field and the distant residents ride, because a cell's Bushes arrive
 *   with the cell: a separate budget could publish a cell's Grass and withhold its Bushes,
 *   which is the kind of split that goes wrong silently.
 * - The handoff refresh is *not* budgeted, because it cannot be sliced. It rewrites every
 *   staged instance against one boundary, and stopping halfway would leave half the world on
 *   the old boundary and half on the new - reintroducing exactly the double draw and the gap
 *   the handoff exists to prevent. It is self-limited instead: only a Chunk crossing can move
 *   the boundary, so it runs at most once per 16 m of travel and rewrites matrices in place
 *   rather than rebuilding meshes. It is not cheap at world scale - see the measured cost in
 *   the snapshot rather than assuming, and note that an early reading taken before the world
 *   had filled was wrong by more than an order of magnitude.
 *
 * Unbudgeted work is easy to lose track of, so the refresh times itself and reports its last
 * and worst cost in the snapshot: it does not compete for a slice, but it is not invisible.
 */

export const W8_SHRUB_FIELD_PRESENTATION_SCHEMA = 'w8-shrub-field-presentation-1';

/**
 * Distance bands the snapshot reports instances in, so the drawn population can be reconciled
 * against the generated one by count rather than by looking at it - a judgement that has twice
 * called Bush present at the horizon when it was Trees. These are reporting bands only: the
 * handoff happens at the render block, a few tens of metres in, not at any of these radii.
 * 100 m is where ambient authoring stops and 368 m is the Grass field's distance-compensation
 * reach, so the two ground layers are reported against the same outer bound. Instances past
 * the last band are counted separately rather than folded into it.
 */
export const W8_SHRUB_FIELD_DISTANCE_BANDS_METERS = Object.freeze([100, 200, 368]);

/**
 * The authored Bush: the same descriptor list the Near tier projects, and the same colour the
 * World Detail contract gives it. Geometry is baked for a 1 m x 1 m x 1 m Bush so that an
 * instance's scale is literally the canonical record's own dimensions.
 */
const SHRUB_COLOR_HEX = W8_WORLD_DETAIL_CONTRACTS.shrub.color;
const UNIT_SHRUB_METERS = 1;

function requireConstructor(THREE, name) {
  if (typeof THREE?.[name] !== 'function') throw new TypeError(`THREE.${name} is required`);
  return THREE[name];
}

function createPartGeometry(THREE, geometryKind) {
  if (geometryKind === 'dodeca') {
    return new (requireConstructor(THREE, 'DodecahedronGeometry'))(1, 0);
  }
  if (geometryKind === 'sphere') {
    return new (requireConstructor(THREE, 'SphereGeometry'))(0.5, 6, 5);
  }
  return new (requireConstructor(THREE, 'BoxGeometry'))(1, 1, 1);
}

function createShrubGeometry(THREE) {
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
  const euler = new Euler();
  const quaternion = new Quaternion();
  const translation = new Vector3();
  const scale = new Vector3();
  const color = new Color();
  const unit = UNIT_SHRUB_METERS * UNITS_PER_METER;

  for (const part of W8_PARITY_FEATURE_PARTS.shrub) {
    const geometry = createPartGeometry(THREE, part.geometry);
    translation.set(
      part.position[0] * unit, part.position[1] * unit, part.position[2] * unit,
    );
    euler.set(part.rotation?.[0] ?? 0, part.rotation?.[1] ?? 0, part.rotation?.[2] ?? 0);
    quaternion.setFromEuler(euler);
    scale.set(part.scale[0] * unit, part.scale[1] * unit, part.scale[2] * unit);
    matrix.compose(translation, quaternion, scale);
    geometry.applyMatrix4(matrix);

    const offset = positions.length / 3;
    const sourcePosition = geometry.getAttribute('position');
    const sourceNormal = geometry.getAttribute('normal');
    color.setHex(SHRUB_COLOR_HEX);
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

  const merged = new BufferGeometry();
  merged.setAttribute('position', new Float32BufferAttribute(positions, 3));
  merged.setAttribute('normal', new Float32BufferAttribute(normals, 3));
  merged.setAttribute('color', new Float32BufferAttribute(colors, 3));
  merged.setIndex(indices);
  merged.computeBoundingSphere?.();
  return merged;
}

const parseOwnerChunk = ownerKey => {
  const match = /^(-?\d+),(-?\d+)$/.exec(ownerKey ?? '');
  return match === null
    ? null
    : Object.freeze({ chunkX: Number(match[1]), chunkZ: Number(match[2]) });
};

export function createW8ShrubFieldPresentation({
  THREE,
  root = null,
} = {}) {
  // Like the Grass field, this lane is presentation-only: an environment without the full
  // THREE surface simply goes without it rather than breaking the Distant presentation it
  // hangs off.
  const REQUIRED = ['InstancedMesh', 'Matrix4', 'Quaternion', 'Euler', 'Vector3', 'Color',
    'BoxGeometry', 'SphereGeometry', 'DodecahedronGeometry', 'BufferGeometry',
    'Float32BufferAttribute'];
  const Material = THREE?.MeshLambertMaterial ?? THREE?.MeshBasicMaterial;
  if (REQUIRED.some(name => typeof THREE?.[name] !== 'function') || typeof Material !== 'function') {
    return null;
  }

  const geometry = createShrubGeometry(THREE);
  const material = new Material({ vertexColors: true, flatShading: true });
  const meshes = new Map();
  const staged = new Map();
  const origins = new Map();
  // Which instances belong to each owner Chunk, and which owner Chunks each cell brought.
  // The handoff is decided per owner Chunk, so this is the index that lets a crossing touch
  // only the Chunks whose answer changed instead of every staged instance.
  const instancesByOwner = new Map();
  const ownersByCell = new Map();
  let nearOwnerKeys = new Set();
  let currentRoot = root;
  let viewerX = null;
  let viewerZ = null;
  let viewerOwnerChunk = null;
  let disposed = false;
  let stagedCount = 0;
  let retiredCount = 0;
  let handedOverCount = 0;
  let refreshCount = 0;
  let lastRefreshMs = 0;
  let maximumRefreshMs = 0;

  const matrix = new THREE.Matrix4();
  const quaternion = new THREE.Quaternion();
  const euler = new THREE.Euler();
  const translation = new THREE.Vector3();
  const scale = new THREE.Vector3();

  // The near tier draws the ambient Bushes of the Chunks it projects, so this lane draws none
  // of those and all of the rest. The predicate is the render block's own membership test, so
  // the two sides cannot answer the question differently.
  const isNearDrawn = ownerKey => {
    if (viewerOwnerChunk === null) return false;
    const owner = parseOwnerChunk(ownerKey);
    return owner !== null && isRenderedOwnerChunk(
      owner.chunkX, owner.chunkZ, viewerOwnerChunk.chunkX, viewerOwnerChunk.chunkZ,
    );
  };

  const writeInstance = (mesh, shrub, index, originX, originZ, nearDrawn) => {
    translation.set(
      (shrub.position[0] - originX) * UNITS_PER_METER,
      shrub.position[1] * UNITS_PER_METER,
      (shrub.position[2] - originZ) * UNITS_PER_METER,
    );
    euler.set(0, shrub.rotationY ?? 0, 0);
    quaternion.setFromEuler(euler);
    // A Bush the near tier owns collapses to nothing rather than being removed, so the
    // instance order stays stable and crossing the boundary back needs no rebuild.
    scale.set(
      nearDrawn ? 0 : shrub.dimensions[0],
      nearDrawn ? 0 : shrub.dimensions[1],
      nearDrawn ? 0 : shrub.dimensions[2],
    );
    matrix.compose(translation, quaternion, scale);
    mesh.setMatrixAt(index, matrix);
  };

  const originOf = origin => Object.freeze({
    x: (origin?.buildOriginChunkX ?? 0) * LOGICAL_CHUNK_SIZE_METERS,
    z: (origin?.buildOriginChunkZ ?? 0) * LOGICAL_CHUNK_SIZE_METERS,
  });

  /** Full write, for a cell arriving or being rebased. */
  const writeMatrices = (mesh, shrubs, origin) => {
    const { x: originX, z: originZ } = originOf(origin);
    for (let index = 0; index < shrubs.length; index += 1) {
      const shrub = shrubs[index];
      writeInstance(mesh, shrub, index, originX, originZ, isNearDrawn(shrub.owner));
    }
    if (mesh.instanceMatrix) mesh.instanceMatrix.needsUpdate = true;
  };

  /**
   * The handed-over instances are exactly those in the render block's owner Chunks, so the
   * tally is a sum over nine keys rather than a scan of the staged world.
   */
  const recountHandedOver = () => {
    handedOverCount = 0;
    for (const ownerKey of nearOwnerKeys) {
      handedOverCount += instancesByOwner.get(ownerKey)?.length ?? 0;
    }
  };

  /** Rewrites just the instances of one owner Chunk, whose handoff answer has changed. */
  const applyOwnerState = (ownerKey, nearDrawn, touched) => {
    const entries = instancesByOwner.get(ownerKey);
    if (!entries) return;
    for (const entry of entries) {
      const mesh = meshes.get(entry.cellKey);
      const shrubs = staged.get(entry.cellKey);
      if (!mesh || !shrubs) continue;
      const { x: originX, z: originZ } = originOf(origins.get(entry.cellKey));
      writeInstance(mesh, shrubs[entry.index], entry.index, originX, originZ, nearDrawn);
      touched.add(mesh);
    }
  };

  /**
   * Only a Chunk crossing can move the boundary, and a crossing shifts the render block by
   * one Chunk: three Chunks leave, three enter, and every other staged instance keeps the
   * answer it already had. Rewriting all of them cost 15-28 ms at world scale, over a frame;
   * measured, 34-40 instances of 11,212 actually change side, so this walks the old and new
   * block instead - a bounded number of owner Chunks whatever the world holds.
   *
   * It is still timed: it runs outside every frame budget, and nothing else would show it
   * growing again.
   */
  const refreshHandoff = () => {
    const startedAtMs = globalThis.performance?.now?.() ?? Date.now();
    const nextKeys = viewerOwnerChunk === null ? new Set() : new Set(squareChunkCoordinates(
      viewerOwnerChunk.chunkX, viewerOwnerChunk.chunkZ, RENDER_BLOCK_CHUNK_RADIUS,
    ).map(value => value.key));
    const touched = new Set();
    for (const ownerKey of nearOwnerKeys) {
      if (!nextKeys.has(ownerKey)) applyOwnerState(ownerKey, false, touched);
    }
    for (const ownerKey of nextKeys) {
      if (!nearOwnerKeys.has(ownerKey)) applyOwnerState(ownerKey, true, touched);
    }
    for (const mesh of touched) if (mesh.instanceMatrix) mesh.instanceMatrix.needsUpdate = true;
    nearOwnerKeys = nextKeys;
    recountHandedOver();
    lastRefreshMs = (globalThis.performance?.now?.() ?? Date.now()) - startedAtMs;
    maximumRefreshMs = Math.max(maximumRefreshMs, lastRefreshMs);
    refreshCount += 1;
  };

  /** Instances by distance band from the viewer, split by which lane is drawing them. */
  const distanceBands = () => {
    const bands = W8_SHRUB_FIELD_DISTANCE_BANDS_METERS.map(maximumMeters => ({
      maximumMeters, shrubCount: 0, drawnCount: 0, handedOverCount: 0,
    }));
    let beyondCount = 0;
    for (const shrubs of staged.values()) {
      for (const shrub of shrubs) {
        const distanceMeters = viewerX === null ? 0 : Math.hypot(
          shrub.position[0] - viewerX, shrub.position[2] - viewerZ,
        );
        const band = bands.find(value => distanceMeters < value.maximumMeters);
        if (!band) {
          beyondCount += 1;
          continue;
        }
        band.shrubCount += 1;
        if (isNearDrawn(shrub.owner)) band.handedOverCount += 1;
        else band.drawnCount += 1;
      }
    }
    return Object.freeze({
      bands: Object.freeze(bands.map(band => Object.freeze(band))),
      beyondCount,
    });
  };

  return Object.freeze({
    schemaVersion: W8_SHRUB_FIELD_PRESENTATION_SCHEMA,

    setRoot(nextRoot) {
      if (currentRoot === nextRoot) return;
      for (const mesh of meshes.values()) {
        mesh.parent?.remove?.(mesh);
        nextRoot?.add?.(mesh);
      }
      currentRoot = nextRoot;
    },

    /**
     * Stages one Macro cell's Bushes. `origin` supplies the build origin the parent root is
     * expressed in, so instances land in the same space as the rest of the Distant
     * presentation and follow its floating-origin rebasing for free.
     */
    stage(cellKey, shrubField, origin) {
      if (disposed || typeof cellKey !== 'string') return false;
      const shrubs = shrubField?.shrubs;
      if (!Array.isArray(shrubs) || shrubs.length === 0) return false;
      this.retire(cellKey);
      const mesh = new THREE.InstancedMesh(geometry, material, shrubs.length);
      mesh.name = 'w8-shrub-field-pool';
      mesh.frustumCulled = true;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.userData = { presentationOnly: true, shrubCount: shrubs.length };
      meshes.set(cellKey, mesh);
      staged.set(cellKey, shrubs);
      origins.set(cellKey, origin ?? null);
      const owners = new Set();
      for (let index = 0; index < shrubs.length; index += 1) {
        const ownerKey = shrubs[index].owner;
        owners.add(ownerKey);
        const entries = instancesByOwner.get(ownerKey);
        if (entries) entries.push({ cellKey, index });
        else instancesByOwner.set(ownerKey, [{ cellKey, index }]);
      }
      ownersByCell.set(cellKey, owners);
      writeMatrices(mesh, shrubs, origin ?? null);
      recountHandedOver();
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
      for (const ownerKey of ownersByCell.get(cellKey) ?? []) {
        const entries = (instancesByOwner.get(ownerKey) ?? [])
          .filter(entry => entry.cellKey !== cellKey);
        if (entries.length === 0) instancesByOwner.delete(ownerKey);
        else instancesByOwner.set(ownerKey, entries);
      }
      ownersByCell.delete(cellKey);
      recountHandedOver();
      retiredCount += 1;
      return true;
    },

    /**
     * Only the viewer's owner Chunk can move the render block, so the handoff is refreshed on
     * a Chunk crossing rather than on every step.
     */
    setViewer(x, z) {
      if (!Number.isFinite(x) || !Number.isFinite(z) || disposed) return false;
      const ownerChunk = logicalWorldToOwnedChunk(x, z);
      viewerX = x;
      viewerZ = z;
      if (viewerOwnerChunk !== null
        && viewerOwnerChunk.chunkX === ownerChunk.chunkX
        && viewerOwnerChunk.chunkZ === ownerChunk.chunkZ) return false;
      viewerOwnerChunk = ownerChunk;
      refreshHandoff();
      return true;
    },

    /** Stable IDs of the Bushes this lane is currently drawing, for identity audits. */
    drawnStableIds() {
      const stableIds = [];
      for (const shrubs of staged.values()) {
        for (const shrub of shrubs) {
          if (!isNearDrawn(shrub.owner)) stableIds.push(shrub.stableId);
        }
      }
      return Object.freeze(stableIds);
    },

    snapshot() {
      const distance = distanceBands();
      const shrubCount = [...staged.values()].reduce((sum, value) => sum + value.length, 0);
      return Object.freeze({
        schemaVersion: W8_SHRUB_FIELD_PRESENTATION_SCHEMA,
        cellCount: meshes.size,
        shrubCount,
        drawnCount: shrubCount - handedOverCount,
        handedOverCount,
        distanceBands: distance.bands,
        beyondOutermostBandCount: distance.beyondCount,
        // The point the bands were measured from. Without it the band table cannot be
        // reproduced, because the viewer keeps moving while it is being read.
        viewerX,
        viewerZ,
        viewerOwnerKey: viewerOwnerChunk === null
          ? null : `${viewerOwnerChunk.chunkX},${viewerOwnerChunk.chunkZ}`,
        stagedCount,
        retiredCount,
        // The handoff refresh runs outside every frame budget, so its cost is reported here
        // instead of being metered: unbudgeted must not also mean unmeasured.
        handoffRefreshCount: refreshCount,
        lastHandoffRefreshMs: lastRefreshMs,
        maximumHandoffRefreshMs: maximumRefreshMs,
        disposed,
      });
    },

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
      instancesByOwner.clear();
      ownersByCell.clear();
      nearOwnerKeys = new Set();
      handedOverCount = 0;
      geometry.dispose?.();
      material.dispose?.();
    },
  });
}
