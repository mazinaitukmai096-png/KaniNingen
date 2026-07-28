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
import {
  resolveW8CanonicalCandidateSet,
  resolveW8NaturalCandidateVisual,
  w8TerrainColorFromWeights,
} from './w8-distant-presentation.js';
import { resolveW8RockCanonicalObject } from '../rock-canonical-object.js';
import { resolveW8CanonicalWorldObject } from '../world-object-canonical-contract.js';

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
    this.disposedChunkGeometries = new WeakSet();
    if (typeof isFeatureDestroyed !== 'function') throw new TypeError('isFeatureDestroyed must be a function');
    this.isFeatureDestroyed = isFeatureDestroyed;
    this.featureInstances = new Map();
    this.chunkFeatureIds = new Map();
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

    const Group = requireConstructor(THREE, 'Group');
    const PlaneGeometry = requireConstructor(THREE, 'PlaneGeometry');
    const MeshLambertMaterial = requireConstructor(THREE, 'MeshLambertMaterial');
    const TerrainMaterial = typeof THREE.MeshPhongMaterial === 'function'
      ? THREE.MeshPhongMaterial : MeshLambertMaterial;
    const Object3D = requireConstructor(THREE, 'Object3D');
    this.worldRoot = new Group();
    this.worldRoot.name = 'w1a-render-root';
    this.scene.add(this.worldRoot);
    this.geometries = Object.freeze({
      terrain: new PlaneGeometry(renderChunkSize, renderChunkSize),
    });
    this.materials = Object.freeze({
      terrain: new TerrainMaterial({ color: 0x668c54, flatShading: true, shininess: 0 }),
      naturalTerrain: new TerrainMaterial({ vertexColors: true, flatShading: true, shininess: 0 }),
    });
    const hiddenTransform = new Object3D();
    hiddenTransform.scale.set(0, 0, 0);
    hiddenTransform.updateMatrix();
    this.hiddenFeatureMatrix = hiddenTransform.matrix.clone?.() ?? structuredClone(hiddenTransform.matrix);
  }

  #cloneMatrix(matrix) {
    return matrix.clone?.() ?? structuredClone(matrix);
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

  #registerFeatureInstance({
    stableId, chunkKey, mesh, fadeMesh = null, index, matrix, group, canonicalObject = null,
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
        parts: [], group, rubbleMesh: null, canonicalObject,
      };
      registry.featureInstances.set(stableId, existing);
    }
    existing.parts.push(part);
    if (!registry.chunkFeatureIds.has(chunkKey)) registry.chunkFeatureIds.set(chunkKey, new Set());
    registry.chunkFeatureIds.get(chunkKey).add(stableId);
    const destroyed = this.isFeatureDestroyed(stableId);
    mesh.setMatrixAt(index, destroyed ? this.hiddenFeatureMatrix : part.originalMatrix);
    fadeMesh?.setMatrixAt(index, this.hiddenFeatureMatrix);
  }

  setFeatureDestroyed(stableId, destroyed = true) {
    const entry = this.featureInstances.get(stableId);
    if (!entry) return false;
    const occluded = this.occludedFeatureIds.has(stableId);
    for (const part of entry.parts) {
      part.mesh.setMatrixAt(part.index, destroyed || occluded
        ? this.hiddenFeatureMatrix : part.originalMatrix);
      part.mesh.instanceMatrix.needsUpdate = true;
      if (part.fadeMesh) {
        part.fadeMesh.setMatrixAt(part.index, !destroyed && occluded
          ? part.originalMatrix : this.hiddenFeatureMatrix);
        part.fadeMesh.instanceMatrix.needsUpdate = true;
      }
    }
    const destructionPresentation = entry.canonicalObject?.destruction?.presentation ?? 'rubble';
    if (destroyed && destructionPresentation === 'rubble' && !entry.rubbleMesh) {
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
    } else if ((!destroyed || destructionPresentation !== 'rubble') && entry.rubbleMesh) {
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

  #createNaturalTerrainGeometry(terrain) {
    const BufferGeometry = requireConstructor(this.THREE, 'BufferGeometry');
    const Float32BufferAttribute = requireConstructor(this.THREE, 'Float32BufferAttribute');
    const width = terrain.resolution.x;
    const depth = terrain.resolution.z;
    const positions = [];
    const colors = [];
    const indices = [];
    for (let z = 0; z < depth; z += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = z * width + x;
        positions.push(
          x / (width - 1) * this.renderChunkSize,
          terrain.heights[index] * terrain.heightUnitMeters * this.unitsPerMeter,
          z / (depth - 1) * this.renderChunkSize,
        );
        const weights = terrain.materialWeights.slice(index * 5, index * 5 + 5);
        colors.push(...w8TerrainColorFromWeights(weights));
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
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
    geometry.setAttribute('color', new Float32BufferAttribute(colors, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    this.counts.chunkOwnedGeometriesCreated += 1;
    return geometry;
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
        });
      });
      mesh.instanceMatrix.needsUpdate = true;
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

    const naturalTerrain = chunkData.terrain.resolution.x > 2 || chunkData.terrain.resolution.z > 2;
    const terrainGeometry = naturalTerrain
      ? this.#createNaturalTerrainGeometry(chunkData.terrain)
      : this.geometries.terrain;
    const terrain = new Mesh(
      terrainGeometry,
      naturalTerrain ? this.materials.naturalTerrain : this.materials.terrain,
    );
    terrain.name = naturalTerrain ? 'w2-natural-terrain' : 'w1a-terrain';
    terrain.receiveShadow = true;
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
        ? (canonical?.position.y ?? candidate.worldPosition.y) * this.unitsPerMeter : 0;
      const visual = canonical ? null : resolveW8NaturalCandidateVisual(candidate);
      const dimensions = canonical?.visualBounds ?? {
        width: visual.widthMeters, height: visual.heightMeters, depth: visual.depthMeters,
      };
      const descriptors = canonical?.presentation.parts
        ?? this.visualAssets.featureParts[visual.visualKind]
        ?? this.visualAssets.featureParts.broadleafTree;
      for (const descriptor of descriptors) {
        vegetationParts.push({
          stableId: canonical?.stableId ?? candidate.candidateId ?? candidate.stableId,
          canonicalObject: canonical,
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
      const groundY = formal ? (rock?.position.y ?? candidate.worldPosition.y) * this.unitsPerMeter : 0;
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
      const roadMesh = new InstancedMesh(
        resources.geometries.road,
        resources.materials.road,
        Math.max(1, roads.length),
      );
      roadMesh.name = chunkData.generatorVersion?.major >= 500
        ? 'infinite-settlement-roads' : 'w4-rural-roads';
      roadMesh.receiveShadow = true;
      roadMesh.count = roads.length;
      roads.forEach((road, index) => {
        const dx = road.end.x - road.start.x;
        const dz = road.end.z - road.start.z;
        const localX = (road.start.x + road.end.x) / 2
          - chunkData.chunkX * LOGICAL_CHUNK_SIZE_METERS;
        const localZ = (road.start.z + road.end.z) / 2
          - chunkData.chunkZ * LOGICAL_CHUNK_SIZE_METERS;
        transform.position.set(
          localX * this.unitsPerMeter,
          (road.worldPosition.y + FINITE_ROAD_SURFACE_HEIGHT_METERS) * this.unitsPerMeter,
          localZ * this.unitsPerMeter,
        );
        transform.rotation.set(-Math.PI / 2, 0, Math.atan2(dz, dx));
        transform.scale.set(
          Math.hypot(dx, dz) * this.unitsPerMeter,
          road.widthMeters * this.unitsPerMeter,
          1,
        );
        transform.updateMatrix();
        roadMesh.setMatrixAt(index, transform.matrix);
      });
      roadMesh.instanceMatrix.needsUpdate = true;
      if (roads.length) layerMeshes.roads.push(roadMesh);

      const junctions = new Map();
      for (const road of roads) {
        for (const point of [road.start, road.end]) {
          const junctionKey = `${Math.round(point.x * 100)},${Math.round(point.z * 100)}`;
          const entry = junctions.get(junctionKey) ?? {
            x: point.x, z: point.z, y: 0, sampleCount: 0, roadCount: 0, widthMeters: 0,
          };
          entry.y += road.worldPosition.y;
          entry.sampleCount += 1;
          entry.roadCount += 1;
          entry.widthMeters = Math.max(entry.widthMeters, road.widthMeters);
          junctions.set(junctionKey, entry);
        }
      }
      const visibleJunctions = [...junctions.values()].filter(junction => junction.roadCount >= 2);
      if (visibleJunctions.length) {
        const junctionMesh = new InstancedMesh(
          resources.geometries.road,
          resources.materials.road,
          visibleJunctions.length,
        );
        junctionMesh.name = 'infinite-settlement-junctions';
        junctionMesh.receiveShadow = true;
        junctionMesh.count = visibleJunctions.length;
        visibleJunctions.forEach((junction, index) => {
          transform.position.set(
            (junction.x - chunkData.chunkX * LOGICAL_CHUNK_SIZE_METERS) * this.unitsPerMeter,
            (junction.y / junction.sampleCount + FINITE_ROAD_SURFACE_HEIGHT_METERS + 0.0005)
              * this.unitsPerMeter,
            (junction.z - chunkData.chunkZ * LOGICAL_CHUNK_SIZE_METERS) * this.unitsPerMeter,
          );
          transform.rotation.set(-Math.PI / 2, 0, 0);
          transform.scale.set(
            junction.widthMeters * 1.08 * this.unitsPerMeter,
            junction.widthMeters * 1.08 * this.unitsPerMeter,
            1,
          );
          transform.updateMatrix();
          junctionMesh.setMatrixAt(index, transform.matrix);
        });
        junctionMesh.instanceMatrix.needsUpdate = true;
        layerMeshes.roads.push(junctionMesh);
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
          transform.position.set(
            (surface.centerX - chunkData.chunkX * LOGICAL_CHUNK_SIZE_METERS) * this.unitsPerMeter,
            (building.worldPosition.y + FINITE_ROAD_SURFACE_HEIGHT_METERS + 0.00075)
              * this.unitsPerMeter,
            (surface.centerZ - chunkData.chunkZ * LOGICAL_CHUNK_SIZE_METERS) * this.unitsPerMeter,
          );
          transform.rotation.set(-Math.PI / 2, 0, surface.rotationY);
          transform.scale.set(
            surface.width * this.unitsPerMeter,
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
            stableId: canonical?.stableId ?? building.stableId,
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
      const waterMesh = new InstancedMesh(
        resources.geometries.road,
        this.visualAssets.materials.water ?? this.visualAssets.materials.window,
        waterSurfaces.length,
      );
      waterMesh.name = 'w8-continuous-wetland-water';
      waterMesh.visible = this.transparencyEnabled;
      this.#registry().transparentMeshes.add(waterMesh);
      waterMesh.count = waterSurfaces.length;
      waterMesh.receiveShadow = true;
      waterSurfaces.forEach((surface, index) => {
        transform.position.set(
          (surface.worldPosition.x - chunkData.chunkX * LOGICAL_CHUNK_SIZE_METERS) * this.unitsPerMeter,
          surface.worldPosition.y * this.unitsPerMeter + 1.5,
          (surface.worldPosition.z - chunkData.chunkZ * LOGICAL_CHUNK_SIZE_METERS) * this.unitsPerMeter,
        );
        transform.rotation.set(-Math.PI / 2, 0, 0);
        transform.scale.set(
          surface.widthMeters * this.unitsPerMeter,
          surface.depthMeters * this.unitsPerMeter,
          1,
        );
        transform.updateMatrix();
        waterMesh.setMatrixAt(index, transform.matrix);
      });
      waterMesh.instanceMatrix.needsUpdate = true;
      layerMeshes.water.push(waterMesh);
    }

    const formalDetailParts = [];
    const ambientDetailParts = [];
    const addDetail = (target, source, fallbackDimensions) => {
      const canonicalEligible = usesW8CanonicalObjects
        && source.worldPosition && source.owningChunkCoordinate && (
        ['shrub', 'streetLamp', 'roadSign'].includes(source.detailType)
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
      ownedGeometries: naturalTerrain ? [terrainGeometry] : [],
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
    if (this.loaded.has(projected.key)) throw new Error(`render chunk already loaded: ${projected.key}`);
    projected.lifecycle = 'loading';
    try {
      this.#positionGroup(projected);
      this.#commitProjectedRegistry(projected);
      this.worldRoot.add(projected.group);
      this.loaded.set(projected.key, projected);
      projected.lifecycle = 'loaded';
      this.counts.loaded += 1;
    } catch (error) {
      this.worldRoot.remove(projected.group);
      this.loaded.delete(projected.key);
      projected.lifecycle = 'staged';
      throw error;
    }
  }

  setDiagnosticTransparencyEnabled(enabled = true) {
    this.transparencyEnabled = enabled === true;
    for (const mesh of this.transparentMeshes) mesh.visible = this.transparencyEnabled;
    if (!this.transparencyEnabled) {
      this.clearCameraOcclusion();
    }
    return this.transparencyEnabled;
  }

  async unloadChunk(key) {
    const projected = this.loaded.get(key);
    if (!projected) throw new Error(`render chunk is not loaded: ${key}`);
    this.worldRoot.remove(projected.group);
    for (const geometry of projected.ownedGeometries) {
      geometry.dispose();
      this.disposedChunkGeometries.add(geometry);
      this.counts.chunkOwnedGeometriesDisposed += 1;
    }
    const occlusionMeshes = new Set(projected.group.children ?? []);
    this.occlusionMeshes = this.occlusionMeshes.filter(mesh => !occlusionMeshes.has(mesh));
    this.cameraCollisionBounds = this.cameraCollisionBounds.filter(bound => bound.chunkKey !== key);
    for (const mesh of occlusionMeshes) this.transparentMeshes.delete(mesh);
    for (const child of projected.group.children ?? []) child.dispose?.();
    projected.group.clear();
    for (const stableId of this.chunkFeatureIds.get(key) ?? []) this.featureInstances.delete(stableId);
    for (const stableId of this.chunkFeatureIds.get(key) ?? []) {
      this.occludedFeatureIds.delete(stableId);
      this.occlusionLastHitAt.delete(stableId);
    }
    this.chunkFeatureIds.delete(key);
    this.loaded.delete(key);
    projected.lifecycle = 'unloaded';
    this.counts.unloaded += 1;
  }

  async discardProjected(projected) {
    if (!projected?.group) return false;
    if (this.loaded.has(projected.key) || ['loading', 'loaded'].includes(projected.lifecycle)) {
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
    });
  }

  resourceSnapshot() {
    const visualResources = this.visualAssets.snapshot();
    return Object.freeze({
      liveChunkGroups: this.loaded.size,
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
    for (const key of [...this.loaded.keys()]) await this.unloadChunk(key);
    this.scene.remove(this.worldRoot);
    for (const geometry of Object.values(this.geometries)) geometry.dispose();
    for (const material of Object.values(this.materials)) material.dispose();
    if (this.settlementResources) {
      for (const geometry of Object.values(this.settlementResources.geometries)) geometry.dispose();
    }
    for (const material of this.fadedMaterials.values()) material.dispose();
    if (this.ownsVisualAssets) this.visualAssets.dispose();
    this.featureInstances.clear();
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
