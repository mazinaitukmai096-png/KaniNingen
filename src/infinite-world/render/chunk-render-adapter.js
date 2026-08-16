import {
  LOGICAL_CHUNK_SIZE_METERS,
  RENDER_CHUNK_SIZE,
  SUPPORTED_RENDER_CHUNK_SIZES,
  chunkRenderPosition,
  createChunkKey,
} from '../chunk-coordinates.js';
import {
  PRODUCTION_VISUAL_UNITS_PER_METER,
  createProductionVisualAssetLibrary,
} from './production-visual-assets.js';
import { W8_HOUSE_HUMAN_SCALE_VISUAL_PROFILE } from './house-human-scale-visual-profile.js';
import {
  resolveW8CanonicalCandidateSet,
  resolveW8NaturalCandidateVisual,
  w8TerrainColorFromWeights,
} from './w8-distant-presentation.js';
import { resolveW8RockCanonicalObject } from '../rock-canonical-object.js';
import { resolveW8CanonicalWorldObject } from '../world-object-canonical-contract.js';
import {
  WORLD_STREAMING_EVENT,
  WORLD_STREAMING_STREAM,
  WORLD_STREAMING_TARGET,
  worldStreamingTargetForCanonicalObject,
} from '../world-streaming-telemetry.js';
import {
  resolveCanonicalGroundSurface,
  resolveCanonicalSurfaceColorRgb,
  sampleW8SurfaceHeightMeters,
} from '../w8-surface-policy.js';
import {
  buildSettlementRoadRibbonMeshData,
  createRoadRibbonHeightSampler,
} from './settlement-road-ribbon-geometry.js';
import {
  createDrawableReplacementBarrier,
  hasDrawableInCompletedFrame,
  isDrawableInCompletedFrame,
  isCompletedRenderFrameReceipt,
} from '../visual-continuity.js';

const FINITE_ROAD_SURFACE_HEIGHT_METERS = 3 / PRODUCTION_VISUAL_UNITS_PER_METER;

function requireConstructor(THREE, name) {
  if (typeof THREE?.[name] !== 'function') throw new TypeError(`THREE.${name} is required`);
  return THREE[name];
}

export class ChunkRenderAdapter {
  constructor({
    THREE,
    scene,
    renderChunkSize = RENDER_CHUNK_SIZE,
    isFeatureDestroyed = () => false,
    visualAssets = null,
    telemetry = null,
    visualRegistry = null,
  } = {}) {
    if (!scene || typeof scene.add !== 'function' || typeof scene.remove !== 'function') {
      throw new TypeError('a Three.js scene is required');
    }
    if (!SUPPORTED_RENDER_CHUNK_SIZES.includes(renderChunkSize)) {
      throw new RangeError(`renderChunkSize must be one of ${SUPPORTED_RENDER_CHUNK_SIZES.join(', ')}`);
    }
    this.THREE = THREE;
    this.scene = scene;
    this.renderChunkSize = renderChunkSize;
    this.unitsPerMeter = renderChunkSize / LOGICAL_CHUNK_SIZE_METERS;
    this.renderOriginChunkX = 0;
    this.renderOriginChunkZ = 0;
    this.loaded = new Map();
    this.provisionalTerrain = new Map();
    this.settlementPresentationHolds = new Map();
    this.disposedChunkGeometries = new WeakSet();
    if (typeof isFeatureDestroyed !== 'function') throw new TypeError('isFeatureDestroyed must be a function');
    this.isFeatureDestroyed = isFeatureDestroyed;
    this.telemetry = telemetry?.enabled === true ? telemetry : null;
    this.visualRegistry = visualRegistry;
    this.settlementReplacementBarrier = visualRegistry
      ? createDrawableReplacementBarrier({
        visualRegistry,
        // A Settlement presentation hold is the presentation-only coarse
        // drawable retained after Near gameplay/collision ownership leaves.
        // Disposal means releasing that hold only after the returning Near
        // detail has crossed an actual completed renderer receipt.
        disposeDrawable: held => this.releaseSettlementPresentationHolds({
          ownerKeys: [held.key],
          descriptors: held.descriptors,
          reason: 'near-detail-drawn',
        }),
      })
      : null;
    this.pendingFirstDrawByChunk = new Map();
    this.featureInstances = new Map();
    this.chunkFeatureIds = new Map();
    this.visibleStableIdsRevision = 0;
    this.visibleStableIdsCache = null;
    // Publication is not proof that a Near object reached the renderer.  This
    // receipt-backed set is rebuilt after every completed frame and is the
    // only Near identity source that a coarse replacement may consume.
    this.drawableStableIds = new Set();
    this.drawableStableIdsCache = Object.freeze([]);
    this.drawableStableIdsFrameSequence = 0;
    this.validatedRoadGeometry = new WeakMap();
    this.occlusionMeshes = [];
    this.cameraCollisionBounds = [];
    this.occludedFeatureIds = new Set();
    this.occlusionLastHitAt = new Map();
    this.fadedMaterials = new Map();
    this.projectionStaging = null;
    this.transparentMeshes = new Set();
    this.transparencyEnabled = true;
    this.disposed = false;
    this.visualAssets = visualAssets ?? createProductionVisualAssetLibrary({ THREE });
    this.ownsVisualAssets = visualAssets === null;
    this.settlementResources = null;
    this.counts = {
      projected: 0,
      loaded: 0,
      unloaded: 0,
      rebased: 0,
      chunkOwnedGeometriesCreated: 0,
      chunkOwnedGeometriesDisposed: 0,
    };
    this.treePathAudit = {
      pathId: 'near-tree',
      firstDrawAtMs: null,
      lastUpdateAtMs: null,
      matrixUpdateCount: 0,
      bufferUpdateCount: 0,
      visibilityChangeCount: 0,
      disposeCount: 0,
    };

    const Group = requireConstructor(THREE, 'Group');
    const PlaneGeometry = requireConstructor(THREE, 'PlaneGeometry');
    const MeshLambertMaterial = requireConstructor(THREE, 'MeshLambertMaterial');
    const TerrainMaterial = typeof THREE.MeshPhongMaterial === 'function'
      ? THREE.MeshPhongMaterial : MeshLambertMaterial;
    const Object3D = requireConstructor(THREE, 'Object3D');
    this.worldRoot = new Group();
    this.worldRoot.name = 'w1a-render-root';
    this.worldRoot.userData = { treePathId: 'near-tree', runtimeOwned: true };
    this.scene.add(this.worldRoot);
    this.geometries = Object.freeze({
      terrain: new PlaneGeometry(renderChunkSize, renderChunkSize),
    });
    this.materials = Object.freeze({
      terrain: new TerrainMaterial({ color: 0xffffff, vertexColors: true, flatShading: true, shininess: 0 }),
      naturalTerrain: new TerrainMaterial({
        color: 0xffffff,
        vertexColors: true,
        flatShading: true,
        shininess: 0,
      }),
    });
    this.materials.naturalTerrain.userData = {
      ...(this.materials.naturalTerrain.userData ?? {}),
      canonicalTerrainSurfaceMaterial: true,
      canonicalColorSource: 'canonical-surface-color',
    };
    const hiddenTransform = new Object3D();
    hiddenTransform.scale.set(0, 0, 0);
    hiddenTransform.updateMatrix();
    this.hiddenFeatureMatrix = hiddenTransform.matrix.clone?.() ?? structuredClone(hiddenTransform.matrix);
  }

  #cloneMatrix(matrix) {
    return matrix.clone?.() ?? structuredClone(matrix);
  }

  #invalidateVisibleStableIds() {
    this.visibleStableIdsRevision += 1;
    this.visibleStableIdsCache = null;
  }

  #instanceMatrixAt(mesh, slot) {
    const values = mesh?.instanceMatrix?.array ?? mesh?.instanceMatrix?.values ?? null;
    const offset = slot * 16;
    if ((!ArrayBuffer.isView(values) && !Array.isArray(values))
      || !Number.isSafeInteger(slot) || slot < 0 || values.length < offset + 16) return null;
    return values.subarray?.(offset, offset + 16) ?? values.slice(offset, offset + 16);
  }

  #drawableInstancePartEvidence(part, receipt) {
    const candidates = [part.mesh, part.fadeMesh].filter(Boolean);
    for (const mesh of candidates) {
      if (!Number.isSafeInteger(part.index) || part.index < 0
        || !(mesh.count > part.index)) continue;
      const matrix = this.#instanceMatrixAt(mesh, part.index);
      if (!matrix) continue;
      // A zero-scale matrix is the existing hidden-slot sentinel.  Finite
      // numbers alone are insufficient to call that slot drawable.
      const scaleX = Math.hypot(matrix[0], matrix[1], matrix[2]);
      const scaleY = Math.hypot(matrix[4], matrix[5], matrix[6]);
      const scaleZ = Math.hypot(matrix[8], matrix[9], matrix[10]);
      if (!(scaleX > 1e-8 && scaleY > 1e-8 && scaleZ > 1e-8)) continue;
      if (isDrawableInCompletedFrame({ mesh, receipt, matrix })) {
        return Object.freeze({ mesh, matrix });
      }
    }
    return null;
  }

  #drawableInstancePart(part, receipt) {
    return this.#drawableInstancePartEvidence(part, receipt) !== null;
  }

  #rendererAttributeValues(attribute, receipt) {
    const gpuValues = receipt?.gpuMirror?.read?.(attribute) ?? null;
    if (gpuValues) return gpuValues;
    if (ArrayBuffer.isView(attribute) || Array.isArray(attribute)) return attribute;
    const values = attribute?.array ?? attribute?.values ?? attribute ?? null;
    return ArrayBuffer.isView(values) || Array.isArray(values) ? values : null;
  }

  #drawableMergedRoadEvidence(mesh, receipt) {
    const stableIds = mesh?.userData?.sourceRoadStableIds;
    if (!Array.isArray(stableIds) || stableIds.length === 0
      || stableIds.some(stableId => typeof stableId !== 'string' || !stableId)) return null;
    const matrix = mesh.matrixWorld ?? mesh.matrix;
    if (!isDrawableInCompletedFrame({ mesh, receipt, matrix })) return null;
    const attributes = Object.values(mesh.geometry?.attributes ?? {});
    const uploadAttributes = [...attributes, mesh.geometry?.index].filter(Boolean);
    const versions = uploadAttributes.map(attribute => (
      Number.isSafeInteger(attribute?.version) ? attribute.version : 0
    ));
    const cached = this.validatedRoadGeometry.get(mesh.geometry);
    const cacheCurrent = cached
      && cached.attributes.length === uploadAttributes.length
      && cached.attributes.every((attribute, index) => (
        attribute === uploadAttributes[index] && cached.versions[index] === versions[index]
      ));
    if (cacheCurrent) return cached.valid ? Object.freeze({
      mesh,
      matrix,
      stableIds: Object.freeze([...new Set(stableIds)]),
    }) : null;
    const positionAttribute = mesh.geometry?.getAttribute?.('position')
      ?? mesh.geometry?.attributes?.position ?? null;
    const positions = this.#rendererAttributeValues(positionAttribute, receipt);
    const indices = this.#rendererAttributeValues(mesh.geometry?.index, receipt);
    for (const attribute of attributes) {
      const values = this.#rendererAttributeValues(attribute, receipt);
      if (!values || values.length === 0 || Array.from(values).some(value => !Number.isFinite(value))) {
        this.validatedRoadGeometry.set(mesh.geometry, { attributes: uploadAttributes, versions, valid: false });
        return null;
      }
    }
    if (!positions || positions.length < 9 || positions.length % 3 !== 0
      || !indices || indices.length < 3 || indices.length % 3 !== 0) {
      this.validatedRoadGeometry.set(mesh.geometry, { attributes: uploadAttributes, versions, valid: false });
      return null;
    }
    const vertexCount = positions.length / 3;
    let nonDegenerate = false;
    for (let offset = 0; offset < indices.length; offset += 3) {
      const a = Number(indices[offset]);
      const b = Number(indices[offset + 1]);
      const c = Number(indices[offset + 2]);
      if (![a, b, c].every(index => Number.isSafeInteger(index)
        && index >= 0 && index < vertexCount)) {
        this.validatedRoadGeometry.set(mesh.geometry, { attributes: uploadAttributes, versions, valid: false });
        return null;
      }
      const ax = Number(positions[a * 3]);
      const ay = Number(positions[a * 3 + 1]);
      const az = Number(positions[a * 3 + 2]);
      const abx = Number(positions[b * 3]) - ax;
      const aby = Number(positions[b * 3 + 1]) - ay;
      const abz = Number(positions[b * 3 + 2]) - az;
      const acx = Number(positions[c * 3]) - ax;
      const acy = Number(positions[c * 3 + 1]) - ay;
      const acz = Number(positions[c * 3 + 2]) - az;
      if (![ax, ay, az, abx, aby, abz, acx, acy, acz].every(Number.isFinite)) {
        this.validatedRoadGeometry.set(mesh.geometry, { attributes: uploadAttributes, versions, valid: false });
        return null;
      }
      const crossX = aby * acz - abz * acy;
      const crossY = abz * acx - abx * acz;
      const crossZ = abx * acy - aby * acx;
      if (crossX * crossX + crossY * crossY + crossZ * crossZ > Number.EPSILON) {
        nonDegenerate = true;
      }
    }
    this.validatedRoadGeometry.set(mesh.geometry, {
      attributes: uploadAttributes,
      versions,
      valid: nonDegenerate,
    });
    return nonDegenerate ? Object.freeze({
      mesh,
      matrix,
      stableIds: Object.freeze([...new Set(stableIds)]),
    }) : null;
  }

  #mergedRoadEvidenceForDescriptor(projected, descriptor, receipt) {
    const roadComponent = projected?.settlementPresentation?.components
      ?.find(component => component.kind === 'road') ?? null;
    for (const mesh of roadComponent?.meshes ?? []) {
      const evidence = this.#drawableMergedRoadEvidence(mesh, receipt);
      if (evidence?.stableIds.includes(descriptor.projectionIdentity)) return evidence;
    }
    return null;
  }

  #recordDrawableMergedRoads(presentation, receipt, drawable) {
    const declared = new Set((presentation?.descriptors ?? [])
      .filter(descriptor => descriptor.kind === 'road')
      .map(descriptor => descriptor.projectionIdentity));
    const roadComponent = presentation?.components
      ?.find(component => component.kind === 'road') ?? null;
    for (const mesh of roadComponent?.meshes ?? []) {
      const evidence = this.#drawableMergedRoadEvidence(mesh, receipt);
      if (!evidence) continue;
      const stableIds = evidence.stableIds.filter(stableId => (
        declared.has(stableId) && !this.isFeatureDestroyed(stableId)
      ));
      for (const stableId of stableIds) drawable.add(stableId);
      if (stableIds.length > 0) {
        this.visualRegistry?.acknowledgeCoarseComponent?.({
          ownerKey: presentation.ownerKey,
          component: 'structure',
          stableIds,
          receipt,
          drawable: evidence,
        });
      }
    }
  }

  #acknowledgeSettlementReplacements(receipt) {
    if (!this.settlementReplacementBarrier) return 0;
    let released = 0;
    for (const projected of this.loaded.values()) {
      const held = projected.settlementReplacementHold ?? null;
      if (!held) continue;
      const evidence = [];
      let allDrawn = true;
      for (const descriptor of held.descriptors) {
        if (this.isFeatureDestroyed(descriptor.projectionIdentity)) continue;
        const actual = descriptor.kind === 'road'
          ? this.#mergedRoadEvidenceForDescriptor(projected, descriptor, receipt)
          : this.featureInstances.get(descriptor.projectionIdentity)?.parts
            ?.map(part => this.#drawableInstancePartEvidence(part, receipt))
            .find(Boolean) ?? null;
        if (!actual) {
          allDrawn = false;
          break;
        }
        evidence.push(actual);
      }
      if (!allDrawn) continue;
      // A fully destroyed held component no longer needs visual replacement;
      // release it explicitly instead of manufacturing renderer evidence for
      // an invisible slot.
      if (evidence.length === 0) {
        this.settlementReplacementBarrier.release(projected.key);
        projected.settlementReplacementHold = null;
        released += 1;
        continue;
      }
      const visualOwner = this.visualRegistry?.get?.(projected.key) ?? null;
      if (!visualOwner || visualOwner.retiringAt !== null) {
        // The lifecycle denominator may retire while a returning Near owner
        // is waiting. The completed receipt above still proves NEW before OLD
        // is released, without leaving an unacknowledgeable retained entry.
        this.settlementReplacementBarrier.release(projected.key);
        projected.settlementReplacementHold = null;
        released += 1;
        continue;
      }
      const acknowledged = this.settlementReplacementBarrier.acknowledgeReplacement({
        ownerKey: projected.key,
        level: 'detail',
        receipt,
        drawable: evidence[0],
      });
      if (!acknowledged) continue;
      projected.settlementReplacementHold = null;
      released += 1;
    }
    return released;
  }

  #recordDrawableStableIds(receipt) {
    const drawable = new Set();
    for (const [stableId, entry] of this.featureInstances) {
      if (entry.destroyed === true || this.isFeatureDestroyed(stableId)) continue;
      if (entry.parts.some(part => this.#drawableInstancePart(part, receipt))) {
        drawable.add(stableId);
      }
    }
    for (const held of this.settlementPresentationHolds.values()) {
      for (const [stableId, entry] of held.featureEntries) {
        if (entry?.destroyed === true || this.isFeatureDestroyed(stableId)) continue;
        if (entry?.parts?.some(part => this.#drawableInstancePart(part, receipt))) {
          drawable.add(stableId);
        }
      }
      this.#recordDrawableMergedRoads({
        ownerKey: held.key,
        descriptors: held.descriptors,
        components: [...held.components.values()],
      }, receipt, drawable);
    }
    for (const projected of this.loaded.values()) {
      this.#recordDrawableMergedRoads({
        ...projected.settlementPresentation,
        ownerKey: projected.key,
      }, receipt, drawable);
    }
    this.drawableStableIds = drawable;
    this.drawableStableIdsCache = Object.freeze([...drawable]
      .sort((left, right) => left.localeCompare(right)));
    this.drawableStableIdsFrameSequence = receipt.frameSequence;
    return drawable;
  }

  #registry() {
    return this.projectionStaging ?? {
      featureInstances: this.featureInstances,
      chunkFeatureIds: this.chunkFeatureIds,
      occlusionMeshes: this.occlusionMeshes,
      cameraCollisionBounds: this.cameraCollisionBounds,
      transparentMeshes: this.transparentMeshes,
    };
  }

  #createProjectionRegistry() {
    return {
      featureInstances: new Map(),
      chunkFeatureIds: new Map(),
      occlusionMeshes: [],
      cameraCollisionBounds: [],
      transparentMeshes: new Set(),
    };
  }

  #commitProjectedRegistry(projected) {
    const registry = projected?.registry;
    if (!registry) return;
    for (const [stableId, entry] of registry.featureInstances) {
      const existing = this.featureInstances.get(stableId);
      if (existing && existing.chunkKey !== entry.chunkKey) {
        throw new Error(`Stable ID collision in render adapter: ${stableId}`);
      }
      this.featureInstances.set(stableId, entry);
    }
    for (const [chunkKey, stableIds] of registry.chunkFeatureIds) {
      this.chunkFeatureIds.set(chunkKey, stableIds);
    }
    this.occlusionMeshes.push(...registry.occlusionMeshes);
    this.cameraCollisionBounds.push(...registry.cameraCollisionBounds);
    for (const mesh of registry.transparentMeshes) this.transparentMeshes.add(mesh);
  }

  #removeProjectedRegistry(projected) {
    const key = projected.key;
    const groupMeshes = new Set(projected.group.children ?? []);
    this.occlusionMeshes = this.occlusionMeshes.filter(mesh => !groupMeshes.has(mesh));
    this.cameraCollisionBounds = this.cameraCollisionBounds.filter(bound => bound.chunkKey !== key);
    for (const mesh of groupMeshes) this.transparentMeshes.delete(mesh);
    for (const stableId of this.chunkFeatureIds.get(key) ?? []) {
      this.featureInstances.delete(stableId);
      this.occludedFeatureIds.delete(stableId);
      this.occlusionLastHitAt.delete(stableId);
    }
    this.chunkFeatureIds.delete(key);
  }

  #registerFeatureInstance({
    stableId, chunkKey, mesh, fadeMesh = null, index, matrix, group, canonicalObject = null,
    treePathId = null,
  }) {
    if (typeof stableId !== 'string' || !stableId) throw new Error(`invalid render feature Stable ID: ${chunkKey}`);
    const registry = this.#registry();
    let existing = registry.featureInstances.get(stableId) ?? this.featureInstances.get(stableId);
    if (existing && existing.chunkKey !== chunkKey) {
      throw new Error(`Stable ID collision in render adapter: ${stableId}`);
    }
    const part = { mesh, fadeMesh, index, originalMatrix: this.#cloneMatrix(matrix) };
    if (!existing) {
      existing = {
        stableId, chunkKey, mesh, index, originalMatrix: part.originalMatrix,
        parts: [], group, rubbleMesh: null, canonicalObject, treePathId,
      };
      registry.featureInstances.set(stableId, existing);
    }
    existing.parts.push(part);
    if (!registry.chunkFeatureIds.has(chunkKey)) registry.chunkFeatureIds.set(chunkKey, new Set());
    registry.chunkFeatureIds.get(chunkKey).add(stableId);
    const destroyed = this.isFeatureDestroyed(stableId);
    existing.destroyed = destroyed;
    mesh.setMatrixAt(index, destroyed ? this.hiddenFeatureMatrix : part.originalMatrix);
    fadeMesh?.setMatrixAt(index, this.hiddenFeatureMatrix);
  }

  setFeatureDestroyed(stableId, destroyed = true) {
    const entry = this.featureInstances.get(stableId)
      ?? [...this.settlementPresentationHolds.values()]
        .map(held => held.featureEntries.get(stableId))
        .find(Boolean);
    if (!entry) return false;
    const nextDestroyed = destroyed === true;
    const visibilityChanged = entry.destroyed !== nextDestroyed;
    if (entry.destroyed !== nextDestroyed) {
      entry.destroyed = nextDestroyed;
      this.#invalidateVisibleStableIds();
    }
    const occluded = this.occludedFeatureIds.has(stableId);
    for (const part of entry.parts) {
      part.mesh.setMatrixAt(part.index, nextDestroyed || occluded
        ? this.hiddenFeatureMatrix : part.originalMatrix);
      part.mesh.instanceMatrix.needsUpdate = true;
      if (part.fadeMesh) {
        part.fadeMesh.setMatrixAt(part.index, !nextDestroyed && occluded
          ? part.originalMatrix : this.hiddenFeatureMatrix);
        part.fadeMesh.instanceMatrix.needsUpdate = true;
      }
    }
    if (entry.treePathId === 'near-tree') {
      this.treePathAudit.matrixUpdateCount += entry.parts.length;
      this.treePathAudit.bufferUpdateCount += entry.parts.reduce(
        (sum, part) => sum + 1 + Number(Boolean(part.fadeMesh)), 0,
      );
      this.treePathAudit.visibilityChangeCount += Number(visibilityChanged);
      this.treePathAudit.lastUpdateAtMs = globalThis.performance?.now?.() ?? Date.now();
    }
    const destructionPresentation = entry.canonicalObject?.destruction?.presentation ?? 'rubble';
    if (nextDestroyed && destructionPresentation === 'rubble' && !entry.rubbleMesh) {
      const Mesh = requireConstructor(this.THREE, 'Mesh');
      const rubble = new Mesh(
        this.visualAssets.geometries.dodeca,
        this.visualAssets.materials.scorch ?? this.visualAssets.materials.charred,
      );
      rubble.name = 'w8-persistent-destruction-rubble';
      rubble.matrixAutoUpdate = false;
      if (rubble.matrix?.copy) rubble.matrix.copy(entry.originalMatrix);
      else rubble.matrix = this.#cloneMatrix(entry.originalMatrix);
      rubble.castShadow = true; rubble.receiveShadow = true;
      entry.group?.add?.(rubble);
      entry.rubbleMesh = rubble;
    } else if ((!nextDestroyed || destructionPresentation !== 'rubble') && entry.rubbleMesh) {
      entry.group?.remove?.(entry.rubbleMesh);
      entry.rubbleMesh = null;
    }
    return true;
  }

  setFeatureOccluded(stableId, occluded = true) {
    const entry = this.featureInstances.get(stableId);
    if (!entry || !entry.parts.some(part => part.fadeMesh)) return false;
    if (occluded) this.occludedFeatureIds.add(stableId);
    else this.occludedFeatureIds.delete(stableId);
    return this.setFeatureDestroyed(stableId, this.isFeatureDestroyed(stableId));
  }

  resolveCameraCollision({ camera, target, clearanceMeters = 0.6 } = {}) {
    if (!camera?.position || !target || !this.cameraCollisionBounds.length) {
      return Object.freeze({ collided: false, stableId: null, desiredDistance: 0, resolvedDistance: 0 });
    }
    const desiredDistance = Math.hypot(
      camera.position.x - target.x,
      camera.position.y - target.y,
      camera.position.z - target.z,
    );
    if (!Number.isFinite(desiredDistance)) {
      return Object.freeze({ collided: false, stableId: null, desiredDistance: 0, resolvedDistance: 0 });
    }
    const clearanceRender = Math.max(0, clearanceMeters) * this.unitsPerMeter;
    let collidedStableId = null;
    let collisionCount = 0;
    for (let pass = 0; pass < 4; pass += 1) {
      let resolvedThisPass = false;
      for (const bound of this.cameraCollisionBounds) {
        if (this.isFeatureDestroyed(bound.stableId)) continue;
        const centerX = (bound.worldX
          - this.renderOriginChunkX * LOGICAL_CHUNK_SIZE_METERS) * this.unitsPerMeter;
        const centerZ = (bound.worldZ
          - this.renderOriginChunkZ * LOGICAL_CHUNK_SIZE_METERS) * this.unitsPerMeter;
        const dx = camera.position.x - centerX;
        const dz = camera.position.z - centerZ;
        const cosine = Math.cos(bound.rotationY);
        const sine = Math.sin(bound.rotationY);
        const localX = cosine * dx - sine * dz;
        const localZ = sine * dx + cosine * dz;
        const topY = bound.groundY + bound.height;
        if (Math.abs(localX) >= bound.halfWidth || Math.abs(localZ) >= bound.halfDepth
          || camera.position.y <= bound.groundY || camera.position.y >= topY) continue;

        const sideX = bound.halfWidth - Math.abs(localX);
        const sideZ = bound.halfDepth - Math.abs(localZ);
        const top = topY - camera.position.y;
        if (top <= sideX && top <= sideZ) {
          camera.position.y = topY + clearanceRender;
        } else {
          let pushedLocalX = localX;
          let pushedLocalZ = localZ;
          if (sideX <= sideZ) {
            pushedLocalX = (localX < 0 ? -1 : 1) * (bound.halfWidth + clearanceRender);
          } else {
            pushedLocalZ = (localZ < 0 ? -1 : 1) * (bound.halfDepth + clearanceRender);
          }
          camera.position.x = centerX + cosine * pushedLocalX + sine * pushedLocalZ;
          camera.position.z = centerZ - sine * pushedLocalX + cosine * pushedLocalZ;
        }
        collidedStableId ??= bound.stableId;
        collisionCount += 1;
        resolvedThisPass = true;
      }
      if (!resolvedThisPass) break;
    }
    const resolvedDistance = Math.hypot(
      camera.position.x - target.x,
      camera.position.y - target.y,
      camera.position.z - target.z,
    );
    return Object.freeze({
      collided: collisionCount > 0,
      stableId: collidedStableId,
      desiredDistance,
      resolvedDistance,
    });
  }

  clearCameraOcclusion() {
    for (const stableId of [...this.occludedFeatureIds]) this.setFeatureOccluded(stableId, false);
    this.occlusionLastHitAt.clear();
    return 0;
  }

  updateCameraOcclusion({
    camera, target, nowMs = Date.now(), restoreDelayMs = 120, enabled = true,
  } = {}) {
    if (!enabled) return this.clearCameraOcclusion();
    if (!this.transparencyEnabled) return 0;
    const Raycaster = this.THREE?.Raycaster;
    const Vector3 = this.THREE?.Vector3;
    if (typeof Raycaster !== 'function' || typeof Vector3 !== 'function'
      || !camera?.position || !target || !this.occlusionMeshes.length) return 0;
    const origin = new Vector3(camera.position.x, camera.position.y, camera.position.z);
    const direction = new Vector3(target.x - origin.x, target.y - origin.y, target.z - origin.z);
    const distance = direction.length();
    if (!Number.isFinite(distance) || distance <= 0) return 0;
    direction.normalize();
    const raycaster = new Raycaster(origin, direction, 0, distance);
    const next = new Set();
    for (const hit of raycaster.intersectObjects(this.occlusionMeshes, false)) {
      const stableId = hit.object?.userData?.featureStableIds?.[hit.instanceId];
      if (stableId) next.add(stableId);
    }
    for (const stableId of next) this.occlusionLastHitAt.set(stableId, nowMs);
    for (const stableId of this.occludedFeatureIds) {
      const lastHitAt = this.occlusionLastHitAt.get(stableId) ?? -Infinity;
      if (!next.has(stableId) && nowMs - lastHitAt >= restoreDelayMs) {
        this.setFeatureOccluded(stableId, false);
        this.occlusionLastHitAt.delete(stableId);
      }
    }
    for (const stableId of next) this.setFeatureOccluded(stableId, true);
    return next.size;
  }

  refreshFeatureStates() {
    for (const stableId of this.featureInstances.keys()) {
      this.setFeatureDestroyed(stableId, this.isFeatureDestroyed(stableId));
    }
  }

  async rebase(origin) {
    if (this.disposed) throw new Error('render adapter is shut down');
    this.renderOriginChunkX = origin.renderOriginChunkX;
    this.renderOriginChunkZ = origin.renderOriginChunkZ;
    for (const projected of this.loaded.values()) this.#positionGroup(projected);
    for (const projected of this.provisionalTerrain.values()) this.#positionGroup(projected);
    for (const held of this.settlementPresentationHolds.values()) this.#positionGroup(held);
    if (origin.rebaseCount > this.counts.rebased) this.counts.rebased = origin.rebaseCount;
  }

  #positionGroup(projected, origin = null) {
    const renderOriginChunkX = origin?.renderOriginChunkX ?? this.renderOriginChunkX;
    const renderOriginChunkZ = origin?.renderOriginChunkZ ?? this.renderOriginChunkZ;
    const position = chunkRenderPosition(
      projected.chunkX,
      projected.chunkZ,
      renderOriginChunkX,
      renderOriginChunkZ,
      this.renderChunkSize,
    );
    projected.group.position.set(position.x, 0, position.z);
  }

  presentationHoldSnapshot() {
    return Object.freeze([...this.settlementPresentationHolds.values()].map(held => Object.freeze({
      ownerKey: held.key,
      heldAtMs: held.heldAtMs,
      descriptors: held.descriptors,
    })));
  }

  releaseSettlementPresentationHolds({ ownerKeys = [], descriptors = [], reason = 'covered' } = {}) {
    const requestedOwners = new Set(ownerKeys);
    for (const descriptor of descriptors) {
      if (typeof descriptor?.ownerKey === 'string') requestedOwners.add(descriptor.ownerKey);
    }
    const descriptorKey = descriptor => [
      descriptor.kind,
      descriptor.sourceIdentity,
      descriptor.projectionIdentity,
      descriptor.ownerKey,
    ].join('\n');
    const requestedDescriptorKeys = new Set(descriptors.map(descriptorKey));
    const releaseAllForOwner = requestedDescriptorKeys.size === 0;
    const releasedOwnerKeys = [];
    const releasedProjectionIdentities = [];
    for (const ownerKey of requestedOwners) {
      const held = this.settlementPresentationHolds.get(ownerKey);
      if (!held) continue;
      for (const [kind, component] of [...held.components]) {
        const componentRequested = releaseAllForOwner || component.descriptors.every(descriptor => (
          requestedDescriptorKeys.has(descriptorKey(descriptor))
        ));
        if (!componentRequested) continue;
        for (const mesh of component.meshes) {
          held.group.remove(mesh);
          mesh.dispose?.();
        }
        for (const geometry of component.ownedGeometries) {
          geometry.dispose?.();
          this.disposedChunkGeometries.add(geometry);
          this.counts.chunkOwnedGeometriesDisposed += 1;
        }
        for (const descriptor of component.descriptors) {
          held.featureEntries.delete(descriptor.projectionIdentity);
          releasedProjectionIdentities.push(descriptor.projectionIdentity);
        }
        held.components.delete(kind);
      }
      held.descriptors = Object.freeze([...held.components.values()]
        .flatMap(component => component.descriptors));
      if (held.components.size === 0) {
        this.worldRoot.remove(held.group);
        for (const child of held.group.children ?? []) child.dispose?.();
        held.group.clear?.();
        held.lifecycle = 'released';
        held.releaseReason = reason;
        this.settlementPresentationHolds.delete(ownerKey);
        releasedOwnerKeys.push(ownerKey);
      }
    }
    const remainingDescriptorKeys = new Set(
      [...this.settlementPresentationHolds.values()]
        .flatMap(held => held.descriptors.map(descriptorKey)),
    );
    const released = releaseAllForOwner
      ? [...requestedOwners].every(ownerKey => !this.settlementPresentationHolds.has(ownerKey))
      : [...requestedDescriptorKeys].every(key => !remainingDescriptorKeys.has(key));
    if (releasedProjectionIdentities.length > 0) this.#invalidateVisibleStableIds();
    return Object.freeze({
      released,
      releasedAtMs: releasedProjectionIdentities.length > 0
        ? globalThis.performance?.now?.() ?? Date.now() : null,
      releasedOwnerKeys: Object.freeze(releasedOwnerKeys),
      releasedProjectionIdentities: Object.freeze(releasedProjectionIdentities),
    });
  }

  #holdSettlementPresentation(projected) {
    const presentation = projected.settlementPresentation;
    if (!presentation?.meshes?.length || !presentation.descriptors?.length) return false;
    // Rapid reversal: this returning Near projection has not yet crossed the
    // renderer receipt which would release the previously retained coarse
    // hold. Do not replace that proven OLD drawable with an unproven NEW one;
    // let unloadChunk discard the returning projection normally while OLD
    // remains available for the next handoff attempt.
    if (projected.settlementReplacementHold
      && this.settlementPresentationHolds.get(projected.key)
        === projected.settlementReplacementHold) {
      projected.settlementReplacementHold = null;
      return false;
    }
    this.releaseSettlementPresentationHolds({
      ownerKeys: [projected.key],
      reason: 'replaced-hold',
    });
    const heldMeshes = new Set(presentation.meshes);
    const heldGeometries = new Set(presentation.ownedGeometries ?? []);
    const heldFeatureEntries = new Map();
    for (const descriptor of presentation.descriptors) {
      const entry = this.featureInstances.get(descriptor.projectionIdentity);
      if (entry) heldFeatureEntries.set(descriptor.projectionIdentity, entry);
    }
    this.#removeProjectedRegistry(projected);
    for (const child of [...(projected.group.children ?? [])]) {
      if (heldMeshes.has(child)) continue;
      projected.group.remove(child);
      child.dispose?.();
    }
    for (const geometry of projected.ownedGeometries ?? []) {
      if (heldGeometries.has(geometry)) continue;
      geometry.dispose?.();
      this.disposedChunkGeometries.add(geometry);
      this.counts.chunkOwnedGeometriesDisposed += 1;
    }
    const held = {
      key: projected.key,
      chunkX: projected.chunkX,
      chunkZ: projected.chunkZ,
      group: projected.group,
      descriptors: presentation.descriptors,
      components: new Map(presentation.components.map(component => [component.kind, {
        ...component,
      }])),
      featureEntries: heldFeatureEntries,
      heldAtMs: globalThis.performance?.now?.() ?? Date.now(),
      lifecycle: 'held',
    };
    this.settlementPresentationHolds.set(projected.key, held);
    this.loaded.delete(projected.key);
    projected.lifecycle = 'presentation-held';
    this.pendingFirstDrawByChunk.delete(projected.key);
    this.#invalidateVisibleStableIds();
    this.counts.unloaded += 1;
    return true;
  }

  #createNaturalTerrainGeometry(chunkData) {
    const BufferGeometry = requireConstructor(this.THREE, 'BufferGeometry');
    const Float32BufferAttribute = requireConstructor(this.THREE, 'Float32BufferAttribute');
    const terrain = chunkData.terrain;
    const width = terrain.resolution.x;
    const depth = terrain.resolution.z;
    const positions = [];
    const colors = [];
    const indices = [];
    for (let z = 0; z < depth; z += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = z * width + x;
        const worldX = chunkData.chunkX * LOGICAL_CHUNK_SIZE_METERS
          + x / (width - 1) * LOGICAL_CHUNK_SIZE_METERS;
        const worldZ = chunkData.chunkZ * LOGICAL_CHUNK_SIZE_METERS
          + z / (depth - 1) * LOGICAL_CHUNK_SIZE_METERS;
        const surface = resolveCanonicalGroundSurface({ chunkData, worldX, worldZ });
        positions.push(x / (width - 1) * this.renderChunkSize,
          surface.heightMeters * this.unitsPerMeter,
          z / (depth - 1) * this.renderChunkSize);
        const weights = terrain.materialWeights.slice(index * 5, index * 5 + 5);
        const naturalColor = w8TerrainColorFromWeights(weights);
        colors.push(...resolveCanonicalSurfaceColorRgb({
          naturalColor, surface, worldX, worldZ,
        }));
      }
    }
    for (let z = 0; z < depth - 1; z += 1) {
      for (let x = 0; x < width - 1; x += 1) {
        const northwest = z * width + x;
        const northeast = northwest + 1;
        const southwest = northwest + width;
        const southeast = southwest + 1;
        indices.push(northwest, southwest, northeast, northeast, southwest, southeast);
      }
    }
    for (let offset = 0; offset < colors.length; offset += 3) {
      if (![colors[offset], colors[offset + 1], colors[offset + 2]].every(Number.isFinite)
        || (colors[offset] === 0 && colors[offset + 1] === 0 && colors[offset + 2] === 0)) {
        throw new Error(`invalid canonical Terrain color at High vertex ${offset / 3}`);
      }
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
    geometry.setAttribute('color', new Float32BufferAttribute(colors, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    this.counts.chunkOwnedGeometriesCreated += 1;
    return geometry;
  }

  #createSettlementRoadGeometry(chunkData, roads) {
    const BufferGeometry = requireConstructor(this.THREE, 'BufferGeometry');
    const Float32BufferAttribute = requireConstructor(this.THREE, 'Float32BufferAttribute');
    const chunkMinimumX = chunkData.chunkX * LOGICAL_CHUNK_SIZE_METERS;
    const chunkMinimumZ = chunkData.chunkZ * LOGICAL_CHUNK_SIZE_METERS;
    const heightAt = createRoadRibbonHeightSampler(
      roads,
      (road, point) => Number.isFinite(point.y)
        ? point.y : sampleW8SurfaceHeightMeters(chunkData, point.x, point.z),
    );
    const meshData = buildSettlementRoadRibbonMeshData({
      roads,
      heightAt,
      originX: chunkMinimumX,
      originZ: chunkMinimumZ,
      unitsPerMeter: this.unitsPerMeter,
      surfaceOffsetMeters: FINITE_ROAD_SURFACE_HEIGHT_METERS,
      clipBounds: {
        minX: chunkMinimumX,
        minZ: chunkMinimumZ,
        maxX: chunkMinimumX + LOGICAL_CHUNK_SIZE_METERS,
        maxZ: chunkMinimumZ + LOGICAL_CHUNK_SIZE_METERS,
      },
    });
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(meshData.positions, 3));
    geometry.setAttribute('normal', new Float32BufferAttribute(meshData.normals, 3));
    if (typeof geometry.setIndex === 'function') geometry.setIndex([...meshData.indices]);
    else geometry.index = meshData.indices;
    geometry.userData = { roadRibbon: meshData.stats, roadRibbonHash: meshData.hash };
    this.counts.chunkOwnedGeometriesCreated += 1;
    return geometry;
  }

  async projectTerrainChunk(chunkData, origin = null) {
    if (this.disposed) throw new Error('render adapter is shut down');
    if (!chunkData) throw new TypeError('ChunkData is required for rendering');
    const { Group, Mesh } = this.THREE;
    requireConstructor(this.THREE, 'Group');
    requireConstructor(this.THREE, 'Mesh');
    const key = createChunkKey(chunkData.chunkX, chunkData.chunkZ);
    if (this.loaded.has(key) || this.provisionalTerrain.has(key)) {
      throw new Error(`Terrain owner is already published: ${key}`);
    }
    const group = new Group();
    group.name = `w1a-provisional-terrain-${key}`;
    group.userData = {
      chunkKey: key,
      chunkId: chunkData.chunkId,
      contentHash: chunkData.contentHash,
      provisionalTerrain: true,
    };
    const naturalTerrain = chunkData.terrain.resolution.x > 2 || chunkData.terrain.resolution.z > 2;
    const terrainGeometry = naturalTerrain
      ? this.#createNaturalTerrainGeometry(chunkData)
      : this.geometries.terrain;
    const terrain = new Mesh(
      terrainGeometry,
      naturalTerrain ? this.materials.naturalTerrain : this.materials.terrain,
    );
    terrain.name = naturalTerrain ? 'w2-natural-terrain' : 'w1a-terrain';
    terrain.receiveShadow = true;
    terrain.userData = {
      ...(terrain.userData ?? {}),
      logicalTerrainSurface: true,
      terrainLodBand: 'high',
      boundaryOwner: 'inner-band',
    };
    if (!naturalTerrain) {
      terrain.rotation.x = -Math.PI / 2;
      terrain.position.set(this.renderChunkSize / 2, 0, this.renderChunkSize / 2);
    }
    group.add(terrain);
    const projected = {
      key,
      chunkX: chunkData.chunkX,
      chunkZ: chunkData.chunkZ,
      group,
      terrain,
      ownedGeometries: naturalTerrain ? [terrainGeometry] : [],
      lifecycle: 'staged-terrain',
    };
    this.#positionGroup(projected, origin);
    return projected;
  }

  async loadProjectedTerrain(projected) {
    if (!projected?.key || !projected.group || !projected.terrain) {
      throw new TypeError('invalid projected Terrain');
    }
    if (projected.lifecycle !== 'staged-terrain') {
      throw new Error(`Terrain owner is not staged for load: ${projected.key}:${projected.lifecycle}`);
    }
    if (this.loaded.has(projected.key) || this.provisionalTerrain.has(projected.key)) {
      throw new Error(`Terrain owner is already published: ${projected.key}`);
    }
    this.#positionGroup(projected);
    this.worldRoot.add(projected.group);
    this.provisionalTerrain.set(projected.key, projected);
    projected.lifecycle = 'provisional';
  }

  #ensureSettlementResources() {
    if (this.settlementResources) return this.settlementResources;
    const PlaneGeometry = requireConstructor(this.THREE, 'PlaneGeometry');
    this.settlementResources = Object.freeze({
      geometries: Object.freeze({ road: new PlaneGeometry(1, 1) }),
      materials: Object.freeze({
        road: this.visualAssets.materials.road,
        lotResidential: this.visualAssets.materials.lotResidential ?? this.visualAssets.materials.road,
        lotCivic: this.visualAssets.materials.lotCivic ?? this.visualAssets.materials.road,
      }),
    });
    return this.settlementResources;
  }

  #fadeMaterialFor(materialKey) {
    if (this.fadedMaterials.has(materialKey)) return this.fadedMaterials.get(materialKey);
    const source = this.visualAssets.materials[materialKey];
    const faded = typeof source.clone === 'function'
      ? source.clone()
      : new source.constructor({ ...(source.options ?? {}) });
    faded.transparent = true;
    faded.opacity = 0.25;
    faded.depthWrite = false;
    if (faded.options) Object.assign(faded.options, { transparent: true, opacity: 0.25, depthWrite: false });
    faded.needsUpdate = true;
    this.fadedMaterials.set(materialKey, faded);
    return faded;
  }

  #createProductionPartMeshes({
    group, chunkKey, name, items, castShadow = true, cameraOccludable = false,
    attach = true,
  }) {
    if (!items.length) return [];
    const InstancedMesh = requireConstructor(this.THREE, 'InstancedMesh');
    const byResource = new Map();
    for (const item of items) {
      const resourceKey = `${item.part.geometry}:${item.part.material}`;
      if (!byResource.has(resourceKey)) byResource.set(resourceKey, []);
      byResource.get(resourceKey).push(item);
    }
    const meshes = [];
    for (const [resourceKey, resourceItems] of byResource) {
      const descriptor = resourceItems[0].part;
      const mesh = new InstancedMesh(
        this.visualAssets.geometries[descriptor.geometry],
        this.visualAssets.materials[descriptor.material],
        Math.max(1, resourceItems.length),
      );
      mesh.name = `${name}-${resourceKey.replace(':', '-')}`;
      mesh.castShadow = castShadow;
      mesh.receiveShadow = true;
      mesh.count = resourceItems.length;
      mesh.userData.featureStableIds = [];
      mesh.userData.treePathId = resourceItems.some(item => item.treePathId === 'near-tree')
        ? 'near-tree' : null;
      mesh.userData.treeStableIds = [];
      let fadeMesh = null;
      if (cameraOccludable) {
        fadeMesh = new InstancedMesh(
          this.visualAssets.geometries[descriptor.geometry],
          this.#fadeMaterialFor(descriptor.material),
          Math.max(1, resourceItems.length),
        );
        fadeMesh.name = `${mesh.name}-camera-faded`;
        fadeMesh.castShadow = false;
        fadeMesh.receiveShadow = false;
        fadeMesh.count = resourceItems.length;
        fadeMesh.userData.featureStableIds = [];
      }
      resourceItems.forEach((item, index) => {
        mesh.setMatrixAt(index, item.matrix);
        mesh.userData.featureStableIds[index] = item.stableId;
        if (item.treePathId === 'near-tree') mesh.userData.treeStableIds.push(item.stableId);
        if (fadeMesh) fadeMesh.userData.featureStableIds[index] = item.stableId;
        this.#registerFeatureInstance({
          stableId: item.stableId,
          chunkKey,
          mesh,
          fadeMesh,
          index,
          matrix: item.matrix,
          group,
          canonicalObject: item.canonicalObject ?? null,
          treePathId: item.treePathId ?? null,
        });
      });
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.userData.treePathId === 'near-tree') {
        this.treePathAudit.matrixUpdateCount += mesh.userData.treeStableIds.length;
        this.treePathAudit.bufferUpdateCount += 1;
        this.treePathAudit.lastUpdateAtMs = globalThis.performance?.now?.() ?? Date.now();
      }
      if (attach) group.add(mesh);
      meshes.push(mesh);
      if (fadeMesh) {
        fadeMesh.instanceMatrix.needsUpdate = true;
        if (attach) group.add(fadeMesh);
        fadeMesh.visible = this.transparencyEnabled;
        this.#registry().transparentMeshes.add(fadeMesh);
        meshes.push(fadeMesh);
        this.#registry().occlusionMeshes.push(mesh, fadeMesh);
      }
    }
    return meshes;
  }

  async projectChunk(chunkData, origin = null, { deferredRegistration = false } = {}) {
    if (this.disposed) throw new Error('render adapter is shut down');
    if (!chunkData) throw new TypeError('ChunkData is required for rendering');
    if (deferredRegistration && this.projectionStaging !== null) {
      throw new Error('Chunk projection is already in progress');
    }
    const { Group, Mesh, InstancedMesh, Object3D } = this.THREE;
    for (const name of ['Group', 'Mesh', 'InstancedMesh', 'Object3D']) {
      requireConstructor(this.THREE, name);
    }
    const key = createChunkKey(chunkData.chunkX, chunkData.chunkZ);
    if (deferredRegistration) this.projectionStaging = this.#createProjectionRegistry();
    try {
    const layers = chunkData.presentationLayers;
    const usesW8CanonicalObjects = (chunkData.generatorVersion?.major ?? 0) >= 800;
    const canonicalCandidates = resolveW8CanonicalCandidateSet(chunkData);
    const { vegetation, rocks } = canonicalCandidates;
    const settlementFeatures = layers?.formal?.roadsAndBuildings ?? chunkData.settlementFeatures ?? [];
    const waterSurfaces = layers?.water ?? chunkData.waterSurfaces ?? [];
    const ambientDetails = layers?.ambientDetails ?? chunkData.ambientDetails ?? [];
    const settlementLandmarks = layers?.landmarks ?? chunkData.settlementLandmarks ?? [];
    const streetDetails = layers?.streetDetails ?? chunkData.streetDetails ?? [];
    const group = new Group();
    group.name = `w1a-chunk-${key}`;
    group.userData = { chunkKey: key, chunkId: chunkData.chunkId, contentHash: chunkData.contentHash };
    const layerMeshes = {
      roads: [], lots: [], buildings: [], water: [], formalDetails: [],
      vegetation: [], rocks: [], ambientDetails: [],
    };
    const settlementPresentationDescriptors = [];
    let roadRibbonGeometry = null;

    const naturalTerrain = chunkData.terrain.resolution.x > 2 || chunkData.terrain.resolution.z > 2;
    const terrainGeometry = naturalTerrain
      ? this.#createNaturalTerrainGeometry(chunkData)
      : this.geometries.terrain;
    const terrain = new Mesh(
      terrainGeometry,
      naturalTerrain ? this.materials.naturalTerrain : this.materials.terrain,
    );
    terrain.name = naturalTerrain ? 'w2-natural-terrain' : 'w1a-terrain';
    terrain.receiveShadow = true;
    terrain.userData = {
      ...(terrain.userData ?? {}),
      logicalTerrainSurface: true,
      terrainLodBand: 'high',
      boundaryOwner: 'inner-band',
    };
    if (!naturalTerrain) {
      terrain.rotation.x = -Math.PI / 2;
      terrain.position.set(this.renderChunkSize / 2, 0, this.renderChunkSize / 2);
    }
    group.add(terrain);

    const transform = new Object3D();
    const createPartMatrix = ({ localX, localZ, groundY, rotationY, width, height, depth, part }) => {
      const offsetX = part.position[0] * width;
      const offsetZ = part.position[2] * depth;
      const cosine = Math.cos(rotationY);
      const sine = Math.sin(rotationY);
      transform.position.set(
        localX * this.unitsPerMeter + offsetX * cosine + offsetZ * sine,
        groundY + part.position[1] * height,
        localZ * this.unitsPerMeter - offsetX * sine + offsetZ * cosine,
      );
      transform.rotation.set(
        part.rotation[0],
        rotationY + part.rotation[1],
        part.rotation[2],
      );
      transform.scale.set(
        width * part.scale[0],
        height * part.scale[1],
        depth * part.scale[2],
      );
      transform.updateMatrix();
      return this.#cloneMatrix(transform.matrix);
    };

    const vegetationParts = [];
    vegetation.forEach(candidate => {
      const formal = candidate.candidateId !== undefined;
      const canonical = usesW8CanonicalObjects && formal
        && candidate.worldPosition && candidate.owningChunkCoordinate
        ? resolveW8CanonicalWorldObject(candidate) : null;
      const localX = formal
        ? (canonical?.position.x ?? candidate.worldPosition.x)
          - chunkData.chunkX * LOGICAL_CHUNK_SIZE_METERS
        : candidate.logicalLocalX;
      const localZ = formal
        ? (canonical?.position.z ?? candidate.worldPosition.z)
          - chunkData.chunkZ * LOGICAL_CHUNK_SIZE_METERS
        : candidate.logicalLocalZ;
      const groundY = formal
        ? (canonical?.position.y ?? sampleW8SurfaceHeightMeters(
          chunkData,
          candidate.worldPosition.x,
          candidate.worldPosition.z,
        )) * this.unitsPerMeter : 0;
      const visual = canonical ? null : resolveW8NaturalCandidateVisual(candidate);
      const dimensions = canonical?.visualBounds ?? {
        width: visual.widthMeters, height: visual.heightMeters, depth: visual.depthMeters,
      };
      const descriptors = canonical?.presentation.parts
        ?? this.visualAssets.featureParts[visual.visualKind]
        ?? this.visualAssets.featureParts.broadleafTree;
      const treePathId = candidate.subtype === 'shrub' ? null : 'near-tree';
      for (const descriptor of descriptors) {
        vegetationParts.push({
          stableId: canonical?.stableId ?? candidate.candidateId ?? candidate.stableId,
          canonicalObject: canonical,
          treePathId,
          part: descriptor,
          matrix: createPartMatrix({
            localX,
            localZ,
            groundY,
            rotationY: canonical?.rotation.y ?? visual.rotationY,
            width: dimensions.width * this.unitsPerMeter,
            height: dimensions.height * this.unitsPerMeter,
            depth: dimensions.depth * this.unitsPerMeter,
            part: descriptor,
          }),
        });
      }
    });
    layerMeshes.vegetation.push(...this.#createProductionPartMeshes({
      group,
      chunkKey: key,
      name: 'production-vegetation',
      items: vegetationParts,
      castShadow: false,
      attach: false,
    }));

    const rockParts = [];
    rocks.forEach(candidate => {
      const formal = candidate.candidateId !== undefined;
      const rock = usesW8CanonicalObjects && formal
        && candidate.worldPosition && candidate.owningChunkCoordinate
        ? resolveW8RockCanonicalObject(candidate) : null;
      const localX = formal
        ? (rock?.position.x ?? candidate.worldPosition.x)
          - chunkData.chunkX * LOGICAL_CHUNK_SIZE_METERS
        : candidate.logicalLocalX;
      const localZ = formal
        ? (rock?.position.z ?? candidate.worldPosition.z)
          - chunkData.chunkZ * LOGICAL_CHUNK_SIZE_METERS
        : candidate.logicalLocalZ;
      const groundY = formal ? sampleW8SurfaceHeightMeters(
        chunkData,
        rock?.position.x ?? candidate.worldPosition.x,
        rock?.position.z ?? candidate.worldPosition.z,
      ) * this.unitsPerMeter : 0;
      const rockDimensions = rock ? {
        width: rock.widthMeters, height: rock.heightMeters, depth: rock.depthMeters,
      } : {
        width: 0.45, height: 0.45, depth: 0.45,
      };
      const descriptor = rock?.presentation.parts[0] ?? this.visualAssets.featureParts.rock[0];
      rockParts.push({
        stableId: rock?.stableId ?? candidate.candidateId ?? candidate.stableId,
        canonicalObject: rock,
        part: descriptor,
        matrix: createPartMatrix({
          localX,
          localZ,
          groundY,
          rotationY: rock?.rotation.y ?? candidate.yawRadians,
          width: rockDimensions.width * this.unitsPerMeter,
          height: rockDimensions.height * this.unitsPerMeter,
          depth: rockDimensions.depth * this.unitsPerMeter,
          part: descriptor,
        }),
      });
    });
    layerMeshes.rocks.push(...this.#createProductionPartMeshes({
      group,
      chunkKey: key,
      name: 'production-rock',
      items: rockParts,
      attach: false,
    }));

    if (settlementFeatures.length) {
      const resources = this.#ensureSettlementResources();
      const roads = settlementFeatures.filter(feature => feature.featureType === 'settlement-road');
      const buildings = settlementFeatures.filter(feature => feature.featureType === 'settlement-building');
      if (roads.length) {
        roadRibbonGeometry = this.#createSettlementRoadGeometry(chunkData, roads);
        const roadMesh = new Mesh(roadRibbonGeometry, resources.materials.road);
        roadMesh.name = chunkData.generatorVersion?.major >= 500
          ? 'infinite-settlement-roads' : 'w4-rural-roads';
        roadMesh.count = roads.length;
        roadMesh.receiveShadow = true;
        roadMesh.userData = {
          roadRibbon: roadRibbonGeometry.userData.roadRibbon,
          roadRibbonHash: roadRibbonGeometry.userData.roadRibbonHash,
          sourceRoadStableIds: Object.freeze(roads.map(road => road.stableId).sort()),
        };
        layerMeshes.roads.push(roadMesh);
        for (const road of roads) {
          settlementPresentationDescriptors.push(Object.freeze({
            kind: 'road',
            stableId: road.stableId,
            sourceIdentity: road.sourceStableId
              ?? road.sourceSegmentStableId ?? road.stableId,
            projectionIdentity: road.stableId,
            ownerKey: key,
          }));
        }
      }

      const residentialLotSurfaces = [];
      const civicLotSurfaces = [];
      for (const building of buildings) {
        const lot = building.lot;
        if (!lot || lot.lotStatus !== 'ACTIVE') continue;
        const target = ['school', 'church'].includes(building.buildingType)
          ? civicLotSurfaces : residentialLotSurfaces;
        for (const [surfaceKind, surface] of [['entrance-path', lot.path], ['forecourt', lot.forecourt]]) {
          if (!surface || !(surface.width > 0) || !(surface.depth > 0)) continue;
          target.push({ building, surface, surfaceKind });
        }
      }
      for (const [surfaceClass, surfaces, material] of [
        ['residential', residentialLotSurfaces, resources.materials.lotResidential],
        ['civic', civicLotSurfaces, resources.materials.lotCivic],
      ]) {
        if (!surfaces.length) continue;
        const lotMesh = new InstancedMesh(resources.geometries.road, material, surfaces.length);
        lotMesh.name = `infinite-settlement-${surfaceClass}-lot-paths-and-forecourts`;
        lotMesh.receiveShadow = true;
        lotMesh.count = surfaces.length;
        lotMesh.userData.surfaceKinds = [];
        surfaces.forEach(({ building, surface, surfaceKind }, index) => {
          const visualWidthMeters = surfaceKind === 'entrance-path'
            && building.buildingType === 'house'
            ? Math.max(surface.width, W8_HOUSE_HUMAN_SCALE_VISUAL_PROFILE.entrancePathWidthMeters)
            : surface.width;
          transform.position.set(
            (surface.centerX - chunkData.chunkX * LOGICAL_CHUNK_SIZE_METERS) * this.unitsPerMeter,
            (building.worldPosition.y + FINITE_ROAD_SURFACE_HEIGHT_METERS + 0.00075)
              * this.unitsPerMeter,
            (surface.centerZ - chunkData.chunkZ * LOGICAL_CHUNK_SIZE_METERS) * this.unitsPerMeter,
          );
          transform.rotation.set(-Math.PI / 2, 0, surface.rotationY);
          transform.scale.set(
            visualWidthMeters * this.unitsPerMeter,
            surface.depth * this.unitsPerMeter,
            1,
          );
          transform.updateMatrix();
          lotMesh.setMatrixAt(index, transform.matrix);
          lotMesh.userData.surfaceKinds[index] = surfaceKind;
        });
        lotMesh.instanceMatrix.needsUpdate = true;
        layerMeshes.lots.push(lotMesh);
      }

      const buildingParts = [];
      buildings.forEach(building => {
        const canonical = usesW8CanonicalObjects
          && building.worldPosition && building.owningChunkCoordinate
          ? resolveW8CanonicalWorldObject(building) : null;
        const position = canonical?.position ?? building.worldPosition;
        const rotationY = canonical?.rotation.y ?? building.rotationY;
        const stableId = canonical?.stableId ?? building.stableId;
        settlementPresentationDescriptors.push(Object.freeze({
          kind: 'building',
          stableId,
          sourceIdentity: stableId,
          projectionIdentity: stableId,
          ownerKey: key,
        }));
        const matrixDimensions = canonical ? {
          width: canonical.widthMeters,
          height: canonical.heightMeters,
          depth: canonical.depthMeters,
        } : {
          width: building.widthMeters,
          height: building.heightMeters,
          depth: building.depthMeters,
        };
        const localX = position.x
          - chunkData.chunkX * LOGICAL_CHUNK_SIZE_METERS;
        const localZ = position.z
          - chunkData.chunkZ * LOGICAL_CHUNK_SIZE_METERS;
        const descriptors = (canonical
          ? this.visualAssets.resolveBuildingParts?.(canonical)
            ?? this.visualAssets.featureParts[canonical.presentation.partSetKey]
            ?? canonical.presentation.parts
          : this.visualAssets.resolveBuildingParts?.(building))
          ?? this.visualAssets.featureParts[building.buildingType];
        if (!descriptors) throw new Error(`unsupported production building visual: ${building.buildingType}`);
        for (const descriptor of descriptors) {
          buildingParts.push({
            stableId,
            canonicalObject: canonical,
            part: descriptor,
            matrix: createPartMatrix({
              localX,
              localZ,
              groundY: position.y * this.unitsPerMeter,
              rotationY,
              width: matrixDimensions.width * this.unitsPerMeter,
              height: matrixDimensions.height * this.unitsPerMeter,
              depth: matrixDimensions.depth * this.unitsPerMeter,
              part: descriptor,
            }),
          });
        }
        const cameraCollision = canonical?.collision;
        const visualHeightScale = canonical ? null : Math.max(1, ...descriptors.map(descriptor => (
          descriptor.position[1] + descriptor.scale[1] * 0.5
        )));
        const visualHalfWidthScale = canonical ? null : Math.max(...descriptors.map(descriptor => (
          Math.abs(descriptor.position[0]) + descriptor.scale[0] * 0.5
        )));
        const visualHalfDepthScale = canonical ? null : Math.max(...descriptors.map(descriptor => (
          Math.abs(descriptor.position[2]) + descriptor.scale[2] * 0.5
        )));
        this.#registry().cameraCollisionBounds.push(Object.freeze({
          chunkKey: key,
          stableId: canonical?.stableId ?? building.stableId,
          canonicalObject: canonical,
          worldX: position.x,
          worldZ: position.z,
          groundY: position.y * this.unitsPerMeter,
          halfWidth: (cameraCollision?.halfWidthMeters
            ?? building.widthMeters * visualHalfWidthScale) * this.unitsPerMeter,
          halfDepth: (cameraCollision?.halfDepthMeters
            ?? building.depthMeters * visualHalfDepthScale) * this.unitsPerMeter,
          height: (cameraCollision?.cameraHeightMeters
            ?? building.heightMeters * visualHeightScale) * this.unitsPerMeter,
          rotationY,
        }));
      });
      layerMeshes.buildings.push(...this.#createProductionPartMeshes({
        group,
        chunkKey: key,
        name: chunkData.generatorVersion?.major >= 500
          ? 'production-infinite-settlement-building' : 'production-rural-building',
        items: buildingParts,
        cameraOccludable: true,
        attach: false,
      }));
    }

    if (waterSurfaces.length) {
      const resources = this.#ensureSettlementResources();
      const wetlandInstances = waterSurfaces.filter(surface => surface.waterType !== 'river')
        .map(surface => ({
          stableId: surface.stableId,
          x: surface.worldPosition.x,
          y: surface.worldPosition.y,
          z: surface.worldPosition.z,
          rotation: 0,
          width: surface.widthMeters,
          depth: surface.depthMeters,
        }));
      const riverInstances = waterSurfaces.filter(surface => surface.waterType === 'river')
        .flatMap(surface => (surface.centerlines ?? []).flatMap(line => line.slice(1).map(
          (end, index) => {
            const start = line[index];
            const dx = end.x - start.x;
            const dz = end.z - start.z;
            return {
              stableId: surface.stableId,
              x: (start.x + end.x) / 2,
              y: (start.y + end.y) / 2,
              z: (start.z + end.z) / 2,
              rotation: Math.atan2(dz, dx),
              width: Math.hypot(dx, dz) + 0.01,
              depth: surface.widthMeters,
            };
          },
        )));
      const createWaterMesh = (instances, name) => {
        if (!instances.length) return;
        const waterMesh = new InstancedMesh(
          resources.geometries.road,
          this.visualAssets.materials.water ?? this.visualAssets.materials.window,
          instances.length,
        );
        waterMesh.name = name;
        waterMesh.visible = this.transparencyEnabled;
        waterMesh.userData = {
          waterType: name.includes('river') ? 'river' : 'wetland',
          featureStableIds: [],
        };
        this.#registry().transparentMeshes.add(waterMesh);
        waterMesh.count = instances.length;
        waterMesh.receiveShadow = true;
        instances.forEach((instance, index) => {
          transform.position.set(
            (instance.x - chunkData.chunkX * LOGICAL_CHUNK_SIZE_METERS) * this.unitsPerMeter,
            instance.y * this.unitsPerMeter + 1.5,
            (instance.z - chunkData.chunkZ * LOGICAL_CHUNK_SIZE_METERS) * this.unitsPerMeter,
          );
          transform.rotation.set(-Math.PI / 2, 0, instance.rotation);
          transform.scale.set(
            instance.width * this.unitsPerMeter,
            instance.depth * this.unitsPerMeter,
            1,
          );
          transform.updateMatrix();
          waterMesh.setMatrixAt(index, transform.matrix);
          waterMesh.userData.featureStableIds[index] = instance.stableId;
        });
        waterMesh.instanceMatrix.needsUpdate = true;
        layerMeshes.water.push(waterMesh);
      };
      createWaterMesh(wetlandInstances, 'w8-continuous-wetland-water');
      createWaterMesh(riverInstances, 'w8-canonical-river-water');
    }

    const formalDetailParts = [];
    const ambientDetailParts = [];
    const addDetail = (target, source, fallbackDimensions) => {
      const canonicalEligible = usesW8CanonicalObjects
        && source.worldPosition && source.owningChunkCoordinate && (
        ['grass', 'shrub', 'streetLamp', 'roadSign'].includes(source.detailType)
        || typeof source.landmarkType === 'string'
      );
      const canonical = canonicalEligible ? resolveW8CanonicalWorldObject(source) : null;
      const stableId = canonical?.stableId ?? source.stableId;
      const worldPosition = canonical?.position ?? source.worldPosition;
      const rotationY = canonical?.rotation.y ?? source.rotationY ?? 0;
      const detailType = canonical?.presentation.partSetKey
        ?? source.detailType ?? source.landmarkType;
      const variation = canonical ? 1 : source.variation ?? 1;
      const objectDimensions = canonical ? {
        width: canonical.widthMeters,
        height: canonical.heightMeters,
        depth: canonical.depthMeters,
      } : fallbackDimensions;
      const parts = canonical?.presentation.parts ?? this.visualAssets.featureParts[detailType];
      if (!parts) return;
      const localX = worldPosition.x - chunkData.chunkX * LOGICAL_CHUNK_SIZE_METERS;
      const localZ = worldPosition.z - chunkData.chunkZ * LOGICAL_CHUNK_SIZE_METERS;
      for (const part of parts) {
        target.push({
          stableId,
          canonicalObject: canonical,
          part,
          matrix: createPartMatrix({
            localX, localZ, groundY: worldPosition.y * this.unitsPerMeter,
            rotationY,
            width: objectDimensions.width * variation * this.unitsPerMeter,
            height: objectDimensions.height * variation * this.unitsPerMeter,
            depth: objectDimensions.depth * variation * this.unitsPerMeter,
            part,
          }),
        });
      }
    };
    for (const detail of ambientDetails) {
      addDetail(ambientDetailParts, detail, detail.detailType === 'shrub'
        ? { width: 0.75, height: 0.7, depth: 0.75 }
        : { width: 0.45, height: 0.65, depth: 0.45 });
    }
    for (const detail of streetDetails) {
      addDetail(formalDetailParts, detail, detail.detailType === 'streetLamp'
        ? { width: 0.45, height: 3.4, depth: 0.45 }
        : { width: 1.2, height: 2.1, depth: 0.25 });
    }
    for (const landmark of settlementLandmarks) {
      addDetail(formalDetailParts, landmark, {
        width: landmark.widthMeters,
        height: landmark.heightMeters,
        depth: landmark.depthMeters,
      });
    }
    layerMeshes.formalDetails.push(...this.#createProductionPartMeshes({
      group, chunkKey: key, name: 'w8-parity-formal-world-details', items: formalDetailParts,
      castShadow: false,
      attach: false,
    }));
    layerMeshes.ambientDetails.push(...this.#createProductionPartMeshes({
      group, chunkKey: key, name: 'w8-parity-ambient-world-details', items: ambientDetailParts,
      castShadow: false,
      attach: false,
    }));

    for (const layer of [
      layerMeshes.roads,
      layerMeshes.lots,
      layerMeshes.buildings,
      layerMeshes.water,
      layerMeshes.formalDetails,
      layerMeshes.vegetation,
      layerMeshes.rocks,
      layerMeshes.ambientDetails,
    ]) {
      for (const mesh of layer) group.add(mesh);
    }

    const projected = {
      key,
      chunkX: chunkData.chunkX,
      chunkZ: chunkData.chunkZ,
      group,
      ownedGeometries: [
        ...(naturalTerrain ? [terrainGeometry] : []),
        ...(roadRibbonGeometry ? [roadRibbonGeometry] : []),
      ],
      settlementPresentation: Object.freeze({
        descriptors: Object.freeze(settlementPresentationDescriptors),
        meshes: Object.freeze([
          ...layerMeshes.roads,
          ...layerMeshes.buildings,
        ]),
        ownedGeometries: Object.freeze(roadRibbonGeometry ? [roadRibbonGeometry] : []),
        components: Object.freeze([
          Object.freeze({
            kind: 'building',
            descriptors: Object.freeze(settlementPresentationDescriptors
              .filter(descriptor => descriptor.kind === 'building')),
            meshes: Object.freeze([...layerMeshes.buildings]),
            ownedGeometries: Object.freeze([]),
          }),
          Object.freeze({
            kind: 'road',
            descriptors: Object.freeze(settlementPresentationDescriptors
              .filter(descriptor => descriptor.kind === 'road')),
            meshes: Object.freeze([...layerMeshes.roads]),
            ownedGeometries: Object.freeze(roadRibbonGeometry ? [roadRibbonGeometry] : []),
          }),
        ].filter(component => component.descriptors.length > 0)),
      }),
      registry: this.projectionStaging,
      lifecycle: 'staged',
    };
    this.#positionGroup(projected, origin);
    this.counts.projected += 1;
    return projected;
    } finally {
      if (deferredRegistration) this.projectionStaging = null;
    }
  }

  async loadProjected(projected) {
    if (!projected?.key || !projected.group) throw new TypeError('invalid projected chunk');
    if (projected.lifecycle !== 'staged') {
      throw new Error(`render chunk is not staged for load: ${projected.key}:${projected.lifecycle}`);
    }
    const replacementOwner = this.visualRegistry?.get?.(projected.key) ?? null;
    const replacementHold = replacementOwner && replacementOwner.retiringAt === null
      ? this.settlementPresentationHolds.get(projected.key) ?? null : null;
    if (!replacementHold || !this.settlementReplacementBarrier) {
      this.releaseSettlementPresentationHolds({
        ownerKeys: [projected.key],
        reason: 'owner-returned-near',
      });
    }
    if (this.loaded.has(projected.key)) throw new Error(`render chunk already loaded: ${projected.key}`);
    const provisional = this.provisionalTerrain.get(projected.key) ?? null;
    const projectedTerrain = (projected.group.children ?? []).find(child => (
      child.name === 'w2-natural-terrain' || child.name === 'w1a-terrain'
    ));
    projected.lifecycle = 'loading';
    try {
      this.#positionGroup(projected);
      this.#commitProjectedRegistry(projected);
      if (provisional) {
        this.worldRoot.remove(provisional.group);
        provisional.group.remove(provisional.terrain);
        if (projectedTerrain) projected.group.remove(projectedTerrain);
        projected.group.add(provisional.terrain);
      }
      this.worldRoot.add(projected.group);
      this.loaded.set(projected.key, projected);
      if (provisional) {
        this.provisionalTerrain.delete(projected.key);
        projected.promotedTerrain = provisional;
        projected.ownedGeometries = [
          ...(projected.ownedGeometries ?? []).filter(geometry => geometry !== projectedTerrain?.geometry),
          ...(provisional.ownedGeometries ?? []),
        ];
        if (projectedTerrain && projectedTerrain.geometry !== provisional.terrain.geometry
          && projectedTerrain.geometry !== this.geometries.terrain) {
          projectedTerrain.geometry.dispose?.();
          this.disposedChunkGeometries.add(projectedTerrain.geometry);
          this.counts.chunkOwnedGeometriesDisposed += 1;
        }
        projectedTerrain?.dispose?.();
        provisional.lifecycle = 'promoted';
      }
      projected.lifecycle = 'loaded';
      this.counts.loaded += 1;
      if (projected.group.children?.some(child => child.userData?.treePathId === 'near-tree')) {
        this.treePathAudit.lastUpdateAtMs = globalThis.performance?.now?.() ?? Date.now();
      }
      this.#recordPublishedChunk(projected.key);
      this.#invalidateVisibleStableIds();
      if (replacementHold && this.settlementReplacementBarrier) {
        projected.settlementReplacementHold = replacementHold;
        this.settlementReplacementBarrier.retain({
          ownerKey: projected.key,
          drawable: replacementHold,
        });
      }
    } catch (error) {
      this.worldRoot.remove(projected.group);
      this.loaded.delete(projected.key);
      if (provisional) {
        projected.group.remove(provisional.terrain);
        if (projectedTerrain) projected.group.add(projectedTerrain);
        provisional.group.add(provisional.terrain);
        this.#positionGroup(provisional);
        this.worldRoot.add(provisional.group);
        this.provisionalTerrain.set(projected.key, provisional);
        provisional.lifecycle = 'provisional';
      }
      projected.lifecycle = 'staged';
      throw error;
    }
  }

  #recordPublishedChunk(key) {
    if (!this.telemetry) return;
    const summaries = new Map([
      [WORLD_STREAMING_TARGET.NEAR, { count: 1, stableId: null }],
    ]);
    for (const stableId of this.chunkFeatureIds.get(key) ?? []) {
      const canonicalObject = this.featureInstances.get(stableId)?.canonicalObject ?? null;
      const target = worldStreamingTargetForCanonicalObject(canonicalObject);
      if (target) {
        const current = summaries.get(target) ?? { count: 0, stableId };
        current.count += 1;
        summaries.set(target, current);
      }
      const settlementId = canonicalObject?.settlementId
        ?? canonicalObject?.parentSettlementId
        ?? canonicalObject?.extension?.settlementId
        ?? canonicalObject?.extension?.parentSettlementId;
      if (typeof settlementId === 'string' && settlementId) {
        const current = summaries.get(WORLD_STREAMING_TARGET.SETTLEMENT)
          ?? { count: 0, stableId: settlementId };
        current.count += 1;
        summaries.set(WORLD_STREAMING_TARGET.SETTLEMENT, current);
      }
    }
    const pending = [];
    for (const [target, summary] of summaries) {
      const details = {
        target,
        stream: WORLD_STREAMING_STREAM.NEAR,
        resourceKey: key,
        ownerKey: key,
        stableId: summary.stableId,
        metadata: { instanceCount: summary.count },
      };
      const published = this.telemetry.record(WORLD_STREAMING_EVENT.PUBLISH, details);
      pending.push({ ...details, correlationId: published?.correlationId ?? null });
    }
    this.pendingFirstDrawByChunk.set(key, pending);
  }

  markFirstDraw(receipt) {
    if (!isCompletedRenderFrameReceipt(receipt)) return 0;
    this.#recordDrawableStableIds(receipt);
    this.#acknowledgeSettlementReplacements(receipt);
    if (this.treePathAudit.firstDrawAtMs === null && [...this.loaded.values()].some(projected => (
      hasDrawableInCompletedFrame({
        root: projected.group,
        receipt,
        predicate: object => object.userData?.treePathId === 'near-tree'
          && object.userData.treeStableIds?.length > 0,
      })
    ))) {
      this.treePathAudit.firstDrawAtMs = receipt.completedAtMs;
    }
    if (!this.telemetry || this.pendingFirstDrawByChunk.size === 0) return 0;
    let recorded = 0;
    for (const [key, pending] of this.pendingFirstDrawByChunk) {
      const projected = this.loaded.get(key);
      if (!projected || !hasDrawableInCompletedFrame({ root: projected.group, receipt })) continue;
      for (const details of pending) {
        this.telemetry.record(WORLD_STREAMING_EVENT.FIRST_DRAW, details);
        recorded += 1;
      }
      this.pendingFirstDrawByChunk.delete(key);
    }
    return recorded;
  }

  setDiagnosticTransparencyEnabled(enabled = true) {
    this.transparencyEnabled = enabled === true;
    for (const mesh of this.transparentMeshes) mesh.visible = this.transparencyEnabled;
    if (!this.transparencyEnabled) {
      this.clearCameraOcclusion();
    }
    return this.transparencyEnabled;
  }

  async unloadChunk(key, { deferSettlementPresentation = false } = {}) {
    const projected = this.loaded.get(key);
    if (!projected) throw new Error(`render chunk is not loaded: ${key}`);
    if (deferSettlementPresentation && this.#holdSettlementPresentation(projected)) return;
    this.worldRoot.remove(projected.group);
    if (projected.group.children?.some(child => child.userData?.treePathId === 'near-tree')) {
      this.treePathAudit.disposeCount += 1;
      this.treePathAudit.lastUpdateAtMs = globalThis.performance?.now?.() ?? Date.now();
    }
    this.pendingFirstDrawByChunk.delete(key);
    for (const geometry of projected.ownedGeometries) {
      geometry.dispose();
      this.disposedChunkGeometries.add(geometry);
      this.counts.chunkOwnedGeometriesDisposed += 1;
    }
    this.#removeProjectedRegistry(projected);
    for (const child of projected.group.children ?? []) child.dispose?.();
    projected.group.clear();
    this.loaded.delete(key);
    this.#invalidateVisibleStableIds();
    projected.lifecycle = 'unloaded';
    this.counts.unloaded += 1;
  }

  async retainTerrainChunk(key) {
    const projected = this.loaded.get(key);
    const provisional = projected?.promotedTerrain;
    if (!projected || !provisional) {
      throw new Error(`render chunk has no promoted Terrain to retain: ${key}`);
    }
    const terrain = provisional.terrain;
    this.worldRoot.remove(projected.group);
    projected.group.remove(terrain);
    this.#removeProjectedRegistry(projected);
    for (const geometry of projected.ownedGeometries ?? []) {
      if (geometry === terrain.geometry) continue;
      geometry.dispose?.();
      this.disposedChunkGeometries.add(geometry);
      this.counts.chunkOwnedGeometriesDisposed += 1;
    }
    for (const child of projected.group.children ?? []) child.dispose?.();
    projected.group.clear();
    provisional.group.add(terrain);
    this.#positionGroup(provisional);
    this.worldRoot.add(provisional.group);
    this.loaded.delete(key);
    this.provisionalTerrain.set(key, provisional);
    projected.lifecycle = 'unloaded';
    provisional.lifecycle = 'provisional';
    this.pendingFirstDrawByChunk.delete(key);
    this.#invalidateVisibleStableIds();
    this.counts.unloaded += 1;
  }

  async unloadProvisionalTerrain(key) {
    const projected = this.provisionalTerrain.get(key);
    if (!projected) throw new Error(`provisional Terrain is not loaded: ${key}`);
    this.worldRoot.remove(projected.group);
    for (const geometry of projected.ownedGeometries ?? []) {
      geometry.dispose?.();
      this.disposedChunkGeometries.add(geometry);
      this.counts.chunkOwnedGeometriesDisposed += 1;
    }
    for (const child of projected.group.children ?? []) child.dispose?.();
    projected.group.clear();
    this.provisionalTerrain.delete(key);
    projected.lifecycle = 'unloaded';
  }

  async discardProjected(projected) {
    if (!projected?.group) return false;
    // A superseded plan may own a staged duplicate for an owner that another
    // plan has already published. Reject only the exact live projection;
    // blocking by owner key would leak the safely-discardable staged copy.
    if (this.loaded.get(projected.key) === projected
      || ['loading', 'loaded'].includes(projected.lifecycle)) {
      throw new Error(`cannot discard loaded chunk: ${projected.key}`);
    }
    if (projected.lifecycle === 'discarded' || projected.lifecycle === 'unloaded') return false;
    for (const geometry of projected.ownedGeometries ?? []) {
      geometry.dispose?.();
      this.disposedChunkGeometries.add(geometry);
      this.counts.chunkOwnedGeometriesDisposed += 1;
    }
    for (const child of projected.group.children ?? []) child.dispose?.();
    projected.group.clear?.();
    projected.lifecycle = 'discarded';
    return true;
  }

  renderCoverageSnapshot() {
    const loadedKeys = [...this.loaded.keys()].sort((left, right) => left.localeCompare(right));
    const terrainKeys = [];
    const missingTerrainKeys = [];
    const disposedTerrainKeys = [];
    const lifecycleMismatchKeys = [];
    for (const [key, projected] of this.loaded) {
      if (projected.lifecycle !== 'loaded') lifecycleMismatchKeys.push(key);
      const terrain = (projected.group.children ?? []).find(child => (
        child.name === 'w2-natural-terrain' || child.name === 'w1a-terrain'
      ));
      if (!terrain) {
        missingTerrainKeys.push(key);
        continue;
      }
      terrainKeys.push(key);
      if (this.disposedChunkGeometries.has(terrain.geometry)) disposedTerrainKeys.push(key);
    }
    const sort = values => values.sort((left, right) => left.localeCompare(right));
    return Object.freeze({
      loadedKeys: Object.freeze(loadedKeys),
      terrainKeys: Object.freeze(sort(terrainKeys)),
      missingTerrainKeys: Object.freeze(sort(missingTerrainKeys)),
      disposedTerrainKeys: Object.freeze(sort(disposedTerrainKeys)),
      lifecycleMismatchKeys: Object.freeze(sort(lifecycleMismatchKeys)),
      provisionalTerrainKeys: Object.freeze(sort([...this.provisionalTerrain.keys()])),
    });
  }

  treePathAuditSnapshot() {
    const meshes = [];
    const ownerKeys = new Set();
    const stableIds = new Set();
    let instanceCount = 0;
    for (const [ownerKey, projected] of this.loaded) {
      for (const mesh of projected.group.children ?? []) {
        if (mesh.userData?.treePathId !== 'near-tree') continue;
        const treeStableIds = mesh.userData.treeStableIds ?? [];
        if (treeStableIds.length) ownerKeys.add(ownerKey);
        for (const stableId of treeStableIds) stableIds.add(stableId);
        instanceCount += treeStableIds.length;
        meshes.push(Object.freeze({
          ownerKey,
          name: mesh.name ?? null,
          materialName: mesh.material?.name
            || mesh.material?.type
            || mesh.material?.constructor?.name
            || null,
          count: treeStableIds.length,
          visible: this.worldRoot.visible !== false && mesh.visible !== false,
        }));
      }
    }
    const active = meshes.some(mesh => mesh.visible && mesh.count > 0);
    return Object.freeze({
      pathId: 'near-tree',
      rootNames: Object.freeze([this.worldRoot.name]),
      rootCount: active ? 1 : 0,
      meshes: Object.freeze(meshes),
      meshCount: meshes.length,
      materialNames: Object.freeze([...new Set(meshes
        .map(mesh => mesh.materialName).filter(Boolean))]),
      instanceCount,
      ownerCount: ownerKeys.size,
      stableIdCount: stableIds.size,
      firstDrawAtMs: this.treePathAudit.firstDrawAtMs,
      lastUpdateAtMs: this.treePathAudit.lastUpdateAtMs,
      matrixUpdateCount: this.treePathAudit.matrixUpdateCount,
      bufferUpdateCount: this.treePathAudit.bufferUpdateCount,
      visibilityChangeCount: this.treePathAudit.visibilityChangeCount,
      disposeCount: this.treePathAudit.disposeCount,
      active,
      hidden: !active,
      publicationSources: Object.freeze(['runtime-chunk-load']),
      planIds: Object.freeze([]),
      coverageGenerations: Object.freeze([]),
    });
  }

  visibleStableIdsSnapshot() {
    if (this.visibleStableIdsCache) return this.visibleStableIdsCache;
    const visible = new Set([...this.featureInstances]
      .filter(([, entry]) => entry.destroyed !== true)
      .map(([stableId]) => stableId));
    for (const projected of this.loaded.values()) {
      for (const descriptor of projected.settlementPresentation?.descriptors ?? []) {
        if (this.isFeatureDestroyed(descriptor.projectionIdentity)) continue;
        visible.add(descriptor.projectionIdentity);
      }
    }
    for (const held of this.settlementPresentationHolds.values()) {
      for (const descriptor of held.descriptors) {
        const entry = held.featureEntries.get(descriptor.projectionIdentity);
        if (entry?.destroyed === true || this.isFeatureDestroyed(descriptor.projectionIdentity)) continue;
        visible.add(descriptor.projectionIdentity);
      }
    }
    this.visibleStableIdsCache = Object.freeze([...visible]
      .sort((left, right) => left.localeCompare(right)));
    return this.visibleStableIdsCache;
  }

  drawableStableIdsSnapshot() {
    return this.drawableStableIdsCache;
  }

  visibleSettlementStableIdsSnapshot() {
    const visible = new Set([...this.featureInstances]
      .filter(([stableId, entry]) => {
        if (this.isFeatureDestroyed(stableId)) return false;
        const object = entry.canonicalObject;
        return typeof (object?.settlementId
          ?? object?.parentSettlementId
          ?? object?.extension?.settlementId
          ?? object?.extension?.parentSettlementId) === 'string';
      })
      .map(([stableId]) => stableId));
    for (const held of this.settlementPresentationHolds.values()) {
      for (const descriptor of held.descriptors) {
        if (descriptor.kind !== 'building'
          || this.isFeatureDestroyed(descriptor.projectionIdentity)) continue;
        visible.add(descriptor.projectionIdentity);
      }
    }
    return Object.freeze([...visible]
      .sort((left, right) => left.localeCompare(right)));
  }

  visibleSettlementIdsSnapshot() {
    const settlementIds = new Set();
    for (const [stableId, entry] of this.featureInstances) {
      if (this.isFeatureDestroyed(stableId)) continue;
      const settlementId = entry.canonicalObject?.settlementId
        ?? entry.canonicalObject?.parentSettlementId
        ?? entry.canonicalObject?.extension?.settlementId
        ?? entry.canonicalObject?.extension?.parentSettlementId;
      if (typeof settlementId === 'string' && settlementId) settlementIds.add(settlementId);
    }
    for (const held of this.settlementPresentationHolds.values()) {
      for (const entry of held.featureEntries.values()) {
        if (entry.destroyed === true || this.isFeatureDestroyed(entry.stableId)) continue;
        const settlementId = entry.canonicalObject?.settlementId
          ?? entry.canonicalObject?.parentSettlementId
          ?? entry.canonicalObject?.extension?.settlementId
          ?? entry.canonicalObject?.extension?.parentSettlementId;
        if (typeof settlementId === 'string' && settlementId) settlementIds.add(settlementId);
      }
    }
    return Object.freeze([...settlementIds].sort((left, right) => left.localeCompare(right)));
  }

  resourceSnapshot() {
    const visualResources = this.visualAssets.snapshot();
    return Object.freeze({
      liveChunkGroups: this.loaded.size,
      heldSettlementPresentationOwnerCount: this.settlementPresentationHolds.size,
      heldSettlementPresentationDescriptorCount: [...this.settlementPresentationHolds.values()]
        .reduce((total, held) => total + held.descriptors.length, 0),
      provisionalTerrainGroupCount: this.provisionalTerrain.size,
      sharedGeometryCount: Object.keys(this.geometries).length
        + (this.settlementResources ? Object.keys(this.settlementResources.geometries).length : 0)
        + visualResources.sharedGeometryCount,
      sharedMaterialCount: Object.keys(this.materials).length
        + visualResources.sharedMaterialCount,
      sharedDisposed: this.disposed && (!this.ownsVisualAssets || visualResources.disposed),
      productionVisuals: visualResources,
      projectedCount: this.counts.projected,
      loadedCount: this.counts.loaded,
      unloadedCount: this.counts.unloaded,
      rebaseCount: this.counts.rebased,
      liveChunkOwnedGeometryCount: this.counts.chunkOwnedGeometriesCreated
        - this.counts.chunkOwnedGeometriesDisposed,
      chunkOwnedGeometriesCreated: this.counts.chunkOwnedGeometriesCreated,
      chunkOwnedGeometriesDisposed: this.counts.chunkOwnedGeometriesDisposed,
      trackedFeatureInstanceCount: this.featureInstances.size,
      visibleStableIdsRevision: this.visibleStableIdsRevision,
      cameraOccludableMeshCount: this.occlusionMeshes.length,
      cameraCollisionBoundCount: this.cameraCollisionBounds.length,
      cameraOccludedFeatureCount: this.occludedFeatureIds.size,
      chunkRenderables: Object.freeze(Object.fromEntries(
        [...this.loaded].map(([key, projected]) => [key, projected.group.children.length]),
      )),
      renderCoverage: this.renderCoverageSnapshot(),
    });
  }

  async shutdown() {
    if (this.disposed) return;
    this.releaseSettlementPresentationHolds({
      ownerKeys: [...this.settlementPresentationHolds.keys()],
      reason: 'shutdown',
    });
    for (const key of [...this.loaded.keys()]) await this.unloadChunk(key);
    for (const key of [...this.provisionalTerrain.keys()]) await this.unloadProvisionalTerrain(key);
    this.scene.remove(this.worldRoot);
    for (const geometry of Object.values(this.geometries)) geometry.dispose();
    for (const material of Object.values(this.materials)) material.dispose();
    if (this.settlementResources) {
      for (const geometry of Object.values(this.settlementResources.geometries)) geometry.dispose();
    }
    for (const material of this.fadedMaterials.values()) material.dispose();
    if (this.ownsVisualAssets) this.visualAssets.dispose();
    this.featureInstances.clear();
    this.pendingFirstDrawByChunk.clear();
    this.visibleStableIdsCache = null;
    this.chunkFeatureIds.clear();
    this.occlusionMeshes.length = 0;
    this.cameraCollisionBounds.length = 0;
    this.occludedFeatureIds.clear();
    this.occlusionLastHitAt.clear();
    this.fadedMaterials.clear();
    this.transparentMeshes.clear();
    this.disposed = true;
  }
}
