import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  W8_DIAGNOSTIC_PROFILES,
  correlateW8HitchStages,
  createW8RuntimeDiagnostics,
  evaluateW8PerformanceRuns,
  parseW8DiagnosticProfile,
} from '../src/infinite-world/runtime-diagnostics.js';
import {
  W8_CANONICAL_VISIBILITY_METERS,
  W8_NATURAL_CANONICAL_VISIBILITY_METERS,
  W8_PRESENTATION_TERRAIN_PALETTE,
  auditW8ContinuousTerrainCoverage,
  auditW8ClipmapChunkShiftReuse,
  createDeadlineAwareTerrainPresentationScheduler,
  createW8DistantPresentation,
  createW8ClipmapTopology,
  createW8LogicalTerrainContract,
  isW8DistantNaturalProxyInRange,
  isW8NaturalCandidateVisible,
  resolveW8CanonicalCandidateSet,
  resolveW8NaturalCandidateVisual,
  resolveW8PersistentNaturalBucketCapacity,
  sampleW8DistantTerrainAt,
  w8TerrainColorFromWeights,
} from '../src/infinite-world/render/w8-distant-presentation.js';
import {
  createSettlementSurfacePolicy,
  resolveCanonicalGroundSurface,
} from '../src/infinite-world/w8-surface-policy.js';
import { W6_STATIC_TARGET_CONTRACTS } from '../src/infinite-world/gameplay-contract.js';
import { RENDER_CHUNK_SIZE } from '../src/infinite-world/chunk-coordinates.js';
import {
  createCanonicalRiverProjection,
  createCanonicalRiverSourceId,
  createCanonicalRiverSurfaceCorridor,
} from '../src/infinite-world/canonical-river-realization.js';
import {
  W8_FINITE_SETTLEMENT_VIEW_CONTRACT,
  W8_LOCAL_SETTLEMENT_SELECTION_LIMIT,
  resolveW8RemoteSettlementAtmosphere,
  resolveW8SettlementPresentationPolicy,
  resolveRemoteHorizonBuildingLimit,
  selectRemoteHorizonBuildings,
  selectW8SettlementPresentationCandidates,
} from '../src/infinite-world/settlement-presentation-policy.js';
import {
  InfiniteWorldState,
  decodeInfiniteWorldSave,
  encodeInfiniteWorldSave,
} from '../src/infinite-world/world-state-store.js';
import { createRuntimeTransitionContract } from '../src/infinite-world/runtime-transition-contract.js';
import { createMacroTerrainEvaluator } from '../src/infinite-world/legacy-core/g5/macro-terrain.js';
import { determineDetailCandidateOwner } from '../src/infinite-world/legacy-core/g3/detail-candidates.js';
import {
  resolveW8CanonicalFarTreeDensityOpacity,
  resolveW8CanonicalFarTreeDensityRank,
  resolveW8CanonicalFarTreeDensityThreshold,
  resolveW8VegetationLodBlend,
  resolveW8VegetationLodPolicy,
} from '../src/infinite-world/vegetation-lod-policy.js';
import {
  WORLD_STREAMING_EVENT,
  WORLD_STREAMING_STREAM,
  WORLD_STREAMING_TARGET,
  createWorldStreamingTelemetry,
} from '../src/infinite-world/world-streaming-telemetry.js';
import {
  evaluateNodeStreamingBenchmark,
} from './infinite-world-streaming-performance-benchmark-helper.mjs';
import { createW8ParityChunkGenerator } from '../src/infinite-world/w8-parity-chunk-generator.js';
import {
  NATURAL_OWNER_BUILD_QUEUE_MAXIMUM,
  resolveNaturalOwnerBuildQueueTarget,
} from '../src/infinite-world/streaming-capacity-budget.js';
import {
  createRenderFrameAcknowledger,
  createVisualContinuityRegistry,
} from '../src/infinite-world/visual-continuity.js';

const LEGACY_CHUNK_SIZE_METERS = 16;
const LEGACY_FIVE_BY_FIVE_HALF_EXTENT_METERS = LEGACY_CHUNK_SIZE_METERS * 2.5;
const CANONICAL_WORLD_SEED_HASH = `sha256:${'0'.repeat(64)}`;

const markCompletedRenderFrame = (presentation, scene) => {
  const acknowledger = createRenderFrameAcknowledger();
  const token = acknowledger.beginFrame();
  return presentation.markFirstDraw(acknowledger.completeFrame(token, { scene }));
};

class DistantTestVector {
  constructor() { this.set(0, 0, 0); }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
}

const distantTestSrgbToLinear = value => (
  value < 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
);

class DistantTestColor {
  constructor(hex = 0xffffff) {
    this.isColor = true;
    this.hex = hex;
    this.r = distantTestSrgbToLinear(((hex >> 16) & 0xff) / 255);
    this.g = distantTestSrgbToLinear(((hex >> 8) & 0xff) / 255);
    this.b = distantTestSrgbToLinear((hex & 0xff) / 255);
  }
  getHex() { return this.hex; }
}

class DistantTestMatrix {
  constructor(value = {}) {
    this.value = structuredClone(value);
    this.elements = new Float32Array([
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      value?.position?.x ?? 0, value?.position?.y ?? 0, value?.position?.z ?? 0, 1,
    ]);
  }
  clone() { return new DistantTestMatrix(this.value); }
}

class DistantTestNode {
  constructor() {
    this.children = [];
    this.position = new DistantTestVector();
    this.rotation = new DistantTestVector();
    this.scale = new DistantTestVector().set(1, 1, 1);
    this.matrix = new DistantTestMatrix();
    this.userData = {};
  }
  add(child) { this.children.push(child); child.parent = this; }
  remove(child) {
    this.children = this.children.filter(value => value !== child);
    child.parent = null;
  }
  clear() {
    for (const child of this.children) child.parent = null;
    this.children = [];
  }
  updateMatrix() {
    this.matrix = new DistantTestMatrix({
      position: { ...this.position },
      rotation: { ...this.rotation },
      scale: { ...this.scale },
    });
  }
}

class DistantTestGroup extends DistantTestNode {}
class DistantTestGeometry {
  constructor() { this.attributes = {}; this.groups = []; this.userData = {}; }
  clone() {
    const clone = new this.constructor();
    clone.attributes = { ...this.attributes };
    clone.groups = this.groups.map(group => ({ ...group }));
    clone.index = this.index;
    clone.userData = { ...this.userData };
    return clone;
  }
  setAttribute(name, attribute) { this.attributes[name] = attribute; }
  setIndex(index) { this.index = index; }
  addGroup(start, count, materialIndex) { this.groups.push({ start, count, materialIndex }); }
  computeVertexNormals() {}
  dispose() { this.disposed = true; }
}
class DistantTestBufferGeometry extends DistantTestGeometry {}
class DistantTestPlaneGeometry extends DistantTestGeometry {}
class DistantTestFloat32BufferAttribute {
  constructor(values, itemSize) {
    this.values = values;
    this.array = values;
    this.itemSize = itemSize;
    this.updateRanges = [];
    this.needsUpdate = false;
  }
  clearUpdateRanges() { this.updateRanges.length = 0; }
  addUpdateRange(start, count) { this.updateRanges.push({ start, count }); }
}
class DistantTestR160Float32BufferAttribute extends DistantTestFloat32BufferAttribute {
  constructor(values, itemSize) {
    const copiedValues = new Float32Array(values);
    super(copiedValues, itemSize);
    this.constructorInput = values;
    this.version = 0;
    this.updateRequested = false;
    Object.defineProperty(this, 'needsUpdate', {
      configurable: true,
      get: () => this.updateRequested,
      set: value => {
        this.updateRequested = value === true;
        if (value === true) this.version += 1;
      },
    });
  }
}
class DistantTestInstancedBufferAttribute extends DistantTestFloat32BufferAttribute {}
class DistantTestMaterial {
  constructor(options = {}) { Object.assign(this, options); }
  clone() { return new DistantTestMaterial({ ...this, userData: { ...(this.userData ?? {}) } }); }
  dispose() { this.disposed = true; }
}
class DistantTestMesh extends DistantTestNode {
  constructor(geometry, material) {
    super();
    this.geometry = geometry;
    this.material = material;
  }
}
class DistantTestLineSegments extends DistantTestMesh {}
class DistantTestInstancedMesh extends DistantTestMesh {
  constructor(geometry, material, capacity) {
    super(geometry, material);
    this.capacity = capacity;
    this.count = 0;
    this.matrices = [];
    this.instanceMatrix = {
      updateCount: 0,
      version: 0,
      array: [],
      updateRanges: [],
      clearUpdateRanges() { this.updateRanges.length = 0; },
      addUpdateRange(start, count) { this.updateRanges.push({ start, count }); },
    };
    Object.defineProperty(this.instanceMatrix, 'needsUpdate', {
      set(value) {
        if (value === true) {
          this.updateCount += 1;
          this.version += 1;
        }
      },
    });
  }
  setMatrixAt(index, matrix) {
    this.matrices[index] = matrix.clone?.() ?? structuredClone(matrix);
    for (let component = 0; component < 16; component += 1) {
      this.instanceMatrix.array[index * 16 + component] = matrix.elements[component];
    }
  }
}
class DistantTestObject3D extends DistantTestNode {}

const DISTANT_TEST_THREE = Object.freeze({
  Group: DistantTestGroup,
  Mesh: DistantTestMesh,
  InstancedMesh: DistantTestInstancedMesh,
  Object3D: DistantTestObject3D,
  PlaneGeometry: DistantTestPlaneGeometry,
  BufferGeometry: DistantTestBufferGeometry,
  Float32BufferAttribute: DistantTestFloat32BufferAttribute,
  InstancedBufferAttribute: DistantTestInstancedBufferAttribute,
  Color: DistantTestColor,
  MeshLambertMaterial: DistantTestMaterial,
  LineBasicMaterial: DistantTestMaterial,
  LineSegments: DistantTestLineSegments,
});

const CANONICAL_HOUSE_PART = Object.freeze({
  geometry: 'box',
  material: 'houseWall',
  position: Object.freeze([0, 0.5, 0]),
  scale: Object.freeze([1, 1, 1]),
  rotation: Object.freeze([0, 0, 0]),
  materialRole: 'wall',
});

const SHRUB_PART = Object.freeze({
  geometry: 'box',
  material: 'bush',
  position: Object.freeze([0, 0.38, 0]),
  scale: Object.freeze([1, 1, 1]),
  rotation: Object.freeze([0, 0, 0]),
});

const TREE_PART = Object.freeze({
  geometry: 'box',
  material: 'bush',
  position: Object.freeze([0, 0.5, 0]),
  scale: Object.freeze([1, 1, 1]),
  rotation: Object.freeze([0, 0, 0]),
});

const ROCK_PART = Object.freeze({
  geometry: 'box',
  material: 'bush',
  position: Object.freeze([0, 0.42, 0]),
  scale: Object.freeze([1, 0.72, 1]),
  rotation: Object.freeze([0, 0, 0]),
});

function createDistantTestVisualAssets() {
  const geometry = new DistantTestGeometry();
  const material = () => new DistantTestMaterial();
  return {
    geometries: { box: geometry },
    materials: {
      houseWall: material(),
      road: material(),
      lotResidential: material(),
      lotCivic: material(),
      water: material(),
      bush: material(),
    },
    featureParts: {
      house: [CANONICAL_HOUSE_PART],
      tree: [TREE_PART],
      broadleafTree: [TREE_PART],
      wetlandTree: [TREE_PART],
      shrub: [SHRUB_PART],
      grass: [SHRUB_PART],
      rock: [ROCK_PART],
      factory: [CANONICAL_HOUSE_PART],
      barn: [CANONICAL_HOUSE_PART],
      militaryBase: [CANONICAL_HOUSE_PART],
    },
    resolveBuildingParts: record =>
      record.buildingType === 'house' ? [CANONICAL_HOUSE_PART] : null,
  };
}

const SILHOUETTE_TREE_TRUNK_PART = Object.freeze({
  geometry: 'box', material: 'treeTrunk', position: Object.freeze([0, 0.2, 0]),
  scale: Object.freeze([0.2, 0.4, 0.2]), rotation: Object.freeze([0, 0, 0]),
});
const SILHOUETTE_BROADLEAF_PRIMARY_PART = Object.freeze({
  geometry: 'sphere', material: 'treeLeavesMeadow', position: Object.freeze([0, 0.64, 0]),
  scale: Object.freeze([0.82, 0.72, 0.82]), rotation: Object.freeze([0, 0, 0]),
});
const SILHOUETTE_BROADLEAF_SECONDARY_PART = Object.freeze({
  geometry: 'sphere', material: 'treeLeavesMeadow', position: Object.freeze([0.22, 0.78, -0.12]),
  scale: Object.freeze([0.48, 0.45, 0.48]), rotation: Object.freeze([0, 0, 0]),
});
const SILHOUETTE_WETLAND_PRIMARY_PART = Object.freeze({
  geometry: 'sphere', material: 'treeLeavesForest', position: Object.freeze([0, 0.61, 0]),
  scale: Object.freeze([0.78, 0.68, 0.78]), rotation: Object.freeze([0, 0, 0]),
});
const SILHOUETTE_WETLAND_SECONDARY_PART = Object.freeze({
  geometry: 'sphere', material: 'treeLeavesForest', position: Object.freeze([-0.18, 0.76, 0.1]),
  scale: Object.freeze([0.44, 0.42, 0.44]), rotation: Object.freeze([0, 0, 0]),
});
const SILHOUETTE_CONIFER_PART = Object.freeze({
  geometry: 'cone', material: 'treeLeaves', position: Object.freeze([0, 0.65, 0]),
  scale: Object.freeze([0.76, 0.78, 0.76]), rotation: Object.freeze([0, 0, 0]),
});

function createSilhouetteTestVisualAssets() {
  const geometry = triangleCount => {
    const value = new DistantTestGeometry();
    value.setAttribute('position', new DistantTestFloat32BufferAttribute(new Float32Array([
      -0.5, -0.5, 0,
      0.5, -0.5, 0,
      0, 0.5, 0,
    ]), 3));
    value.setAttribute('normal', new DistantTestFloat32BufferAttribute(new Float32Array([
      0, 0, 1,
      0, 0, 1,
      0, 0, 1,
    ]), 3));
    value.setIndex(Array.from({ length: triangleCount * 3 }, (_, index) => index % 3));
    return value;
  };
  const material = color => new DistantTestMaterial(
    Number.isFinite(color) ? { color } : {},
  );
  return {
    geometries: {
      box: geometry(12),
      sphere: geometry(264),
      cone: geometry(16),
      dodeca: geometry(36),
    },
    materials: {
      houseWall: material(), road: material(), lotResidential: material(), lotCivic: material(),
      water: material(), bush: material(), grass: material(), grassLight: material(),
      treeTrunk: material(0x5d4037),
      treeLeaves: material(0x2e7d32),
      treeLeavesForest: material(0x1b5e20), treeLeavesMeadow: material(0x7cb342),
      wetlandLeaves: material(0x1b5e20),
    },
    featureParts: {
      house: [CANONICAL_HOUSE_PART],
      tree: [SILHOUETTE_TREE_TRUNK_PART, SILHOUETTE_CONIFER_PART],
      broadleafTree: [
        SILHOUETTE_TREE_TRUNK_PART,
        SILHOUETTE_BROADLEAF_PRIMARY_PART,
        SILHOUETTE_BROADLEAF_SECONDARY_PART,
      ],
      wetlandTree: [
        SILHOUETTE_TREE_TRUNK_PART,
        SILHOUETTE_WETLAND_PRIMARY_PART,
        SILHOUETTE_WETLAND_SECONDARY_PART,
      ],
      shrub: [SHRUB_PART], rock: [ROCK_PART],
    },
    resolveBuildingParts: record =>
      record.buildingType === 'house' ? [CANONICAL_HOUSE_PART] : null,
  };
}

function flatDistantTerrain() {
  return {
    resolution: { x: 2, z: 2 },
    heightUnitMeters: 0.001,
    heights: new Int32Array(4),
    materialWeights: new Float64Array([
      1, 0, 0, 0, 0,
      1, 0, 0, 0, 0,
      1, 0, 0, 0, 0,
      1, 0, 0, 0, 0,
    ]),
  };
}

const CANONICAL_SETTLEMENT_ID = 'settlement-v1:gate-a';
const CANONICAL_BUILDING_ID = 'settlement-building-v1:gate-a-house';
const CANONICAL_BUILDING = Object.freeze({
  stableId: CANONICAL_BUILDING_ID,
  settlementId: CANONICAL_SETTLEMENT_ID,
  featureType: 'settlement-building',
  buildingType: 'house',
  worldPosition: Object.freeze({ x: 88, y: 0.4, z: 8 }),
  rotationY: 0.375,
  widthMeters: 6,
  heightMeters: 4,
  depthMeters: 5,
  radiusMeters: 4,
  visual: Object.freeze({ paletteIndex: 2, roofVariant: 'gable' }),
  owningChunkCoordinate: Object.freeze({ x: 5, z: 0 }),
});

function canonicalChunk(chunkX = 5, chunkZ = 0, records = [CANONICAL_BUILDING]) {
  return {
    chunkX,
    chunkZ,
    chunkId: `w8-parity-chunk:${chunkX},${chunkZ}`,
    generatorVersion: Object.freeze({ major: 800, minor: 0, patch: 0, id: '800.0.0' }),
    contentHash: `sha256:${'1'.repeat(64)}`,
    sourceW5ContentHash: `sha256:${'2'.repeat(64)}`,
    terrain: flatDistantTerrain(),
    vegetationCandidates: [],
    rockCandidates: [],
    settlementFeatures: records,
    settlementLandmarks: [],
    presentationLayers: {
      natural: { vegetation: [], rocks: [] },
      formal: { roadsAndBuildings: records },
      landmarks: [],
    },
  };
}

function canonicalMacroTerrainChunk({ chunkX, chunkZ, macro, surfacePolicy }) {
  const resolution = 33;
  const heights = [];
  const materialWeights = [];
  for (let z = 0; z < resolution; z += 1) {
    for (let x = 0; x < resolution; x += 1) {
      heights.push(Math.round(400 + macro.evaluate(
        chunkX * LEGACY_CHUNK_SIZE_METERS + x * 0.5,
        chunkZ * LEGACY_CHUNK_SIZE_METERS + z * 0.5,
      ).offsetMm));
      materialWeights.push(1, 0, 0, 0, 0);
    }
  }
  return {
    ...canonicalChunk(chunkX, chunkZ, []),
    terrain: {
      resolution: { x: resolution, z: resolution },
      heightUnitMeters: 0.001,
      sampleSpacingMeters: 0.5,
      heights,
      materialWeights,
    },
    canonicalSurfacePolicy: surfacePolicy,
  };
}

async function createAdjacentTownPresentationFixture() {
  const minimumTownSeparationMeters = 394.196176;
  const townRadiusMeters = 94.5;
  const halfSeparation = minimumTownSeparationMeters / 2;
  const nearEdgeDistance = halfSeparation - townRadiusMeters;
  const macro = await createMacroTerrainEvaluator(CANONICAL_WORLD_SEED_HASH);
  const canonicalGround = (worldX, worldZ) => {
    const ownerX = Math.floor(worldX / LEGACY_CHUNK_SIZE_METERS);
    const ownerZ = Math.floor(worldZ / LEGACY_CHUNK_SIZE_METERS);
    const fx = Math.max(0, Math.min(32,
      (worldX - ownerX * LEGACY_CHUNK_SIZE_METERS) / 0.5));
    const fz = Math.max(0, Math.min(32,
      (worldZ - ownerZ * LEGACY_CHUNK_SIZE_METERS) / 0.5));
    const x0 = Math.floor(fx); const z0 = Math.floor(fz);
    const x1 = Math.min(32, x0 + 1); const z1 = Math.min(32, z0 + 1);
    const tx = fx - x0; const tz = fz - z0;
    const at = (sampleX, sampleZ) => Math.round(400 + macro.evaluate(
      ownerX * LEGACY_CHUNK_SIZE_METERS + sampleX * 0.5,
      ownerZ * LEGACY_CHUNK_SIZE_METERS + sampleZ * 0.5,
    ).offsetMm) * 0.001;
    const northwest = at(x0, z0);
    const northeast = at(x1, z0);
    const southwest = at(x0, z1);
    const southeast = at(x1, z1);
    const value = tx + tz <= 1
      ? northwest + tx * (northeast - northwest) + tz * (southwest - northwest)
      : northeast * (1 - tz) + southwest * (1 - tx) + southeast * (tx + tz - 1);
    return Math.round(value * 1e6) / 1e6;
  };
  const candidates = [];
  const templates = new Map();
  const chunks = new Map();
  for (const [index, side] of ['west', 'east'].entries()) {
    const direction = index ? 1 : -1;
    const settlementId = `settlement-v1:adjacent-town-${side}`;
    const centerX = direction * halfSeparation;
    const buildingX = direction * nearEdgeDistance;
    const stableId = `${settlementId}:building:edge`;
    const ownerX = Math.floor(buildingX / LEGACY_CHUNK_SIZE_METERS);
    // Canonical boundary ownership assigns the z=0 seam to the lower owner.
    const ownerZ = -1;
    const record = Object.freeze({
      stableId,
      settlementId,
      featureType: 'settlement-building',
      buildingType: 'house',
      worldPosition: Object.freeze({ x: buildingX, y: canonicalGround(buildingX, 0), z: 0 }),
      rotationY: 0,
      widthMeters: 6,
      heightMeters: 4,
      depthMeters: 5,
      radiusMeters: 4,
      visual: null,
      owningChunkCoordinate: Object.freeze({ x: ownerX, z: ownerZ }),
      lodPolicy: Object.freeze({
        near: Object.freeze({ ownerSet: 'rendered', presentationTier: 'full' }),
        outer: Object.freeze({ ownerSet: 'active', presentationTier: 'full' }),
        far: Object.freeze({ ownerSet: 'queried', presentationTier: 'horizon' }),
        presentationTiers: Object.freeze(['full', 'horizon']),
      }),
    });
    const candidate = Object.freeze({
      settlementId,
      settlementType: 'TOWN',
      townType: index ? 'school_town' : 'church_town',
      center: Object.freeze({ x: centerX, z: 0 }),
      radiusMeters: townRadiusMeters,
    });
    const source = Object.freeze({
      stableId,
      settlementId,
      buildingType: 'house',
      x: buildingX,
      z: 0,
      rotationY: 0,
      widthMeters: 6,
      heightMeters: 4,
      depthMeters: 5,
      visual: null,
    });
    candidates.push(candidate);
    templates.set(settlementId, Object.freeze({
      settlementId,
      settlementType: candidate.settlementType,
      townType: candidate.townType,
      center: candidate.center,
      buildings: Object.freeze([source]),
      roads: Object.freeze([]),
    }));
    chunks.set(`${ownerX},${ownerZ}`, canonicalChunk(ownerX, ownerZ, [record]));
  }
  return Object.freeze({
    candidates: Object.freeze(candidates),
    templates,
    chunks,
    stableIds: Object.freeze(candidates.map(candidate => (
      `${candidate.settlementId}:building:edge`
    ))),
    createPresentation: async ({
      scene = new DistantTestGroup(),
      getNearVisibleStableIds = () => [],
      yieldToMainThread,
      visualAssets = createDistantTestVisualAssets(),
    } = {}) => createW8DistantPresentation({
      THREE: DISTANT_TEST_THREE,
      scene,
      worldSeedHash: CANONICAL_WORLD_SEED_HASH,
      visualAssets,
      findSettlementsNear: async () => candidates,
      resolveTemplate: async ({ candidate: value }) => templates.get(value.settlementId),
      getCanonicalChunkData: async (chunkX, chunkZ) => (
        chunks.get(`${chunkX},${chunkZ}`) ?? canonicalChunk(chunkX, chunkZ, [])
      ),
      getNearVisibleStableIds,
      ...(yieldToMainThread ? { yieldToMainThread } : {}),
    }),
  });
}

const CANONICAL_CANDIDATE = Object.freeze({
  settlementId: CANONICAL_SETTLEMENT_ID,
  worldPosition: Object.freeze({ x: 88, z: 8 }),
});

const CANONICAL_TEMPLATE = Object.freeze({
  settlementId: CANONICAL_SETTLEMENT_ID,
  center: Object.freeze({ x: 88, z: 8 }),
  buildings: Object.freeze([Object.freeze({ x: 88, z: 8 })]),
  roads: Object.freeze([]),
});

function canonicalSyncInput({
  centerChunkX,
  activeDataKeys,
  renderedKeys,
  chunk = canonicalChunk(),
  playerLogicalX = centerChunkX * LEGACY_CHUNK_SIZE_METERS + 8,
  quality = 'medium',
} = {}) {
  return {
    activeDataKeys,
    renderedKeys,
    getChunkData: (chunkX, chunkZ) =>
      chunkX === chunk.chunkX && chunkZ === chunk.chunkZ ? chunk : null,
    renderOrigin: { renderOriginChunkX: centerChunkX, renderOriginChunkZ: 0 },
    centerChunkX,
    centerChunkZ: 0,
    quality,
    playerLogicalX,
    playerLogicalZ: 8,
  };
}

function localTerrainCoverageFixture(centerChunkX = 0, centerChunkZ = 0) {
  const activeDataKeys = [];
  const renderedKeys = [];
  const chunks = new Map();
  for (let chunkZ = centerChunkZ - 2; chunkZ <= centerChunkZ + 2; chunkZ += 1) {
    for (let chunkX = centerChunkX - 2; chunkX <= centerChunkX + 2; chunkX += 1) {
      const key = `${chunkX},${chunkZ}`;
      activeDataKeys.push(key);
      if (Math.abs(chunkX - centerChunkX) <= 1 && Math.abs(chunkZ - centerChunkZ) <= 1) {
        renderedKeys.push(key);
      }
      chunks.set(key, canonicalChunk(chunkX, chunkZ, []));
    }
  }
  activeDataKeys.sort();
  renderedKeys.sort();
  return {
    activeDataKeys,
    renderedKeys,
    chunks,
    getChunkData: (chunkX, chunkZ) => chunks.get(`${chunkX},${chunkZ}`) ?? null,
    renderOrigin: { renderOriginChunkX: centerChunkX, renderOriginChunkZ: centerChunkZ },
    centerChunkX,
    centerChunkZ,
  };
}

async function createLocalTerrainTestPresentation(scene = new DistantTestGroup(), overrides = {}) {
  const controlledYield = overrides.yieldToMainThread;
  const controlledTerrainScheduler = controlledYield
    && !overrides.terrainContinuationScheduler ? {
      beginGeneration: () => 1,
      waitForContinuation: () => controlledYield(),
      pumpFrame: () => Object.freeze({
        frameSequence: 0, resumed: 0, allowance: 0, urgent: false, pending: 0,
      }),
      recordSlice: () => {},
      completeGeneration: () => true,
      snapshot: () => Object.freeze({
        terrainSliceCount: 0,
        terrainSliceCpuMs: 0,
        terrainSliceP50Ms: 0,
        terrainSliceP95Ms: 0,
        terrainSliceMaxMs: 0,
        terrainResumeWaitP50Ms: 0,
        terrainResumeWaitP95Ms: 0,
        terrainResumeWaitMaxMs: 0,
        terrainDeadlineMissCount: 0,
        terrainDeadlineMissMaxMs: 0,
        terrainGenerationCpuMs: 0,
        terrainGenerationYieldWaitMs: 0,
        terrainGenerationWallMs: 0,
        presentationSchedulerTerrainSlices: 0,
      }),
      shutdown: () => true,
    } : null;
  const defaultTerrainScheduler = !controlledTerrainScheduler
    && !overrides.terrainContinuationScheduler
    ? createDeadlineAwareTerrainPresentationScheduler({
      postTaskFn: callback => new Promise(resolve => setImmediate(() => {
        callback();
        resolve();
      })),
      AbortControllerCtor: null,
    }) : null;
  return createW8DistantPresentation({
    THREE: DISTANT_TEST_THREE,
    scene,
    worldSeedHash: CANONICAL_WORLD_SEED_HASH,
    visualAssets: createSilhouetteTestVisualAssets(),
    findSettlementsNear: async () => [],
    resolveTemplate: async () => null,
    getCanonicalChunkData: async (chunkX, chunkZ) => canonicalChunk(chunkX, chunkZ, []),
    ...overrides,
    ...(controlledTerrainScheduler
      ? { terrainContinuationScheduler: controlledTerrainScheduler } : {}),
    ...(defaultTerrainScheduler
      ? { terrainContinuationScheduler: defaultTerrainScheduler } : {}),
  });
}

test('deadline-aware Terrain scheduler bounds frame slices, prioritizes urgent work, and records real waits', async () => {
  let now = 0;
  const postTasks = [];
  const continuationTasks = [];
  const scheduler = createDeadlineAwareTerrainPresentationScheduler({
    clock: () => now,
    setTimeoutFn: () => ({ type: 'timeout' }),
    clearTimeoutFn: () => {},
    postTaskFn: (callback, options) => {
      postTasks.push({ callback, options });
      return Promise.resolve();
    },
    scheduleTaskFn: callback => continuationTasks.push(callback),
    AbortControllerCtor: null,
    normalResumeDeadlineMs: 18,
    urgentResumeDeadlineMs: 10,
    normalSlicesPerFrame: 1,
    urgentSlicesPerFrame: 2,
  });
  const urgentGeneration = scheduler.beginGeneration({ isUrgent: () => true });
  const firstPromise = scheduler.waitForContinuation({ isUrgent: () => true });
  const secondPromise = scheduler.waitForContinuation({ isUrgent: () => true });
  const thirdPromise = scheduler.waitForContinuation({ isUrgent: () => true });
  const frame = scheduler.pumpFrame();
  assert.equal(frame.urgent, true);
  assert.equal(frame.allowance, 2);
  const first = await firstPromise;
  assert.equal(first.source, 'frame');
  assert.equal(continuationTasks.length, 1);
  continuationTasks.shift()();
  const second = await secondPromise;
  assert.equal(second.source, 'frame');
  assert.equal(scheduler.snapshot().pendingContinuationCount, 1);
  const nextFrame = scheduler.pumpFrame();
  assert.equal(nextFrame.resumed, 1);
  assert.equal((await thirdPromise).source, 'frame');

  assert.equal(scheduler.setGenerationStage(urgentGeneration, 'clipmap'), true);
  assert.equal(scheduler.recordGenerationSlice(urgentGeneration, 2.25), true);
  assert.equal(scheduler.recordGenerationYield(urgentGeneration, 12), true);
  const activeGeneration = scheduler.snapshot().activeGenerations[0];
  assert.equal(activeGeneration.stage, 'clipmap');
  assert.equal(activeGeneration.cpuMs, 2.25);
  assert.equal(activeGeneration.yieldWaitMs, 12);
  assert.equal(activeGeneration.yieldCount, 1);
  scheduler.recordSlice(2.25);
  scheduler.recordSlice(3.5);
  scheduler.completeGeneration(urgentGeneration, {
    cpuMs: 5.75,
    yieldWaitMs: 12,
    wallMs: 17.75,
  });
  const snapshot = scheduler.snapshot();
  assert.equal(snapshot.terrainSliceCount, 2);
  assert.equal(snapshot.terrainSliceCpuMs, 5.75);
  assert.equal(snapshot.terrainSliceP50Ms, 2.25);
  assert.equal(snapshot.terrainSliceP95Ms, 3.5);
  assert.equal(snapshot.terrainGenerationCpuMs, 5.75);
  assert.equal(snapshot.terrainGenerationYieldWaitMs, 12);
  assert.equal(snapshot.terrainGenerationWallMs, 17.75);
  assert.equal(snapshot.presentationSchedulerTerrainSlices, 2);
  assert.equal(snapshot.pendingContinuationCount, 0);
  assert.equal(postTasks.every(task => ['user-blocking', 'user-visible']
    .includes(task.options.priority)), true);
  assert.equal(scheduler.resetDiagnostics(), true);
  assert.equal(scheduler.snapshot().terrainSliceCount, 0);
  assert.equal(scheduler.snapshot().terrainGenerationCount, 0);
});

test('deadline-aware Terrain scheduler enforces normal fairness, deadline fallback, and shutdown', async () => {
  let now = 0;
  const postTasks = [];
  const continuationTasks = [];
  const scheduler = createDeadlineAwareTerrainPresentationScheduler({
    clock: () => now,
    setTimeoutFn: () => ({ type: 'timeout' }),
    clearTimeoutFn: () => {},
    postTaskFn: (callback, options) => {
      postTasks.push({ callback, options });
      return Promise.resolve();
    },
    scheduleTaskFn: callback => continuationTasks.push(callback),
    AbortControllerCtor: null,
    normalResumeDeadlineMs: 18,
    urgentResumeDeadlineMs: 10,
    normalSlicesPerFrame: 1,
  });
  const normalGeneration = scheduler.beginGeneration({ isUrgent: () => false });
  const firstNormal = scheduler.waitForContinuation();
  assert.equal(scheduler.pumpFrame().allowance, 1);
  assert.equal((await firstNormal).source, 'frame');
  const deferredNormal = scheduler.waitForContinuation();
  assert.equal(scheduler.snapshot().pendingContinuationCount, 1);
  assert.equal(scheduler.pumpFrame().resumed, 1);
  assert.equal((await deferredNormal).source, 'frame');
  scheduler.completeGeneration(normalGeneration, { wallMs: 1 });

  const urgentGeneration = scheduler.beginGeneration({ isUrgent: () => true });
  const deadlineResume = scheduler.waitForContinuation({ isUrgent: () => true });
  const deadlineTask = postTasks.at(-1);
  assert.equal(deadlineTask.options.priority, 'user-blocking');
  assert.equal(deadlineTask.options.delay, 10);
  now = 27;
  deadlineTask.callback();
  const resumed = await deadlineResume;
  assert.equal(resumed.source, 'deadline');
  assert.equal(resumed.waitMs, 27);
  let snapshot = scheduler.snapshot();
  assert.equal(snapshot.terrainDeadlineMissCount, 1);
  assert.equal(snapshot.terrainDeadlineMissMaxMs, 17);
  scheduler.completeGeneration(urgentGeneration, { wallMs: 27, yieldWaitMs: 27 });

  const shutdownWait = scheduler.waitForContinuation();
  assert.equal(scheduler.shutdown(), true);
  assert.equal((await shutdownWait).source, 'shutdown');
  assert.equal(scheduler.shutdown(), false);
  snapshot = scheduler.snapshot();
  assert.equal(snapshot.pendingContinuationCount, 0);
  assert.equal(snapshot.activeGenerationCount, 0);
  assert.equal(snapshot.shutdown, true);
});

function createNearPresentationHoldHarness() {
  const nearStableIds = new Set();
  const holds = new Map();
  const descriptorKey = descriptor => [
    descriptor.kind,
    descriptor.sourceIdentity,
    descriptor.projectionIdentity,
    descriptor.ownerKey,
  ].join('\n');
  return Object.freeze({
    publishNear(descriptors) {
      for (const descriptor of descriptors) nearStableIds.add(descriptor.projectionIdentity);
    },
    hold(ownerKey, descriptors) {
      const values = Object.freeze(descriptors.map(descriptor => Object.freeze({ ...descriptor })));
      holds.set(ownerKey, Object.freeze({
        ownerKey,
        heldAtMs: performance.now(),
        descriptors: values,
      }));
      for (const descriptor of values) nearStableIds.add(descriptor.projectionIdentity);
    },
    returnNear(ownerKey, descriptors) {
      holds.delete(ownerKey);
      for (const descriptor of descriptors) nearStableIds.add(descriptor.projectionIdentity);
    },
    getNearVisibleStableIds: () => Object.freeze([...nearStableIds].sort()),
    getNearPresentationHolds: () => Object.freeze([...holds.values()]),
    releaseNearPresentationHolds({ ownerKeys = [], descriptors = [] } = {}) {
      const requested = new Set(descriptors.map(descriptorKey));
      const releaseAll = descriptors.length === 0;
      const releasedOwnerKeys = [];
      let releasedDescriptorCount = 0;
      for (const ownerKey of ownerKeys) {
        const held = holds.get(ownerKey);
        if (!held) continue;
        const remaining = [];
        for (const descriptor of held.descriptors) {
          if (releaseAll || requested.has(descriptorKey(descriptor))) {
            nearStableIds.delete(descriptor.projectionIdentity);
            releasedDescriptorCount += 1;
          } else remaining.push(descriptor);
        }
        if (remaining.length === 0) {
          holds.delete(ownerKey);
          releasedOwnerKeys.push(ownerKey);
        } else {
          holds.set(ownerKey, Object.freeze({
            ...held,
            descriptors: Object.freeze(remaining),
          }));
        }
      }
      return Object.freeze({
        released: releaseAll
          ? releasedOwnerKeys.length === ownerKeys.length
          : releasedDescriptorCount === descriptors.length,
        releasedAtMs: releasedDescriptorCount ? performance.now() : null,
        releasedOwnerKeys: Object.freeze(releasedOwnerKeys),
      });
    },
    snapshot: () => Object.freeze({
      nearStableIds: Object.freeze([...nearStableIds].sort()),
      heldOwnerKeys: Object.freeze([...holds.keys()].sort()),
    }),
    dispose() {
      nearStableIds.clear();
      holds.clear();
    },
  });
}

async function waitForControlledYield(queue, maximumTurns = 2_000) {
  for (let turn = 0; turn < maximumTurns && !queue.length; turn += 1) {
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.ok(queue.length, 'incremental compose did not reach a controlled yield');
}

async function drainControlledYields(promises, queue, {
  maximumTurns = 20_000,
  whilePending = null,
} = {}) {
  let settled = false;
  const combined = Promise.all(promises).finally(() => { settled = true; });
  let turn = 0;
  while (!settled && turn < maximumTurns) {
    if (queue.length) queue.shift()();
    await new Promise(resolve => setImmediate(resolve));
    if (!settled) whilePending?.();
    turn += 1;
  }
  assert.equal(settled, true, 'incremental compose did not settle while draining yields');
  return combined;
}

function legacyClipmapAxis() {
  const values = [];
  const addRange = (from, to, step) => {
    for (let value = from; value < to - 1e-9; value += step) values.push(value);
  };
  addRange(-352, -192, 16);
  addRange(-192, -96, 8);
  addRange(-96, 96, 4);
  addRange(96, 192, 8);
  addRange(192, 352, 16);
  values.push(352);
  return values;
}

function legacyClipmapTopology() {
  const axis = legacyClipmapAxis();
  const vertices = [];
  const indices = [];
  const vertexByCoordinate = new Map();
  const vertexIndex = (x, z) => {
    const key = `${x},${z}`;
    if (vertexByCoordinate.has(key)) return vertexByCoordinate.get(key);
    const index = vertices.length;
    vertices.push({ x, z });
    vertexByCoordinate.set(key, index);
    return index;
  };
  for (let z = 0; z < axis.length - 1; z += 1) {
    for (let x = 0; x < axis.length - 1; x += 1) {
      const x0 = axis[x]; const x1 = axis[x + 1];
      const z0 = axis[z]; const z1 = axis[z + 1];
      const centerX = (x0 + x1) / 2;
      const centerZ = (z0 + z1) / 2;
      if (Math.max(Math.abs(centerX), Math.abs(centerZ))
        < LEGACY_FIVE_BY_FIVE_HALF_EXTENT_METERS) continue;
      const northwest = vertexIndex(x0, z0);
      const northeast = vertexIndex(x1, z0);
      const southwest = vertexIndex(x0, z1);
      const southeast = vertexIndex(x1, z1);
      indices.push(northwest, southwest, northeast, northeast, southwest, southeast);
    }
  }
  return { vertices, indices };
}

function legacyTerrainColorFromWeights(weights) {
  return [0, 1, 2].map(channel => weights.reduce(
    (sum, weight, index) => sum + weight * W8_PRESENTATION_TERRAIN_PALETTE[index][channel],
    0,
  ));
}

function legacyTerrainSampleAt(chunkData, worldX, worldZ) {
  const terrain = chunkData.terrain;
  const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
  const originX = chunkData.chunkX * LEGACY_CHUNK_SIZE_METERS;
  const originZ = chunkData.chunkZ * LEGACY_CHUNK_SIZE_METERS;
  const fx = clamp((worldX - originX) / LEGACY_CHUNK_SIZE_METERS, 0, 1)
    * (terrain.resolution.x - 1);
  const fz = clamp((worldZ - originZ) / LEGACY_CHUNK_SIZE_METERS, 0, 1)
    * (terrain.resolution.z - 1);
  const x0 = Math.floor(fx); const z0 = Math.floor(fz);
  const x1 = Math.min(x0 + 1, terrain.resolution.x - 1);
  const z1 = Math.min(z0 + 1, terrain.resolution.z - 1);
  const tx = fx - x0; const tz = fz - z0;
  const at = (x, z) => terrain.heights[z * terrain.resolution.x + x]
    * terrain.heightUnitMeters;
  const height = (at(x0, z0) * (1 - tx) + at(x1, z0) * tx) * (1 - tz)
    + (at(x0, z1) * (1 - tx) + at(x1, z1) * tx) * tz;
  const weights = [];
  for (let material = 0; material < W8_PRESENTATION_TERRAIN_PALETTE.length; material += 1) {
    const weightAt = (x, z) => terrain.materialWeights[
      (z * terrain.resolution.x + x) * W8_PRESENTATION_TERRAIN_PALETTE.length + material
    ];
    weights.push((weightAt(x0, z0) * (1 - tx) + weightAt(x1, z0) * tx) * (1 - tz)
      + (weightAt(x0, z1) * (1 - tx) + weightAt(x1, z1) * tx) * tz);
  }
  return { height, color: legacyTerrainColorFromWeights(weights) };
}

function deterministicTerrainFixture() {
  const width = 33;
  const depth = 29;
  const materialCount = W8_PRESENTATION_TERRAIN_PALETTE.length;
  const heights = new Int32Array(width * depth);
  const materialWeights = new Float64Array(width * depth * materialCount);
  for (let z = 0; z < depth; z += 1) {
    for (let x = 0; x < width; x += 1) {
      const sample = z * width + x;
      heights[sample] = ((x * 97 + z * 193 + x * z * 17) % 8_191) - 4_095;
      const raw = Array.from({ length: materialCount }, (_, material) =>
        ((x + 3) * (material + 5) + (z + 7) * (material + 11)) % 97 + 1);
      const total = raw.reduce((sum, value) => sum + value, 0);
      for (let material = 0; material < materialCount; material += 1) {
        materialWeights[sample * materialCount + material] = raw[material] / total;
      }
    }
  }
  return {
    chunkX: -11,
    chunkZ: 39,
    terrain: {
      resolution: { x: width, z: depth },
      heightUnitMeters: 0.001,
      heights,
      materialWeights,
    },
  };
}

test('diagnostic profiles isolate one W8 subsystem without changing baseline defaults', () => {
  assert.deepEqual(parseW8DiagnosticProfile(), { profileId: 'baseline', ...W8_DIAGNOSTIC_PROFILES.baseline });
  assert.equal(parseW8DiagnosticProfile('no-save').save, false);
  assert.equal(parseW8DiagnosticProfile('no-distant').distant, false);
  assert.equal(parseW8DiagnosticProfile('no-shadows').shadows, false);
  assert.equal(parseW8DiagnosticProfile('no-transparent').transparency, false);
  assert.equal(parseW8DiagnosticProfile('no-gameplay-sync').gameplaySync, false);
  assert.throws(() => parseW8DiagnosticProfile('worker-first'), /unsupported diagnosticProfile/);
});

test('MeasurementReport correlates stage samples with hitch frames and reports percentiles', async () => {
  let now = 0;
  const diagnostics = createW8RuntimeDiagnostics({
    enabled: true,
    clock: () => now,
    globalObject: {},
    profile: parseW8DiagnosticProfile('baseline'),
    runNumber: 2,
    environment: { viewport: '1920x1080' },
  });
  diagnostics.startFrame(0);
  diagnostics.measure('render', () => { now += 12; });
  diagnostics.recordWork('settlement-shadow-observation', {
    calls: 3,
    canonicalObjectsScanned: 900,
  });
  diagnostics.recordEvent('terrain-old-released', {
    ownerKey: '0,0',
    coverageGeneration: 7,
  });
  await diagnostics.measureAsync('save-serialization', async () => { now += 44; });
  diagnostics.finishFrame(56, now);
  now += 1;
  diagnostics.startFrame(now);
  diagnostics.measure('render', () => { now += 10; });
  diagnostics.finishFrame(10, now);

  const report = diagnostics.snapshot({ geometries: 7 });
  assert.equal(report.schemaVersion, 'w8-measurement-report-1');
  assert.equal(report.runNumber, 2);
  assert.equal(report.frame.count, 2);
  assert.equal(report.frame.p95, 56);
  assert.equal(report.hitchRatio, 0.5);
  assert.equal(report.hitches[0].stages['save-serialization'], 44);
  assert.equal(report.hitches[0].work['settlement-shadow-observation'].calls, 3);
  assert.equal(report.frames[0].work['settlement-shadow-observation']
    .canonicalObjectsScanned, 900);
  assert.equal(report.work['settlement-shadow-observation'].calls.max, 3);
  assert.deepEqual(report.events[0], {
    sequence: 1,
    type: 'terrain-old-released',
    timestampMs: 12,
    frameSequence: 1,
    ownerKey: '0,0',
    coverageGeneration: 7,
  });
  assert.equal(report.stages.render.count, 2);
  assert.equal(report.resources.geometries, 7);
  const hudReport = diagnostics.hudSnapshot(
    { geometries: 7 },
    ['render', 'save-serialization', 'missing', 'render'],
  );
  assert.equal(hudReport.schemaVersion, 'w8-hud-measurement-summary-1');
  assert.equal(hudReport.frame.p95, 56);
  assert.equal(hudReport.hitchRatio, 0.5);
  assert.equal(hudReport.stages.render.count, 2);
  assert.equal(hudReport.stages['save-serialization'].p95, 44);
  assert.equal(hudReport.stages.missing.count, 0);
  assert.deepEqual(Object.keys(hudReport.stages), ['render', 'save-serialization', 'missing']);
  assert.equal(hudReport.longTaskCount, 0);
  assert.equal(hudReport.longTaskMaximumMs, 0);
  assert.equal(hudReport.resources.geometries, 7);
  assert.equal('frames' in hudReport, false);
  assert.equal('work' in hudReport, false);
  assert.equal('events' in hudReport, false);
  assert.equal('browserFrameAttribution' in hudReport, false);
  diagnostics.dispose();
});

test('five-run acceptance uses finite, before-W8, and after-W8 medians without weakening hitches', () => {
  const report = (p95, p99, hitchRatio, { stopStage = null, max = 60 } = {}) => ({
    frame: { p95, p99, max }, hitchRatio, longTasks: [],
    hitches: stopStage ? [{ durationMs: 120, stages: { [stopStage]: 85 } }] : [],
  });
  const finiteReports = [14, 15, 16, 15, 14].map(value => report(value, value + 12, 0));
  const beforeW8Reports = [18, 18, 19, 20, 19].map(value => report(value, 35, 0.004));
  const w8Reports = [18, 19, 20, 19, 18].map(value => report(value, 36, 0.004));
  const accepted = evaluateW8PerformanceRuns({ finiteReports, beforeW8Reports, w8Reports });
  assert.equal(accepted.pass, true);
  assert.equal(accepted.scenario, 'normal');
  assert.deepEqual(accepted.limits, {
    finiteP95: 20,
    finiteP99: 40.5,
    absoluteOver50Ratio: 0.005,
    finiteRelativeOver50Ratio: 0.005,
    beforeW8P95: 20.900000000000002,
    beforeW8P99: 38.5,
    beforeW8Over50Ratio: null,
  });
  assert.equal(accepted.diagnostics.maximumFrameMs, 60);

  const stopped = w8Reports.map((value, index) => index < 2
    ? report(18, 36, 0.004, { stopStage: 'distant-sync', max: 150 }) : value);
  const rejected = evaluateW8PerformanceRuns({
    finiteReports, beforeW8Reports, w8Reports: stopped,
  });
  assert.equal(rejected.pass, false);
  assert.deepEqual(rejected.recurringStageStops, [{ stage: 'distant-sync', runCount: 2 }]);
  assert.deepEqual(correlateW8HitchStages(stopped), [{ stage: 'distant-sync', runCount: 2 }]);
  assert.throws(() => evaluateW8PerformanceRuns({ finiteReports: [], w8Reports }), /exactly five/);
});

test('natural-object selection has no 12m cluster threshold and canonical visibility is bounded', () => {
  const candidate = {
    candidateId: 'detail-v1:vegetation:lod-stability',
    subtype: 'broadleaf-tree',
    variationSeed: 0.7,
    worldPosition: { x: 12, y: 0, z: -7 },
  };
  assert.equal(
    isW8NaturalCandidateVisible(candidate, 0),
    isW8NaturalCandidateVisible(candidate, 12),
    'camera distance must not change the canonical tree set',
  );
  for (const worldX of [0.001, 11.999, 12.001, 23.999, 24.001]) {
    assert.equal(
      isW8NaturalCandidateVisible({ ...candidate, worldPosition: { x: worldX, y: 0, z: 11.999 }, variationSeed: 0 }),
      true,
      `12m boundary at ${worldX} must not change candidate admission`,
    );
  }
  assert.equal(isW8NaturalCandidateVisible({ ...candidate, variationSeed: 1 }), true);

  assert.deepEqual(W8_NATURAL_CANONICAL_VISIBILITY_METERS, {
    short: 84,
    standard: 112,
    current: 140,
  });
  assert.equal(isW8DistantNaturalProxyInRange(0), true);
  assert.equal(isW8DistantNaturalProxyInRange(24), true);
  assert.equal(isW8DistantNaturalProxyInRange(40), true);
  assert.equal(isW8DistantNaturalProxyInRange(339.999), true);
  assert.equal(isW8DistantNaturalProxyInRange(340), false);
  assert.equal(isW8DistantNaturalProxyInRange(179.999, 'short'), true);
  assert.equal(isW8DistantNaturalProxyInRange(180, 'short'), false);
  assert.equal(isW8DistantNaturalProxyInRange(Number.NaN), false);
});

test('shrub visual contract remains aligned across presentation levels', () => {
  const candidate = Object.freeze({
    candidateId: 'detail-v1:vegetation:shrub-lod-parity',
    subtype: 'shrub',
    variationSeed: 1,
    orientationSeed: 0.25,
    worldPosition: Object.freeze({ x: 88, y: 0.4, z: 8 }),
    owningChunkCoordinate: Object.freeze({ x: 5, z: 0 }),
    metadata: Object.freeze({ candidateRadiusMeters: 0.2 }),
  });
  const visual = resolveW8NaturalCandidateVisual(candidate);
  assert.deepEqual(visual, {
    visualKind: 'shrub',
    widthMeters: 0.2 * 2.2 * 1.16,
    heightMeters: 0.85 * 1.16,
    depthMeters: 0.2 * 2.2 * 1.16,
    rotationY: Math.PI / 2,
  });

});

test('committed runtime state updates Near/Outer exclusion immediately and rejects an older origin', async () => {
  const tree = Object.freeze({
    candidateId: 'detail-v1:vegetation:origin-handoff',
    subtype: 'broadleaf-tree', variationSeed: 1, orientationSeed: 0.25,
    worldPosition: Object.freeze({ x: 88, y: 0.4, z: 8 }),
    owningChunkCoordinate: Object.freeze({ x: 5, z: 0 }),
    metadata: Object.freeze({ candidateRadiusMeters: 0.32 }),
  });
  const chunk = canonicalChunk(5, 0, []);
  chunk.generatorVersion = { major: 800, minor: 0, patch: 0 };
  chunk.vegetationCandidates = [tree];
  chunk.presentationLayers.natural = { vegetation: [tree], rocks: [] };
  const scene = new DistantTestGroup();
  let nearVisibleStableIds = [];
  const presentation = await createW8DistantPresentation({
    THREE: DISTANT_TEST_THREE,
    scene,
    worldSeedHash: CANONICAL_WORLD_SEED_HASH,
    visualAssets: createDistantTestVisualAssets(),
    findSettlementsNear: async () => [],
    resolveTemplate: async () => null,
    getCanonicalChunkData: async () => chunk,
    getNearVisibleStableIds: () => nearVisibleStableIds,
    incrementalStaticTreePages: true,
  });
  const syncInput = canonicalSyncInput({
    centerChunkX: 3, activeDataKeys: ['5,0'], renderedKeys: [], chunk,
  });
  assert.equal(await presentation.sync(syncInput), true);
  presentation.applyStaticNaturalPlan({
    coverageGeneration: 1,
    planRevision: 1,
    planId: 'origin-handoff-presentation-owner',
    destructionRevision: 'none',
    quality: 'high',
    renderDistancePreset: 'current',
    renderOrigin: syncInput.renderOrigin,
    playerLogicalX: syncInput.playerLogicalX,
    playerLogicalZ: syncInput.playerLogicalZ,
    activeDataKeys: ['5,0'],
    renderedKeys: [],
    retainedOwnerKeys: ['5,0'],
    resourceKindEntries: [['5,0', 'presentation']],
    readyPages: [{
      ownerKey: '5,0', resourceKind: 'presentation', value: chunk,
      readyAtMs: performance.now(), required: true,
    }],
  });
  for (let frame = 0; frame < 100
    && presentation.snapshot().staticTreeCurrentPublishedOwnerCount !== 1; frame += 1) {
    presentation.update(syncInput.playerLogicalX, syncInput.playerLogicalZ, syncInput.renderOrigin);
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(presentation.canonicalAuditSnapshot()[0].visibleLod, 'mid');
  const generationRoot = scene.children.find(child => (
    child.name === 'w8-persistent-static-natural-pages'
  ));
  assert.ok(generationRoot);
  const buildLocalX = generationRoot.position.x;

  nearVisibleStableIds = [tree.candidateId];
  assert.equal(presentation.commitRuntimeState({
    activeDataKeys: ['5,0'], renderedKeys: ['5,0'],
    renderOrigin: { renderOriginChunkX: 4, renderOriginChunkZ: 0, rebaseCount: 4 },
    quality: 'medium', playerLogicalX: 72, playerLogicalZ: 8,
  }), true);
  presentation.update(72, 8, {
    renderOriginChunkX: 4, renderOriginChunkZ: 0, rebaseCount: 4,
  });
  assert.equal(presentation.canonicalAuditSnapshot()[0].visibleLod, 'near');
  assert.equal(scene.children.find(child => (
    child.name === 'w8-persistent-static-natural-pages'
  )), generationRoot,
    'owner handoff reuses the complete generation instead of flashing a replacement root');
  assert.equal(generationRoot.position.x, buildLocalX - RENDER_CHUNK_SIZE,
    'the generation root applies exactly one Chunk of origin delta');
  const currentOrigin = presentation.snapshot().currentOrigin;
  const originAudit = presentation.originTransformAuditSnapshot();
  const distantRoot = originAudit.roots.find(root => root.role === 'persistent-natural');
  assert.equal(originAudit.schemaVersion, 'w8-origin-transform-audit-1');
  assert.equal(originAudit.committedRenderOrigin.rebaseCount, 4);
  assert.equal(distantRoot.renderOriginRevision, 4);
  assert.equal(distantRoot.originAligned, true);
  assert.deepEqual(distantRoot.rootPosition, {
    x: buildLocalX - RENDER_CHUNK_SIZE,
    y: 0,
    z: 0,
  });
  assert.deepEqual(distantRoot.matrixWorldTranslation, distantRoot.rootPosition);

  assert.equal(presentation.commitRuntimeState({
    activeDataKeys: ['5,0'], renderedKeys: [],
    renderOrigin: { renderOriginChunkX: 3, renderOriginChunkZ: 0, rebaseCount: 3 },
    quality: 'medium', playerLogicalX: 56, playerLogicalZ: 8,
  }), false);
  assert.equal(presentation.canonicalAuditSnapshot()[0].visibleLod, 'near');
  assert.equal(generationRoot.position.x, buildLocalX - RENDER_CHUNK_SIZE);
  assert.deepEqual(presentation.snapshot().currentOrigin, currentOrigin);
  assert.equal(presentation.snapshot().staleRenderOriginRejectCount, 1);
  presentation.dispose();
});

test('Local terrain publishes only complete 25-Chunk coverage into one persistent root', async () => {
  const scene = new DistantTestGroup();
  const presentation = await createLocalTerrainTestPresentation(scene);
  const initial = localTerrainCoverageFixture(0, 0);
  const first = presentation.syncLocalTerrain({ coverageEpoch: 1, ...initial });
  assert.equal(first.committed, true);
  assert.equal(first.reused, false);
  const distantRoot = scene.children[0];
  assert.equal(distantRoot.children.length, 1);
  const firstRoot = distantRoot.children[0];
  const firstGeometries = firstRoot.children.map(child => child.geometry).filter(Boolean);
  const firstSnapshot = presentation.snapshot();
  assert.equal(firstSnapshot.localTerrainRootAttached, true);
  assert.equal(firstSnapshot.localTerrainActiveKeyCount, 25);
  assert.equal(firstSnapshot.localTerrainResolvedChunkCount, 25);
  assert.equal(firstSnapshot.localTerrainRenderedKeyCount, 9);
  assert.equal(firstSnapshot.localTerrainMidgroundOwnerCount, 16);
  assert.deepEqual(
    firstSnapshot.localTerrainMidgroundOwnerKeys,
    initial.activeDataKeys.filter(key => !initial.renderedKeys.includes(key)).sort(),
  );
  assert.equal(firstSnapshot.midgroundChunkCount, 16);
  assert.equal(firstSnapshot.clipmapMeshCount, 1);
  assert.equal(firstRoot.children.length, 2, 'Local terrain contains only midground terrain and clipmap');
  assert.equal(firstRoot.children.filter(child => child.name === 'w8-midground-outer-sixteen-terrain').length, 1);
  assert.equal(firstRoot.children.filter(child => child.name === 'w8-seeded-macro-terrain-clipmap').length, 1);

  const incomplete = localTerrainCoverageFixture(1, 0);
  const missingKey = incomplete.activeDataKeys[7];
  incomplete.chunks.delete(missingKey);
  const rejected = presentation.syncLocalTerrain({ coverageEpoch: 2, ...incomplete });
  assert.equal(rejected.committed, false);
  assert.equal(rejected.reason, 'missing-chunk-data');
  assert.deepEqual(rejected.missingOwnerKeys, [missingKey]);
  assert.equal(distantRoot.children.length, 1, 'no partial Local root is attached');
  assert.equal(distantRoot.children[0], firstRoot, 'the complete old root remains active');
  assert.ok(firstGeometries.every(geometry => geometry.disposed !== true));
  const rejectedSnapshot = presentation.snapshot();
  assert.deepEqual(rejectedSnapshot.localTerrainMissingOwnerKeys, [missingKey]);
  assert.equal(rejectedSnapshot.localTerrainCommitCount, 1);
  assert.equal(rejectedSnapshot.localTerrainRejectionCount, 1);

  const onlyTwentyFour = localTerrainCoverageFixture(1, 0);
  onlyTwentyFour.activeDataKeys = onlyTwentyFour.activeDataKeys.slice(0, 24);
  const shortRejected = presentation.syncLocalTerrain({ coverageEpoch: 2, ...onlyTwentyFour });
  assert.equal(shortRejected.committed, false);
  assert.equal(shortRejected.reason, 'active-key-count');
  assert.equal(distantRoot.children.length, 1);
  assert.equal(distantRoot.children[0], firstRoot);
  assert.ok(firstGeometries.every(geometry => geometry.disposed !== true));
  assert.equal(presentation.snapshot().localTerrainRejectionCount, 2);

  const second = presentation.syncLocalTerrain({ coverageEpoch: 3, ...localTerrainCoverageFixture(1, 0) });
  assert.equal(second.committed, true);
  assert.equal(second.reused, false);
  assert.equal(distantRoot.children.length, 1);
  assert.equal(distantRoot.children[0], firstRoot);
  assert.ok(firstGeometries.every(geometry => geometry.disposed !== true),
    'leaving Medium/Low buffers remain pooled for the next rolling transaction');
  const secondRoot = distantRoot.children[0];

  const stale = presentation.syncLocalTerrain({ coverageEpoch: 2, ...initial });
  assert.equal(stale.committed, false);
  assert.equal(stale.reason, 'stale-epoch');
  assert.equal(distantRoot.children[0], secondRoot);
  presentation.dispose();
  assert.ok(firstGeometries.every(geometry => geometry.disposed === true));
});

test('Terrain strip/ring generation stays detached until identity claim atomically updates the live root', async () => {
  const pendingYields = [];
  const events = [];
  const scene = new DistantTestGroup();
  const presentation = await createLocalTerrainTestPresentation(scene, {
    yieldToMainThread: () => new Promise(resolve => pendingYields.push(resolve)),
    diagnosticsEnabled: true,
    recordDiagnosticEvent(type, details) { events.push({ type, ...details }); },
  });
  const initial = localTerrainCoverageFixture(0, 0);
  assert.equal(presentation.syncLocalTerrain({ coverageEpoch: 1, ...initial }).committed, true);
  const distantRoot = scene.children[0];
  const oldRoot = distantRoot.children[0];
  const initialRollingCoverage = presentation.terrainPresentationCoverageForOwner(1, 0);
  assert.equal(initialRollingCoverage.complete, true);
  assert.equal(initialRollingCoverage.worldCoverageComplete, true);
  assert.equal(initialRollingCoverage.fallback, false,
    'a lagging but fully covered rolling surface is not a visual fallback layer');
  assert.equal(initialRollingCoverage.lagChunks, 1);
  assert.equal(initialRollingCoverage.withinCameraVisibleExtent, true,
    'the 52m clipmap-to-fog margin covers a one-Chunk presentation lag');
  assert.equal(presentation.terrainPresentationCoverageForOwner(4, 0)
    .worldCoverageComplete, false,
  'four stale Chunk centers exceed the clipmap-to-fog safety margin');
  const staleWorldCoverage = presentation.terrainPresentationCoverageForOwner(31, 0);
  assert.equal(staleWorldCoverage.complete, true,
    'an attached root remains structurally complete even when spatially obsolete');
  assert.equal(staleWorldCoverage.worldCoverageComplete, false);
  assert.equal(staleWorldCoverage.withinClipmapExtent, false);
  assert.equal(staleWorldCoverage.coverageDeficitMeters > 0, true);
  assert.ok(Number.isFinite(presentation.sampleTerrainFallbackHeightMeters(24, 8)));
  const next = localTerrainCoverageFixture(1, 0);
  const identity = '1,0|Current';
  let current = true;
  const pending = presentation.prepareTerrainPresentationGeneration({
    coverageEpoch: 2,
    presentationGenerationIdentity: identity,
    isPresentationGenerationCurrent: () => current,
    ...next,
  });
  await waitForControlledYield(pendingYields);
  const [prepared] = await drainControlledYields([pending], pendingYields, {
    whilePending() {
      assert.equal(distantRoot.children.length, 1);
      assert.equal(distantRoot.children[0], oldRoot,
        'a partial Terrain presentation generation must remain detached');
    },
  });
  assert.equal(prepared.prepared, true);
  assert.equal(prepared.committed, false);
  assert.equal(prepared.presentationGeneration.identity, identity);
  assert.ok(prepared.presentationGeneration.outerReadyAtMs
    <= prepared.presentationGeneration.clipmapReadyAtMs);
  assert.ok(prepared.presentationGeneration.clipmapReadyAtMs
    <= prepared.presentationGeneration.presentationReadyAtMs);
  assert.equal(distantRoot.children.length, 1);
  assert.equal(distantRoot.children[0], oldRoot);
  let snapshot = presentation.snapshot();
  assert.equal(snapshot.terrainPresentationGenerationStagedCount, 1);
  assert.equal(snapshot.terrainPresentationGenerationClaimCount, 0);
  assert.ok(snapshot.terrainPresentationGenerationStagedGeometryCount > 0);
  assert.ok(snapshot.terrainPresentationGenerationStagedUploadBytes > 0);

  const transitionContract = createRuntimeTransitionContract({
    generation: 2,
    centerChunkX: next.centerChunkX,
    centerChunkZ: next.centerChunkZ,
    renderedKeys: next.renderedKeys,
    activeDataKeys: next.activeDataKeys,
  });
  const claimed = presentation.claimTerrainPresentationGeneration({
    presentationGeneration: prepared.presentationGeneration,
    transitionContract,
    activeDataKeys: next.activeDataKeys,
    renderedKeys: next.renderedKeys,
    renderOrigin: { ...next.renderOrigin, rebaseCount: 1 },
    centerChunkX: next.centerChunkX,
    centerChunkZ: next.centerChunkZ,
  });
  assert.equal(claimed.claimed, true);
  assert.equal(distantRoot.children.length, 1);
  assert.equal(distantRoot.children[0], oldRoot,
    'claim publishes the complete entering strip/ring into the persistent logical Terrain root');
  assert.equal(oldRoot.parent, distantRoot);
  const claimedCoverage = presentation.terrainPresentationCoverageForOwner(1, 0);
  assert.equal(claimedCoverage.complete, true);
  assert.equal(claimedCoverage.worldCoverageComplete, true);
  assert.equal(claimedCoverage.fallback, false);
  assert.equal(claimedCoverage.lagChunks, 0);
  assert.equal(claimedCoverage.centerChunkX, 1);
  assert.equal(claimedCoverage.centerChunkZ, 0);
  assert.ok(Number.isFinite(claimedCoverage.generationAgeMs));
  snapshot = presentation.snapshot();
  assert.equal(snapshot.terrainPresentationGenerationStagedCount, 0);
  assert.equal(snapshot.terrainPresentationGenerationClaimCount, 1);
  assert.equal(snapshot.localTerrainCoverageCenter.chunkX, 1);
  assert.equal(snapshot.localTerrainMidgroundOwnerCount, 16);
  assert.equal(snapshot.clipmapMeshCount, 1);
  assert.equal(snapshot.terrainInitialRootPublicationCount, 1);
  assert.equal(snapshot.terrainStripRingPublicationCount, 1);
  assert.equal(snapshot.terrainPublicationScope, 'entering-owner-strip-and-low-ring');
  assert.equal(snapshot.terrainPresentationGenerationStalePublishCount, 0);
  assert.ok(events.findIndex(event => event.type === 'terrain-presentation-generation-ready')
    < events.findIndex(event => event.type === 'terrain-presentation-generation-claimed'));
  current = false;
  presentation.dispose();
});

test('superseded Terrain presentation staging cannot publish and dispose removes every staged resource', async () => {
  const pendingYields = [];
  const scene = new DistantTestGroup();
  const presentation = await createLocalTerrainTestPresentation(scene, {
    yieldToMainThread: () => new Promise(resolve => pendingYields.push(resolve)),
  });
  const initial = localTerrainCoverageFixture(0, 0);
  presentation.syncLocalTerrain({ coverageEpoch: 1, ...initial });
  const distantRoot = scene.children[0];
  const oldRoot = distantRoot.children[0];
  let current = true;
  const staleBuild = presentation.prepareTerrainPresentationGeneration({
    coverageEpoch: 2,
    presentationGenerationIdentity: '1,0|Current',
    isPresentationGenerationCurrent: () => current,
    ...localTerrainCoverageFixture(1, 0),
  });
  await waitForControlledYield(pendingYields);
  current = false;
  const [stale] = await drainControlledYields([staleBuild], pendingYields, {
    whilePending() {
      assert.equal(distantRoot.children.length, 1);
      assert.equal(distantRoot.children[0], oldRoot);
    },
  });
  assert.equal(stale.committed, false);
  assert.match(stale.reason, /stale-after-build|disposed-during-build/);
  assert.equal(distantRoot.children.length, 1);
  assert.equal(distantRoot.children[0], oldRoot);
  assert.equal(presentation.snapshot().terrainPresentationGenerationStagedCount, 0);

  const readyBuild = presentation.prepareTerrainPresentationGeneration({
    coverageEpoch: 3,
    presentationGenerationIdentity: '2,0|Current',
    isPresentationGenerationCurrent: () => true,
    ...localTerrainCoverageFixture(2, 0),
  });
  await waitForControlledYield(pendingYields);
  const [ready] = await drainControlledYields([readyBuild], pendingYields);
  assert.equal(ready.prepared, true);
  assert.equal(presentation.snapshot().terrainPresentationGenerationStagedCount, 1);
  presentation.dispose();
  assert.equal(scene.children.length, 0);
});

test('Terrain presentation staging is bounded to the Runtime corridor limit and reports resident resources', async () => {
  const scene = new DistantTestGroup();
  const presentation = await createLocalTerrainTestPresentation(scene);
  const initial = localTerrainCoverageFixture(0, 0);
  presentation.syncLocalTerrain({ coverageEpoch: 1, ...initial });
  const prepared = [];
  for (const centerChunkX of [1, 2, 3]) {
    prepared.push(await presentation.prepareTerrainPresentationGeneration({
      coverageEpoch: centerChunkX + 1,
      presentationGenerationIdentity: `${centerChunkX},0|Current`,
      isPresentationGenerationCurrent: () => true,
      ...localTerrainCoverageFixture(centerChunkX, 0),
    }));
  }
  let snapshot = presentation.snapshot();
  assert.equal(snapshot.terrainPresentationGenerationStagedCount, 3);
  assert.equal(snapshot.terrainPresentationGenerationMaximumStagedCount, 3);
  assert.equal(snapshot.terrainPresentationGenerationStagedGeometryCount, 6);
  assert.ok(snapshot.terrainPresentationGenerationStagedUploadBytes > 0);
  assert.ok(snapshot.terrainPresentationGenerationMaximumResidentGeometryCount >= 8);
  assert.ok(snapshot.terrainPresentationGenerationMaximumResidentUploadBytes
    >= snapshot.terrainPresentationGenerationStagedUploadBytes);
  const duplicate = await presentation.prepareTerrainPresentationGeneration({
    coverageEpoch: 99,
    presentationGenerationIdentity: '1,0|Current',
    isPresentationGenerationCurrent: () => true,
    ...localTerrainCoverageFixture(1, 0),
  });
  assert.equal(duplicate.reused, true);
  assert.equal(duplicate.presentationGeneration, prepared[0].presentationGeneration);
  const overCapacity = await presentation.prepareTerrainPresentationGeneration({
    coverageEpoch: 100,
    presentationGenerationIdentity: '4,0|Current',
    isPresentationGenerationCurrent: () => true,
    ...localTerrainCoverageFixture(4, 0),
  });
  assert.equal(overCapacity.committed, false);
  assert.equal(overCapacity.reason, 'presentation-staging-capacity');
  assert.equal(presentation.snapshot().terrainPresentationGenerationStagedCount, 3);

  const firstFixture = localTerrainCoverageFixture(1, 0);
  const transitionContract = createRuntimeTransitionContract({
    generation: 2,
    centerChunkX: 1,
    centerChunkZ: 0,
    renderedKeys: firstFixture.renderedKeys,
    activeDataKeys: firstFixture.activeDataKeys,
  });
  assert.equal(presentation.claimTerrainPresentationGeneration({
    presentationGeneration: prepared[0].presentationGeneration,
    transitionContract,
    activeDataKeys: firstFixture.activeDataKeys,
    renderedKeys: firstFixture.renderedKeys,
    renderOrigin: { ...firstFixture.renderOrigin, rebaseCount: 1 },
    centerChunkX: 1,
    centerChunkZ: 0,
  }).claimed, true);
  assert.equal(presentation.discardTerrainPresentationGeneration(
    prepared[1].presentationGeneration,
  ), true);
  assert.equal(presentation.discardTerrainPresentationGeneration(
    prepared[2].presentationGeneration,
  ), true);
  snapshot = presentation.snapshot();
  assert.equal(snapshot.terrainPresentationGenerationStagedCount, 0);
  assert.equal(snapshot.terrainPresentationGenerationClaimCount, 1);
  assert.equal(snapshot.terrainPresentationGenerationDiscardCount, 2);
  assert.equal(snapshot.terrainPresentationGenerationStalePublishCount, 0);
  presentation.dispose();
});

test('world-fixed clipmap reuses only newly exposed samples for straight and diagonal Chunk shifts', async t => {
  const straightAudit = auditW8ClipmapChunkShiftReuse({
    renderDistancePreset: 'current',
    deltaChunkX: 1,
    deltaChunkZ: 0,
  });
  const diagonalAudit = auditW8ClipmapChunkShiftReuse({
    renderDistancePreset: 'current',
    deltaChunkX: 1,
    deltaChunkZ: 1,
  });
  assert.deepEqual({
    samples: straightAudit.sampleCount,
    reused: straightAudit.reusedSampleCount,
    newlyExposed: straightAudit.newlyExposedSampleCount,
    indices: straightAudit.reusableIndexCount,
  }, { samples: 8_288, reused: 7_840, newlyExposed: 448, indices: 48_384 });
  assert.deepEqual({
    samples: diagonalAudit.sampleCount,
    reused: diagonalAudit.reusedSampleCount,
    newlyExposed: diagonalAudit.newlyExposedSampleCount,
    indices: diagonalAudit.reusableIndexCount,
  }, { samples: 8_288, reused: 7_424, newlyExposed: 864, indices: 48_384 });

  const scene = new DistantTestGroup();
  const presentation = await createLocalTerrainTestPresentation(scene);
  const initial = localTerrainCoverageFixture(0, 0);
  presentation.syncLocalTerrain({ coverageEpoch: 1, ...initial });
  const prepareAndClaim = async ({ centerChunkX, centerChunkZ, epoch, identity }) => {
    const fixture = localTerrainCoverageFixture(centerChunkX, centerChunkZ);
    const prepared = await presentation.prepareTerrainPresentationGeneration({
      coverageEpoch: epoch,
      presentationGenerationIdentity: identity,
      isPresentationGenerationCurrent: () => true,
      ...fixture,
    });
    assert.equal(prepared.prepared, true);
    const transitionContract = createRuntimeTransitionContract({
      generation: epoch,
      centerChunkX,
      centerChunkZ,
      renderedKeys: fixture.renderedKeys,
      activeDataKeys: fixture.activeDataKeys,
    });
    assert.equal(presentation.claimTerrainPresentationGeneration({
      presentationGeneration: prepared.presentationGeneration,
      transitionContract,
      activeDataKeys: fixture.activeDataKeys,
      renderedKeys: fixture.renderedKeys,
      renderOrigin: { ...fixture.renderOrigin, rebaseCount: epoch },
      centerChunkX,
      centerChunkZ,
    }).claimed, true);
    return Object.freeze({
      ...prepared.clipmapMetrics,
      rollingMetrics: prepared.rollingMetrics,
    });
  };
  const straight = await prepareAndClaim({
    centerChunkX: 1,
    centerChunkZ: 0,
    epoch: 2,
    identity: '1,0|Current',
  });
  const diagonal = await prepareAndClaim({
    centerChunkX: 2,
    centerChunkZ: 1,
    epoch: 3,
    identity: '2,1|Current',
  });
  assert.equal(straight.sampleCount, 8_288);
  assert.equal(straight.newlySampledCount <= 448, true);
  assert.equal(straight.reusedSampleCount >= 7_840, true);
  assert.equal(straight.reuseRatio >= straightAudit.reuseRatio, true);
  assert.equal(diagonal.newlySampledCount <= 864, true);
  assert.equal(diagonal.reusedSampleCount >= 7_424, true);
  assert.equal(diagonal.reuseRatio >= diagonalAudit.reuseRatio, true);
  assert.equal(diagonal.geometryAllocationCount, 0);
  assert.equal(diagonal.indexAllocationCount, 0);
  assert.equal(diagonal.sourceSlotReuseCount + diagonal.cacheReuseCount,
    diagonal.reusedSampleCount);
  assert.equal(diagonal.vertexComponentWriteCount, 8_288 * 4);
  assert.equal(straight.surfaceRefreshCount > 0, true,
    'the moving 5x5 seam is revalidated even when its macro sample is reused');
  const snapshot = presentation.snapshot();
  assert.equal(snapshot.clipmapSampleCacheSize <= 65_536, true);
  assert.equal(snapshot.clipmapGeometryPoolSize, 2);
  assert.equal(snapshot.clipmapGeometryPoolInUseCount, 1);
  assert.equal(snapshot.clipmapGeometryDisposeCount, 0);
  assert.equal(snapshot.maximumInnerBoundaryErrorMeters, 0);
  assert.equal(snapshot.maximumInnerBoundaryColorDifference, 0);
  const activeRoot = scene.children[0].children[0];
  const activeClipmap = activeRoot.children.find(child => (
    child.name === 'w8-seeded-macro-terrain-clipmap'
  ));
  assert.equal([...activeClipmap.geometry.attributes.position.values]
    .every(Number.isFinite), true);
  assert.equal([...activeClipmap.geometry.attributes.color.values]
    .every(Number.isFinite), true);
  const buildCountBeforeRebase = snapshot.clipmapBuildCount;
  const missesBeforeRebase = snapshot.clipmapSampleCacheMisses;
  const rootPositionBeforeRebase = { ...activeRoot.position };
  const rebasedFixture = localTerrainCoverageFixture(2, 1);
  const rebased = presentation.syncLocalTerrain({
    coverageEpoch: 4,
    ...rebasedFixture,
    renderOrigin: {
      renderOriginChunkX: 66,
      renderOriginChunkZ: -31,
      rebaseCount: 10,
    },
  });
  assert.equal(rebased.committed, true);
  assert.equal(rebased.reused, true);
  const afterRebase = presentation.snapshot();
  assert.equal(afterRebase.clipmapBuildCount, buildCountBeforeRebase);
  assert.equal(afterRebase.clipmapSampleCacheMisses, missesBeforeRebase);
  assert.notDeepEqual(activeRoot.position, rootPositionBeforeRebase);
  assert.equal(activeClipmap.position.x, 8 * RENDER_CHUNK_SIZE / LEGACY_CHUNK_SIZE_METERS);
  assert.equal(activeClipmap.position.y, 0);
  assert.equal(activeClipmap.position.z, 8 * RENDER_CHUNK_SIZE / LEGACY_CHUNK_SIZE_METERS);
  const reversal = await prepareAndClaim({
    centerChunkX: 1,
    centerChunkZ: 0,
    epoch: 5,
    identity: '1,0|Current:reversal',
  });
  assert.equal(reversal.newlySampledCount, 0);
  assert.equal(reversal.reusedSampleCount, 8_288);
  assert.equal(reversal.geometryAllocationCount, 0);
  assert.equal(reversal.indexAllocationCount, 0);
  assert.equal(reversal.bufferUploadBytes < diagonal.bufferUploadBytes, true,
    'reversal revalidates only the moving seam instead of uploading the full ring');
  assert.equal(reversal.updateRangeCount > 0, true);
  const teleport = await prepareAndClaim({
    centerChunkX: 100,
    centerChunkZ: -100,
    epoch: 6,
    identity: '100,-100|Current:teleport',
  });
  assert.equal(teleport.newlySampledCount > 8_000, true);
  assert.equal(teleport.reusedSampleCount < 288, true);
  assert.equal(teleport.geometryAllocationCount, 0);
  assert.equal(teleport.indexAllocationCount, 0);
  t.diagnostic(JSON.stringify({ straight, diagonal, reversal, teleport }));
  presentation.dispose();
});

test('r160 Terrain color buffers survive cold build, shifts, reversal, and pool recycle without Safety Ring', async t => {
  const r160Three = Object.freeze({
    ...DISTANT_TEST_THREE,
    Float32BufferAttribute: DistantTestR160Float32BufferAttribute,
  });
  const scene = new DistantTestGroup();
  const presentation = await createLocalTerrainTestPresentation(scene, { THREE: r160Three });
  t.after(() => presentation.dispose());

  const findNodes = (rootNode, name) => {
    const matches = [];
    const pending = [rootNode];
    while (pending.length > 0) {
      const node = pending.pop();
      if (node?.name === name) matches.push(node);
      pending.push(...(node?.children ?? []));
    }
    return matches;
  };
  const bufferStats = attribute => {
    const values = attribute?.array ?? attribute?.values ?? [];
    let minimum = Number.POSITIVE_INFINITY;
    let maximum = Number.NEGATIVE_INFINITY;
    let invalidCount = 0;
    let zeroCount = 0;
    let checksum = 0x811c9dc5;
    for (let index = 0; index < values.length; index += 3) {
      let zero = true;
      for (let component = 0; component < 3; component += 1) {
        const value = values[index + component];
        if (!Number.isFinite(value)) invalidCount += 1;
        else {
          minimum = Math.min(minimum, value);
          maximum = Math.max(maximum, value);
          if (value !== 0) zero = false;
        }
        checksum = Math.imul(
          checksum ^ (Number.isFinite(value) ? Math.round(value * 1_000_000) : 0x7fc00000),
          0x01000193,
        ) >>> 0;
      }
      if (zero) zeroCount += 1;
    }
    return Object.freeze({
      count: values.length / 3,
      min: minimum,
      max: maximum,
      invalidCount,
      zeroCount,
      nonZeroCount: values.length / 3 - zeroCount,
      checksum,
    });
  };
  const activeRegularClipmap = () => {
    const clipmaps = findNodes(scene, 'w8-seeded-macro-terrain-clipmap');
    assert.equal(clipmaps.length, 1, 'only the active complete clipmap is scene-attached');
    return clipmaps[0];
  };
  const clipmapAudit = label => {
    const mesh = activeRegularClipmap();
    const colorAttribute = mesh.geometry.attributes.color;
    return Object.freeze({
      label,
      mesh,
      geometry: mesh.geometry,
      position: bufferStats(mesh.geometry.attributes.position),
      color: bufferStats(colorAttribute),
      constructorInputColor: bufferStats({ array: colorAttribute.constructorInput }),
      attributeOwnsCopiedArray: colorAttribute.array !== colorAttribute.constructorInput,
      colorVersion: colorAttribute.version,
      colorUpdateRanges: [...colorAttribute.updateRanges],
      indexCount: mesh.geometry.index?.array?.length ?? mesh.geometry.index?.length ?? 0,
    });
  };
  const assertPopulated = audit => {
    assert.equal(audit.position.count, 8_288, `${audit.label} position count`);
    assert.equal(audit.position.invalidCount, 0, `${audit.label} invalid position`);
    assert.equal(audit.color.count, 8_288, `${audit.label} color count`);
    assert.equal(audit.color.invalidCount, 0, `${audit.label} invalid color`);
    assert.equal(audit.color.min > 0, true, `${audit.label} minimum color`);
    assert.equal(audit.color.max > audit.color.min, true, `${audit.label} color range`);
    assert.equal(audit.color.zeroCount, 0, `${audit.label} zero color vertices`);
    assert.equal(audit.indexCount, 48_384, `${audit.label} topology`);
  };
  const prepareAndClaim = async ({ centerChunkX, centerChunkZ, epoch, identity }) => {
    const fixture = localTerrainCoverageFixture(centerChunkX, centerChunkZ);
    const prepared = await presentation.prepareTerrainPresentationGeneration({
      coverageEpoch: epoch,
      presentationGenerationIdentity: identity,
      isPresentationGenerationCurrent: () => true,
      ...fixture,
    });
    assert.equal(prepared.prepared, true);
    const transitionContract = createRuntimeTransitionContract({
      generation: epoch,
      centerChunkX,
      centerChunkZ,
      renderedKeys: fixture.renderedKeys,
      activeDataKeys: fixture.activeDataKeys,
    });
    assert.equal(presentation.claimTerrainPresentationGeneration({
      presentationGeneration: prepared.presentationGeneration,
      transitionContract,
      activeDataKeys: fixture.activeDataKeys,
      renderedKeys: fixture.renderedKeys,
      renderOrigin: { ...fixture.renderOrigin, rebaseCount: epoch },
      centerChunkX,
      centerChunkZ,
    }).claimed, true);
    return Object.freeze({
      ...prepared.clipmapMetrics,
      rollingMetrics: prepared.rollingMetrics,
    });
  };

  const initial = localTerrainCoverageFixture(0, 0);
  assert.equal(presentation.syncLocalTerrain({ coverageEpoch: 1, ...initial }).committed, true);
  const cold = clipmapAudit('cold');
  t.diagnostic(JSON.stringify({
    coldConstructorInputColor: cold.constructorInputColor,
    coldPublishedAttributeColor: cold.color,
  }));
  assertPopulated(cold);
  assert.equal(cold.attributeOwnsCopiedArray, true, 'the fixture must reproduce r160 copying');
  assert.equal(cold.constructorInputColor.nonZeroCount, 0,
    'clipmap writes must target BufferAttribute.array, not the abandoned constructor input');
  assert.equal(cold.colorVersion, 0,
    'the first render uploads the populated attribute without a post-publication update');

  const straightMetrics = await prepareAndClaim({
    centerChunkX: 1,
    centerChunkZ: 0,
    epoch: 2,
    identity: 'r160:1,0:straight',
  });
  const straight = clipmapAudit('straight');
  assertPopulated(straight);
  assert.equal(straightMetrics.reusedSampleCount >= 7_840, true);
  assert.deepEqual({
    newOwners: straightMetrics.rollingMetrics.newOwnerCount,
    reusedOwners: straightMetrics.rollingMetrics.reusedOwnerCount,
    discardedOwners: straightMetrics.rollingMetrics.discardedOwnerCount,
    fullTerrainRebuild: straightMetrics.rollingMetrics.fullTerrainRebuild,
  }, {
    newOwners: 5,
    reusedOwners: 20,
    discardedOwners: 5,
    fullTerrainRebuild: false,
  });

  const diagonalMetrics = await prepareAndClaim({
    centerChunkX: 2,
    centerChunkZ: 1,
    epoch: 3,
    identity: 'r160:2,1:diagonal',
  });
  const diagonal = clipmapAudit('diagonal-pool-recycle');
  assertPopulated(diagonal);
  assert.equal(diagonalMetrics.reusedSampleCount >= 7_424, true);
  assert.deepEqual({
    newOwners: diagonalMetrics.rollingMetrics.newOwnerCount,
    reusedOwners: diagonalMetrics.rollingMetrics.reusedOwnerCount,
    discardedOwners: diagonalMetrics.rollingMetrics.discardedOwnerCount,
  }, { newOwners: 9, reusedOwners: 16, discardedOwners: 9 });
  assert.equal(diagonal.geometry, cold.geometry,
    'the cold resource is recycled for the diagonal generation');
  assert.equal(diagonal.colorVersion, 1);
  assert.equal(diagonal.colorUpdateRanges.length > 0, true,
    'a recycled published attribute must advertise its dirty color range');

  const reversalMetrics = await prepareAndClaim({
    centerChunkX: 1,
    centerChunkZ: 0,
    epoch: 4,
    identity: 'r160:1,0:reversal',
  });
  const reversal = clipmapAudit('reversal');
  assertPopulated(reversal);
  assert.equal(reversalMetrics.reusedSampleCount, 8_288);
  assert.equal(reversalMetrics.newlySampledCount, 0);
  assert.equal(reversal.geometry, straight.geometry,
    'the straight resource is recycled for the reversal generation');
  assert.equal(reversal.colorVersion, 1);
  assert.equal(reversal.colorUpdateRanges.length > 0, true);
  assert.equal(reversal.position.checksum, straight.position.checksum,
    'returning to the same center restores the identical height buffer');
  assert.equal(reversal.color.checksum, straight.color.checksum,
    'returning to the same center restores the identical color buffer');

  assert.equal(findNodes(scene, 'w8-player-following-terrain-safety-ring').length, 0,
    'Stage 3 removes the duplicate drawable Safety Ring');
  const publicationSnapshot = presentation.snapshot();
  assert.equal('safetyRingResourceCount' in publicationSnapshot, false);
  assert.equal(publicationSnapshot.terrainInitialRootPublicationCount, 1);
  assert.equal(publicationSnapshot.terrainStripRingPublicationCount, 3);
  assert.equal(publicationSnapshot.terrainPublicationScope,
    'entering-owner-strip-and-low-ring');
  assert.equal(publicationSnapshot.midgroundGeometryPoolSize, 2,
    'Medium Terrain uses the same bounded double-buffer pool as rolling Low Terrain');
  assert.equal(publicationSnapshot.midgroundGeometryPoolInUseCount, 1);
  assert.equal(publicationSnapshot.midgroundTotalGeometryAllocationCount, 2);
  assert.equal(publicationSnapshot.midgroundTotalGeometryReuseCount >= 2, true);

  t.diagnostic(JSON.stringify({
    cold: {
      position: cold.position,
      color: cold.color,
      constructorInputColor: cold.constructorInputColor,
    },
    straight: {
      position: straight.position,
      color: straight.color,
      colorVersion: straight.colorVersion,
      colorUpdateRanges: straight.colorUpdateRanges,
    },
    diagonalPoolRecycle: {
      position: diagonal.position,
      color: diagonal.color,
      colorVersion: diagonal.colorVersion,
      colorUpdateRanges: diagonal.colorUpdateRanges,
    },
    reversal: {
      position: reversal.position,
      color: reversal.color,
      colorVersion: reversal.colorVersion,
      colorUpdateRanges: reversal.colorUpdateRanges,
    },
  }));
});

test('continuous High/Medium/Low Terrain removes the Safety Ring without coverage regression', async t => {
  {
  const audit = auditW8ContinuousTerrainCoverage({
    centers: [
      { chunkX: 0, chunkZ: 0 },
      { chunkX: 1, chunkZ: 0 },
      { chunkX: 1, chunkZ: 1 },
      { chunkX: 0, chunkZ: 1 },
      { chunkX: 0, chunkZ: 0 },
    ],
  });
  assert.equal(audit.holeCount, 0);
  assert.equal(audit.unintendedOverlapCount, 0);
  assert.equal(audit.invalidColorCount, 0);
  assert.equal(audit.boundaryHeightMismatchMeters, 0);
  assert.equal(audit.staleGeometryCount, 0);
  assert.equal(audit.fullTerrainRebuildCount, 0);
  assert.ok(audit.transitions.every(transition => (
    transition.reusedOwnerSamples === 20
      && transition.newOwnerSamples === 5
      && transition.discardedOwnerSamples === 5
      && transition.reusedLowSamples >= 7_840
  )));
  const scene = new DistantTestGroup();
  const presentation = await createLocalTerrainTestPresentation(scene);
  t.after(() => presentation.dispose());
  const initial = localTerrainCoverageFixture(0, 0);
  assert.equal(presentation.syncLocalTerrain({ coverageEpoch: 1, ...initial }).committed, true);
  presentation.update(8, 8, initial.renderOrigin);
  const snapshot = presentation.snapshot();
  assert.equal(snapshot.continuousTerrainCoverageComplete, true);
  assert.equal(snapshot.continuousTerrainCoverageMiss, 0);
  assert.equal(snapshot.visibleTerrainHoleFrame, 0);
  assert.equal(Object.keys(snapshot).some(key => key.startsWith('safetyRing')), false);
  assert.equal(scene.children[0].children.some(child => (
    child.name === 'w8-player-following-terrain-safety-ring'
  )), false);
  }
});

test('logical Terrain bands share the canonical finalGround height and boundary contract', async t => {
  const contract = createW8LogicalTerrainContract('current');
  assert.equal(contract.heightSource, 'canonical-final-ground');
  assert.equal(contract.colorSource, 'canonical-surface-color');
  assert.equal(contract.sampleIdentity, 'world-fixed-xz');
  assert.equal(
    contract.boundaryOwnership,
    'inner-band-owns-boundary-vertex;outer-band-owns-next-cell',
  );
  assert.deepEqual(contract.bands.map(band => ({
    id: band.id,
    minimum: band.minimumChebyshevMeters,
    maximum: band.maximumChebyshevMeters,
  })), [
    { id: 'high', minimum: 0, maximum: 24 },
    { id: 'medium', minimum: 24, maximum: 40 },
    { id: 'low', minimum: 40, maximum: 352 },
  ]);
});

test('direct non-adjacent clipmap catch-up is faster than composing every intermediate generation', async t => {
  const run = async targets => {
    const presentation = await createLocalTerrainTestPresentation();
    presentation.syncLocalTerrain({
      coverageEpoch: 1,
      ...localTerrainCoverageFixture(0, 0),
    });
    const metrics = [];
    const startedAt = performance.now();
    for (let index = 0; index < targets.length; index += 1) {
      const target = targets[index];
      const fixture = localTerrainCoverageFixture(target.chunkX, target.chunkZ);
      const epoch = index + 2;
      const prepared = await presentation.prepareTerrainPresentationGeneration({
        coverageEpoch: epoch,
        presentationGenerationIdentity: `${target.chunkX},${target.chunkZ}|catchup-${index}`,
        isPresentationGenerationCurrent: () => true,
        ...fixture,
      });
      assert.equal(prepared.prepared, true);
      const transitionContract = createRuntimeTransitionContract({
        generation: epoch,
        centerChunkX: target.chunkX,
        centerChunkZ: target.chunkZ,
        renderedKeys: fixture.renderedKeys,
        activeDataKeys: fixture.activeDataKeys,
      });
      assert.equal(presentation.claimTerrainPresentationGeneration({
        presentationGeneration: prepared.presentationGeneration,
        transitionContract,
        activeDataKeys: fixture.activeDataKeys,
        renderedKeys: fixture.renderedKeys,
        renderOrigin: { ...fixture.renderOrigin, rebaseCount: epoch },
        centerChunkX: target.chunkX,
        centerChunkZ: target.chunkZ,
      }).claimed, true);
      metrics.push(prepared.clipmapMetrics);
    }
    const durationMs = performance.now() - startedAt;
    presentation.dispose();
    return Object.freeze({
      durationMs,
      generationCount: targets.length,
      newlySampledCount: metrics.reduce((sum, value) => sum + value.newlySampledCount, 0),
      minimumReuseRatio: Math.min(...metrics.map(value => value.reuseRatio)),
    });
  };
  const straightDirect = await run([{ chunkX: 2, chunkZ: 0 }]);
  const straightIncremental = await run([
    { chunkX: 1, chunkZ: 0 },
    { chunkX: 2, chunkZ: 0 },
  ]);
  const diagonalDirect = await run([{ chunkX: 2, chunkZ: 2 }]);
  const diagonalIncremental = await run([
    { chunkX: 1, chunkZ: 1 },
    { chunkX: 2, chunkZ: 2 },
  ]);
  for (const [direct, incremental] of [
    [straightDirect, straightIncremental],
    [diagonalDirect, diagonalIncremental],
  ]) {
    assert.equal(direct.generationCount, 1);
    assert.equal(incremental.generationCount, 2);
  }
  t.diagnostic(JSON.stringify({
    straight: { direct: straightDirect, incremental: straightIncremental },
    diagonal: { direct: diagonalDirect, incremental: diagonalIncremental },
    selected: 'direct-latest-target',
  }));
});

test('MAX Sprint 60-second clipmap throughput stays ahead of straight and diagonal arrivals', async t => {
  const percentile = (values, ratio) => [...values]
    .sort((left, right) => left - right)[Math.max(0, Math.ceil(values.length * ratio) - 1)];
  const run = async diagonal => {
    const presentation = await createLocalTerrainTestPresentation();
    presentation.syncLocalTerrain({
      coverageEpoch: 1,
      ...localTerrainCoverageFixture(0, 0),
    });
    const builds = [];
    for (let step = 1; step <= 20; step += 1) {
      const centerChunkX = step;
      const centerChunkZ = diagonal ? step : 0;
      const fixture = localTerrainCoverageFixture(centerChunkX, centerChunkZ);
      const startedAt = performance.now();
      const prepared = await presentation.prepareTerrainPresentationGeneration({
        coverageEpoch: step + 1,
        presentationGenerationIdentity: `${centerChunkX},${centerChunkZ}|Current`,
        isPresentationGenerationCurrent: () => true,
        ...fixture,
      });
      const totalDurationMs = performance.now() - startedAt;
      assert.equal(prepared.prepared, true);
      const transitionContract = createRuntimeTransitionContract({
        generation: step + 1,
        centerChunkX,
        centerChunkZ,
        renderedKeys: fixture.renderedKeys,
        activeDataKeys: fixture.activeDataKeys,
      });
      assert.equal(presentation.claimTerrainPresentationGeneration({
        presentationGeneration: prepared.presentationGeneration,
        transitionContract,
        activeDataKeys: fixture.activeDataKeys,
        renderedKeys: fixture.renderedKeys,
        renderOrigin: { ...fixture.renderOrigin, rebaseCount: step + 1 },
        centerChunkX,
        centerChunkZ,
      }).claimed, true);
      builds.push({
        ...prepared.clipmapMetrics,
        maximumSliceMs: prepared.maximumSliceMs,
        sliceCount: presentation.snapshot().localTerrainLastSliceCount,
        totalDurationMs,
      });
    }
    const clipmapDurations = builds.map(value => value.buildDurationMs);
    const totalDurations = builds.map(value => value.totalDurationMs);
    const result = {
      path: diagonal ? 'diagonal' : 'straight',
      clipmapP50Ms: percentile(clipmapDurations, 0.5),
      clipmapP95Ms: percentile(clipmapDurations, 0.95),
      clipmapMaxMs: Math.max(...clipmapDurations),
      totalP50Ms: percentile(totalDurations, 0.5),
      totalP95Ms: percentile(totalDurations, 0.95),
      totalMaxMs: Math.max(...totalDurations),
      sliceP95Ms: percentile(builds.map(value => value.maximumSliceMs ?? 0), 0.95),
      maximumSliceMs: Math.max(...builds.map(value => value.maximumSliceMs ?? 0)),
      sliceCountP95: percentile(builds.map(value => value.sliceCount), 0.95),
      newlySampledP95: percentile(builds.map(value => value.newlySampledCount), 0.95),
      reuseRatioMinimum: Math.min(...builds.map(value => value.reuseRatio)),
      geometryAllocations: builds.reduce(
        (sum, value) => sum + value.geometryAllocationCount,
        0,
      ),
      indexAllocations: builds.reduce((sum, value) => sum + value.indexAllocationCount, 0),
      uploadBytes: builds.reduce((sum, value) => sum + value.bufferUploadBytes, 0),
    };
    const arrivalIntervalMs = 334;
    const generationMs = result.totalP95Ms;
    let priorCompletionMs = 0;
    let fallbackArrivals = 0;
    let maximumLagChunks = 0;
    let latestLagChunks = 0;
    for (let center = 1; center <= 180; center += 1) {
      const requestAtMs = center <= 3 ? 0 : (center - 3) * arrivalIntervalMs;
      const completionAtMs = Math.max(priorCompletionMs, requestAtMs) + generationMs;
      const arrivalAtMs = center * arrivalIntervalMs;
      const lagChunks = Math.max(0, Math.ceil(
        (completionAtMs - arrivalAtMs) / arrivalIntervalMs,
      ));
      fallbackArrivals += Number(lagChunks > 0);
      maximumLagChunks = Math.max(maximumLagChunks, lagChunks);
      latestLagChunks = lagChunks;
      priorCompletionMs = completionAtMs;
    }
    result.sixtySecond = Object.freeze({
      arrivalCount: 180,
      latestGenerationLagChunks: latestLagChunks,
      maximumGenerationLagChunks: maximumLagChunks,
      fallbackArrivalCount: fallbackArrivals,
      presentationSwapCount: 180 - fallbackArrivals,
      movementBlockedByTerrain: 0,
    });
    const snapshot = presentation.snapshot();
    assert.equal(snapshot.clipmapGeometryPoolSize, 2);
    assert.equal(snapshot.clipmapGeometryPoolInUseCount, 1);
    presentation.dispose();
    return result;
  };
  const straight = await run(false);
  const diagonal = await run(true);
  t.diagnostic(JSON.stringify({ straight, diagonal }));
  for (const result of [straight, diagonal]) {
    assert.equal(result.clipmapP95Ms <= 150, true,
      `${result.path} incremental clipmap p95 ${result.clipmapP95Ms}ms`);
    assert.equal(result.totalP95Ms < 334, true,
      `${result.path} complete generation p95 must beat MAX arrival`);
    assert.equal(result.sliceP95Ms <= 4, true,
      `${result.path} incremental slice p95 ${result.sliceP95Ms}ms`);
    assert.equal(result.geometryAllocations <= 1, true);
    assert.equal(result.indexAllocations <= 1, true);
    assert.equal(result.sixtySecond.latestGenerationLagChunks <= 2, true);
    assert.equal(result.sixtySecond.maximumGenerationLagChunks <= 4, true);
    assert.equal(result.sixtySecond.presentationSwapCount > 0, true);
    assert.equal(result.sixtySecond.movementBlockedByTerrain, 0);
  }
});

test('normal Chunk-boundary Local Terrain compose is sliced and publishes strip/ring only after completion', async () => {
  const pendingYields = [];
  const scene = new DistantTestGroup();
  const presentation = await createLocalTerrainTestPresentation(scene, {
    yieldToMainThread: () => new Promise(resolve => pendingYields.push(resolve)),
  });
  const initial = localTerrainCoverageFixture(0, 0);
  assert.equal(presentation.syncLocalTerrain({ coverageEpoch: 1, ...initial }).committed, true);
  const distantRoot = scene.children[0];
  const oldRoot = distantRoot.children[0];
  const oldGeometries = oldRoot.children.map(child => child.geometry).filter(Boolean);
  const next = localTerrainCoverageFixture(1, 0);
  const retainedChunks = [...initial.chunks.entries()]
    .filter(([key]) => next.chunks.has(key))
    .map(([key, chunk]) => ({
      key,
      chunk,
      chunkId: chunk.chunkId,
      contentHash: chunk.contentHash,
    }));
  for (const retained of retainedChunks) next.chunks.set(retained.key, retained.chunk);

  const pending = presentation.syncLocalTerrainIncrementally({ coverageEpoch: 2, ...next });
  await waitForControlledYield(pendingYields);
  assert.equal(distantRoot.children.length, 1);
  assert.equal(distantRoot.children[0], oldRoot, 'the committed root remains visible during staging');
  assert.equal(presentation.snapshot().committedLocalTerrainEpoch, 1);
  for (let attempt = 0; attempt < 32
    && !presentation.snapshot().stagingLocalTerrainRootId; attempt += 1) {
    pendingYields.shift()();
    await waitForControlledYield(pendingYields);
    assert.equal(distantRoot.children.length, 1);
    assert.equal(distantRoot.children[0], oldRoot);
  }
  assert.match(presentation.snapshot().stagingLocalTerrainRootId, /coverage-epoch-2/);
  assert.ok(oldGeometries.every(geometry => geometry.disposed !== true));

  const [result] = await drainControlledYields([pending], pendingYields, {
    whilePending() {
      assert.equal(distantRoot.children.length, 1);
      assert.equal(distantRoot.children[0], oldRoot,
        'no partially composed Local root may be attached between slices');
      assert.equal(presentation.snapshot().committedLocalTerrainEpoch, 1);
    },
  });
  assert.equal(result.committed, true);
  assert.equal(distantRoot.children.length, 1);
  assert.equal(distantRoot.children[0], oldRoot,
    'the logical Terrain root persists while its complete Medium/Low buffers publish atomically');
  assert.ok(oldGeometries.every(geometry => geometry.disposed !== true),
    'leaving Medium/Low buffers remain in their bounded reuse pools');
  const snapshot = presentation.snapshot();
  assert.equal(snapshot.committedLocalTerrainEpoch, 2);
  assert.equal(snapshot.localTerrainLastSliceCount > 0, true);
  assert.equal(snapshot.presentationSliceBudgetMs, 8);
  assert.equal(snapshot.terrainPresentationStagingSliceBudgetMs, 1.5);
  assert.equal(snapshot.localTerrainLastMaximumSliceMs >= 0, true);
  assert.equal(snapshot.terrainInitialRootPublicationCount, 1);
  assert.equal(snapshot.terrainStripRingPublicationCount, 1);
  assert.equal(snapshot.midgroundGeometryPoolSize, 2);
  assert.equal(snapshot.clipmapGeometryPoolSize, 2);
  for (const retained of retainedChunks) {
    assert.equal(next.chunks.get(retained.key), retained.chunk);
    assert.equal(retained.chunk.chunkId, retained.chunkId);
    assert.equal(retained.chunk.contentHash, retained.contentHash);
  }

  const referenceScene = new DistantTestGroup();
  const reference = await createLocalTerrainTestPresentation(referenceScene);
  assert.equal(reference.syncLocalTerrain({ coverageEpoch: 1, ...next }).committed, true);
  assert.equal(
    snapshot.clipmapDeterministicChecksum,
    reference.snapshot().clipmapDeterministicChecksum,
  );
  assert.deepEqual(
    snapshot.localTerrainMidgroundOwnerKeys,
    reference.snapshot().localTerrainMidgroundOwnerKeys,
  );
  presentation.dispose();
  reference.dispose();
  assert.ok(oldGeometries.every(geometry => geometry.disposed === true));
});

test('the committed Local Terrain root hands owners off to the latest rendered ring while its replacement stages', async () => {
  const pendingYields = [];
  const scene = new DistantTestGroup();
  const presentation = await createLocalTerrainTestPresentation(scene, {
    yieldToMainThread: () => new Promise(resolve => pendingYields.push(resolve)),
  });
  const initial = localTerrainCoverageFixture(0, 0);
  const initialContract = createRuntimeTransitionContract({
    generation: 1,
    centerChunkX: initial.centerChunkX,
    centerChunkZ: initial.centerChunkZ,
    renderedKeys: initial.renderedKeys,
    activeDataKeys: initial.activeDataKeys,
  });
  assert.equal(presentation.syncLocalTerrain({
    coverageEpoch: 1,
    transitionContract: initialContract,
    ...initial,
  }).committed, true);
  assert.equal(presentation.commitRuntimeState({
    transitionContract: initialContract,
    activeDataKeys: initial.activeDataKeys,
    renderedKeys: initial.renderedKeys,
    renderOrigin: initial.renderOrigin,
  }), true);

  const distantRoot = scene.children[0];
  const committedRoot = distantRoot.children[0];
  const committedMidground = committedRoot.children.find(child => (
    child.name === 'w8-midground-outer-sixteen-terrain'
  ));
  const next = localTerrainCoverageFixture(1, 0);
  const nextContract = createRuntimeTransitionContract({
    generation: 2,
    centerChunkX: next.centerChunkX,
    centerChunkZ: next.centerChunkZ,
    renderedKeys: next.renderedKeys,
    activeDataKeys: next.activeDataKeys,
  });
  const pending = presentation.syncLocalTerrainIncrementally({
    coverageEpoch: 2,
    transitionContract: nextContract,
    ...next,
  });
  await waitForControlledYield(pendingYields);

  assert.equal(presentation.commitRuntimeState({
    transitionContract: nextContract,
    activeDataKeys: next.activeDataKeys,
    renderedKeys: next.renderedKeys,
    renderOrigin: next.renderOrigin,
  }), true);
  assert.equal(distantRoot.children[0], committedRoot,
    'the complete previous Local root remains attached during staging');
  const expectedVisibleOwners = initial.activeDataKeys
    .filter(key => !next.renderedKeys.includes(key))
    .sort();
  assert.deepEqual(
    [...committedMidground.userData.visibleOwnerKeys].sort(),
    expectedVisibleOwners,
    'the old root must hide owners now rendered by Near and reveal old Near owners now in midground',
  );
  assert.equal(
    committedMidground.geometry.index.length,
    committedMidground.userData.visibleOwnerIndexCount,
    'the owner handoff must update the rendered index buffer, not diagnostics alone',
  );
  assert.deepEqual(
    presentation.snapshot().localTerrainHandoffOwnerKeys,
    expectedVisibleOwners,
  );
  assert.equal(presentation.snapshot().localTerrainStoredOwnerCount, 25);
  assert.ok(initial.renderedKeys.some(key => expectedVisibleOwners.includes(key)),
    'the transition fixture includes old Near owners that need temporary midground coverage');
  assert.ok(initial.activeDataKeys.some(key => (
    !initial.renderedKeys.includes(key) && next.renderedKeys.includes(key)
  )), 'the transition fixture includes old midground owners that must stop overlapping Near');
  assert.ok(initial.activeDataKeys.filter(key => !next.activeDataKeys.includes(key))
    .every(key => expectedVisibleOwners.includes(key)),
  'old owners outside the new active ring remain until the old clipmap hole is replaced');

  const [result] = await drainControlledYields([pending], pendingYields);
  assert.equal(result.committed, true);
  const currentMidground = distantRoot.children[0].children.find(child => (
    child.name === 'w8-midground-outer-sixteen-terrain'
  ));
  assert.deepEqual(
    [...currentMidground.userData.visibleOwnerKeys].sort(),
    next.activeDataKeys.filter(key => !next.renderedKeys.includes(key)).sort(),
  );
  presentation.dispose();
});

test('runtime presentation handoff slices stop-reaccelerate and continuous crossings through one frame budget', async t => {
  const trees = Object.freeze(Array.from({ length: 96 }, (_, index) => Object.freeze({
    candidateId: `detail-v1:vegetation:runtime-handoff:${index}`,
    subtype: index % 3 === 0 ? 'conifer-tree' : 'broadleaf-tree',
    variationSeed: (index % 11) / 11,
    orientationSeed: (index % 13) / 13,
    worldPosition: Object.freeze({
      x: 80 + (index % 14),
      y: 0.4,
      z: 1 + (Math.floor(index / 14) % 14),
    }),
    owningChunkCoordinate: Object.freeze({ x: 5, z: 0 }),
    metadata: Object.freeze({ candidateRadiusMeters: 0.32 }),
  })));
  const bushes = Object.freeze(Array.from({ length: 32 }, (_, index) => Object.freeze({
    candidateId: `detail-v1:vegetation:runtime-handoff:bush:${index}`,
    subtype: 'shrub',
    variationSeed: (index % 7) / 7,
    orientationSeed: (index % 9) / 9,
    worldPosition: Object.freeze({ x: 80 + index % 14, y: 0.4, z: 2 + index % 12 }),
    owningChunkCoordinate: Object.freeze({ x: 5, z: 0 }),
    metadata: Object.freeze({ candidateRadiusMeters: 0.2 }),
  })));
  const rocks = Object.freeze(Array.from({ length: 32 }, (_, index) => Object.freeze({
    candidateId: `detail-v1:rock:runtime-handoff:${index}`,
    candidateType: 'rock',
    subtype: 'medium-rock',
    sizeClass: 'medium',
    variationSeed: (index % 7) / 7,
    orientationSeed: (index % 9) / 9,
    worldPosition: Object.freeze({ x: 80 + index % 14, y: 0.4, z: 3 + index % 12 }),
    owningChunkCoordinate: Object.freeze({ x: 5, z: 0 }),
    metadata: Object.freeze({ candidateRadiusMeters: 0.22 }),
  })));
  const grass = Object.freeze(Array.from({ length: 32 }, (_, index) => Object.freeze({
    stableId: `wf1:ambient-detail:runtime-handoff:grass:${index}`,
    detailType: 'grass',
    worldPosition: Object.freeze({ x: 80 + index % 14, y: 0.4, z: 4 + index % 12 }),
    rotationY: index / 8,
    variation: index % 3,
    owningChunkCoordinate: Object.freeze({ x: 5, z: 0 }),
  })));
  const naturalChunkFor = (chunkX, chunkZ) => {
    const suffix = `${chunkX}:${chunkZ}`;
    const translateCandidate = candidate => Object.freeze({
      ...candidate,
      candidateId: `${candidate.candidateId}:${suffix}`,
      worldPosition: Object.freeze({
        ...candidate.worldPosition,
        x: candidate.worldPosition.x + (chunkX - 5) * LEGACY_CHUNK_SIZE_METERS,
        z: candidate.worldPosition.z + chunkZ * LEGACY_CHUNK_SIZE_METERS,
      }),
      owningChunkCoordinate: Object.freeze({ x: chunkX, z: chunkZ }),
    });
    const translatedTrees = Object.freeze(trees.map(translateCandidate));
    const translatedBushes = Object.freeze(bushes.map(translateCandidate));
    const translatedRocks = Object.freeze(rocks.map(translateCandidate));
    const translatedGrass = Object.freeze(grass.map(candidate => Object.freeze({
      ...candidate,
      stableId: `${candidate.stableId}:${suffix}`,
      worldPosition: Object.freeze({
        ...candidate.worldPosition,
        x: candidate.worldPosition.x + (chunkX - 5) * LEGACY_CHUNK_SIZE_METERS,
        z: candidate.worldPosition.z + chunkZ * LEGACY_CHUNK_SIZE_METERS,
      }),
      owningChunkCoordinate: Object.freeze({ x: chunkX, z: chunkZ }),
    })));
    const chunk = canonicalChunk(chunkX, chunkZ, []);
    chunk.vegetationCandidates = Object.freeze([...translatedTrees, ...translatedBushes]);
    chunk.rockCandidates = translatedRocks;
    chunk.ambientDetails = translatedGrass;
    chunk.presentationLayers.natural = {
      vegetation: chunk.vegetationCandidates,
      rocks: translatedRocks,
    };
    chunk.presentationLayers.ambientDetails = translatedGrass;
    return chunk;
  };
  const naturalChunk = naturalChunkFor(5, 0);
  const scene = new DistantTestGroup();
  const presentation = await createLocalTerrainTestPresentation(scene, {
    incrementalStaticTreePages: true,
    yieldToMainThread: () => new Promise(resolve => setImmediate(resolve)),
  });
  const initial = localTerrainCoverageFixture(4, 0);
  for (const chunkX of [2, 3, 4, 5, 6]) {
    initial.chunks.set(`${chunkX},0`, naturalChunkFor(chunkX, 0));
  }
  assert.equal(presentation.syncLocalTerrain({ coverageEpoch: 1, ...initial }).committed, true);
  assert.equal(await presentation.sync({
    ...initial,
    quality: 'high',
    renderDistancePreset: 'current',
    playerLogicalX: 72,
    playerLogicalZ: 8,
  }), true);
  const queuedBaseline = presentation.snapshot();
  assert.equal(queuedBaseline.naturalVisibilityBaselinePending, true);
  assert.equal(queuedBaseline.naturalVisibilityBaselineComplete, false);
  assert.equal(queuedBaseline.naturalVisibilityBaselineStartedCount, 1);
  assert.equal(queuedBaseline.naturalVisibilityBaselineCompletedCount, 0);
  assert.equal(queuedBaseline.naturalVisibilityBaselineSynchronousScanCount, 0);
  assert.equal(queuedBaseline.naturalVisibilityQueueLength, 0,
    'Full ChunkData must not seed a Natural baseline scan');
  presentation.update(73, 8, initial.renderOrigin);
  const supersededBaseline = presentation.snapshot();
  assert.equal(supersededBaseline.naturalVisibilityBaselinePending, false);
  assert.equal(supersededBaseline.naturalVisibilitySupersededDiscardCount, 0,
    'exact player motion must not restart Natural visibility');
  assert.equal(supersededBaseline.naturalVisibilityStaleApplicationCount, 0);
  assert.equal(await presentation.sync({
    ...initial,
    quality: 'medium',
    renderDistancePreset: 'current',
    playerLogicalX: 72,
    playerLogicalZ: 8,
  }), true);
  const supersedingGeneration = presentation.snapshot();
  assert.equal(supersedingGeneration.naturalVisibilityBaselinePending, true);
  assert.equal(supersedingGeneration.naturalVisibilityRetainedGenerationPending, false,
    'an empty generation is not retained as a second attached coarse root');
  assert.equal(supersedingGeneration.naturalVisibilityBaselineStartedCount, 2);
  let baselineSliceCount = 1;
  for (let frame = 0; frame < 64
    && (presentation.snapshot().runtimePresentationHandoffPending
      || presentation.snapshot().naturalVisibilityBaselinePending
      || presentation.snapshot().naturalVisibilityRetainedGenerationPending); frame += 1) {
    presentation.update(72, 8, initial.renderOrigin);
    baselineSliceCount += 1;
  }
  assert.equal(presentation.markFirstDraw(), 0,
    'a manual call without a completed render receipt must not acknowledge draw');
  markCompletedRenderFrame(presentation, scene);
  const baseline = presentation.snapshot();
  assert.equal(baseline.runtimePresentationHandoffPending, false);
  assert.equal(baseline.naturalVisibilityBaselinePending, false);
  assert.equal(baseline.naturalVisibilityBaselineComplete, true);
  assert.equal(baseline.naturalVisibilityBaselineCompletedCount, 2);
  assert.equal(baseline.naturalVisibilityRetainedGenerationPending, false);
  assert.equal(baseline.naturalVisibilityRetainedGenerationReleaseCount, 0,
    'no retained empty root requires a replacement-barrier release');
  assert.equal(baseline.naturalVisibilityBaselineSynchronousScanCount, 0);
  assert.ok(baselineSliceCount > 1);
  assert.ok(baseline.naturalVisibilityMaximumSliceMs
    <= baseline.naturalVisibilityFrameBudgetMs + baseline.naturalVisibilityMaximumUnitMs + 0.1);
  assert.equal(baseline.staticNaturalActiveLegacyRecordCount, 0);
  assert.equal(baseline.queryNaturalOwnerChunkCount, 0);
  assert.equal(baseline.queryNaturalCandidateCount, 0);

  const reaccelerated = localTerrainCoverageFixture(3, 0);
  assert.equal(presentation.commitRuntimeState({
    activeDataKeys: reaccelerated.activeDataKeys,
    renderedKeys: reaccelerated.renderedKeys,
    renderOrigin: reaccelerated.renderOrigin,
    quality: 'high',
    playerLogicalX: 56,
    playerLogicalZ: 8,
  }), true);
  assert.equal(presentation.snapshot().runtimePresentationHandoffPending, true);
  const expectedImmediateVisibleOwners = initial.activeDataKeys
    .filter(key => !reaccelerated.renderedKeys.includes(key))
    .sort();
  assert.deepEqual(
    [...presentation.snapshot().localTerrainHandoffOwnerKeys].sort(),
    expectedImmediateVisibleOwners,
    'Near publication must update old Local Terrain coverage before the next render frame',
  );
  let accelerationFrames = 0;
  while (presentation.snapshot().runtimePresentationHandoffPending
    && accelerationFrames < 128) {
    presentation.update(56, 8, reaccelerated.renderOrigin);
    markCompletedRenderFrame(presentation, scene);
    accelerationFrames += 1;
  }
  const afterAcceleration = presentation.snapshot();
  assert.equal(afterAcceleration.runtimePresentationHandoffPending, false);
  assert.ok(accelerationFrames > 0, 'handoff must complete through the frame update path');
  assert.ok(afterAcceleration.runtimePresentationHandoffLocalTerrainCount
    > baseline.runtimePresentationHandoffLocalTerrainCount);
  assert.ok(afterAcceleration.runtimePresentationHandoffMaximumSliceMs
    < afterAcceleration.runtimePresentationFrameBudgetMs);
  assert.equal(afterAcceleration.staticNaturalActiveLegacyRecordCount, 0);
  assert.equal(afterAcceleration.staticNaturalOverlappingStableIdCount, 0);
  assert.equal(afterAcceleration.duplicateVisibleStableIdCount, 0);
  assert.ok(presentation.treePathAuditSnapshot()
    .filter(path => path.active)
    .every(path => path.firstDrawAtMs !== null));

  for (const centerChunkX of [2, 1, 0]) {
    const crossing = localTerrainCoverageFixture(centerChunkX, 0);
    assert.equal(presentation.commitRuntimeState({
      activeDataKeys: crossing.activeDataKeys,
      renderedKeys: crossing.renderedKeys,
      renderOrigin: crossing.renderOrigin,
      quality: 'high',
      playerLogicalX: centerChunkX * LEGACY_CHUNK_SIZE_METERS + 8,
      playerLogicalZ: 8,
    }), true);
    presentation.update(
      centerChunkX * LEGACY_CHUNK_SIZE_METERS + 8,
      8,
      crossing.renderOrigin,
    );
  }
  const finalCrossing = localTerrainCoverageFixture(0, 0);
  let crossingDrainFrames = 0;
  while (presentation.snapshot().runtimePresentationHandoffPending
    && crossingDrainFrames < 128) {
    presentation.update(8, 8, finalCrossing.renderOrigin);
    presentation.markFirstDraw();
    crossingDrainFrames += 1;
  }
  const crossed = presentation.snapshot();
  assert.equal(crossed.runtimePresentationHandoffPending, false);
  assert.ok(crossed.runtimePresentationHandoffSupersededCount >= 2);
  assert.equal(crossed.duplicateVisibleStableIdCount, 0);
  assert.ok(crossed.runtimePresentationHandoffMaximumSliceMs
    < crossed.runtimePresentationFrameBudgetMs);

  const replacement = localTerrainCoverageFixture(0, 0);
  replacement.chunks.set('5,0', naturalChunk);
  assert.equal(await presentation.sync({
    ...replacement,
    quality: 'high',
    renderDistancePreset: 'current',
    playerLogicalX: 8,
    playerLogicalZ: 8,
  }), true);
  let disposeFrames = 0;
  while ((presentation.snapshot().deferredGenerationDisposeCount > 0
      || presentation.snapshot().runtimePresentationHandoffPending
      || presentation.snapshot().distantPersistentPublicationPending)
    && disposeFrames < 128) {
    presentation.update(8, 8, replacement.renderOrigin);
    presentation.markFirstDraw();
    disposeFrames += 1;
  }
  const disposed = presentation.snapshot();
  assert.equal(disposed.deferredGenerationDisposeCount, 0);
  assert.equal(disposed.distantPersistentPublicationPending, false);
  assert.ok(disposed.distantPersistentPublicationCount > 0);
  assert.ok(disposed.distantPersistentRemovedMeshCount > 0);
  assert.equal(disposed.distantPersistentNewCanonicalMeshCount, 0);
  assert.equal(disposed.distantPersistentAdmissionLimitViolationCount, 0);
  assert.equal(disposed.distantPersistentOverBudgetUploadCount, 0);
  assert.ok(disposed.distantPersistentMaximumMeshAdmissionsPerFrame <= 1);
  assert.ok(disposed.distantPersistentMaximumUploadBytesPerFrame
    <= disposed.distantPersistentUploadBudgetBytes);
  assert.ok(disposed.runtimePresentationHandoffMaximumDisposePerFrame <= 1);
  assert.equal(disposed.duplicateVisibleStableIdCount, 0);
  t.diagnostic(JSON.stringify({
    stopReaccelerate: {
      frames: accelerationFrames,
      maximumSliceMs: afterAcceleration.runtimePresentationHandoffMaximumSliceMs,
      matrixUpdates: afterAcceleration.runtimePresentationHandoffMatrixUpdateCount
        - baseline.runtimePresentationHandoffMatrixUpdateCount,
      bufferUpdates: afterAcceleration.runtimePresentationHandoffBufferUpdateCount
        - baseline.runtimePresentationHandoffBufferUpdateCount,
      localTerrainHandoffs: afterAcceleration.runtimePresentationHandoffLocalTerrainCount
        - baseline.runtimePresentationHandoffLocalTerrainCount,
    },
    continuousCrossing: {
      drainFrames: crossingDrainFrames,
      superseded: crossed.runtimePresentationHandoffSupersededCount,
      duplicateStableIds: crossed.duplicateVisibleStableIdCount,
    },
    dispose: {
      frames: disposeFrames,
      resources: disposed.runtimePresentationHandoffDisposeCount,
      maximumPerFrame: disposed.runtimePresentationHandoffMaximumDisposePerFrame,
    },
    persistentDistant: {
      publications: disposed.distantPersistentPublicationCount,
      reusedMeshes: disposed.distantPersistentReusedMeshCount,
      newCanonicalMeshes: disposed.distantPersistentNewCanonicalMeshCount,
      newAuxiliaryMeshes: disposed.distantPersistentNewAuxiliaryMeshCount,
      matrixUpdates: disposed.distantPersistentMatrixUpdateCount,
      bufferUpdates: disposed.distantPersistentBufferUpdateCount,
      uploadBytesMaximumPerFrame: disposed.distantPersistentMaximumUploadBytesPerFrame,
      boundsRecalculations: disposed.distantPersistentBoundsRecalculationCount,
    },
  }));
  presentation.dispose();
});

test('Near to Distant coverage barrier publishes Building and Road sources before release', async t => {
  const road = Object.freeze({
    schemaVersion: 'w8-canonical-major-road-chunk-feature-1',
    stableId: 'major-road-v1:coverage-barrier:segment:0:chunk:5:0',
    sourceStableId: 'major-road-v1:coverage-barrier',
    sourceSegmentStableId: 'major-road-v1:coverage-barrier:segment:0',
    featureType: 'settlement-road',
    canonicalMajorRoad: true,
    settlementId: CANONICAL_SETTLEMENT_ID,
    settlementIds: Object.freeze([CANONICAL_SETTLEMENT_ID]),
    roadKind: 'MAJOR',
    widthMeters: 2.25,
    start: Object.freeze({ x: 84, y: 0, z: 8 }),
    end: Object.freeze({ x: 92, y: 0, z: 8 }),
    worldPosition: Object.freeze({ x: 88, y: 0, z: 8 }),
    owningChunkCoordinate: Object.freeze({ x: 5, z: 0 }),
  });
  const source = canonicalChunk(5, 0, [CANONICAL_BUILDING, road]);
  const handoffDescriptors = Object.freeze([
    Object.freeze({
      kind: 'building', stableId: CANONICAL_BUILDING_ID,
      sourceIdentity: CANONICAL_BUILDING_ID,
      projectionIdentity: CANONICAL_BUILDING_ID, ownerKey: '5,0',
    }),
    Object.freeze({
      kind: 'road', stableId: road.stableId,
      sourceIdentity: road.sourceStableId,
      projectionIdentity: road.stableId, ownerKey: '5,0',
    }),
  ]);
  const nearHold = createNearPresentationHoldHarness();
  nearHold.publishNear(handoffDescriptors);
  const presentation = await createLocalTerrainTestPresentation(new DistantTestGroup(), {
    incrementalStaticTreePages: true,
    getNearVisibleStableIds: nearHold.getNearVisibleStableIds,
    getNearPresentationHolds: nearHold.getNearPresentationHolds,
    releaseNearPresentationHolds: nearHold.releaseNearPresentationHolds,
    getCanonicalChunkData: async (chunkX, chunkZ) => (
      chunkX === 5 && chunkZ === 0 ? source : canonicalChunk(chunkX, chunkZ, [])
    ),
  });
  const coverage = centerChunkX => {
    const result = localTerrainCoverageFixture(centerChunkX, 0);
    if (result.chunks.has('5,0')) result.chunks.set('5,0', source);
    return result;
  };
  const near = coverage(4);
  assert.equal(await presentation.sync({
    ...near,
    quality: 'high',
    renderDistancePreset: 'current',
    playerLogicalX: 72,
    playerLogicalZ: 8,
  }), true);
  const before = presentation.canonicalAuditSnapshot();
  assert.equal(before.find(value => value.identity.stableId === CANONICAL_BUILDING_ID)
    .composedInstanceCount, 0);
  assert.equal(before.find(value => value.identity.stableId === road.stableId)
    .composedInstanceCount, 0);

  const distant = coverage(3);
  nearHold.hold('5,0', handoffDescriptors);
  assert.equal(presentation.commitRuntimeState({
    activeDataKeys: distant.activeDataKeys,
    renderedKeys: distant.renderedKeys,
    renderOrigin: distant.renderOrigin,
    quality: 'high',
    playerLogicalX: 56,
    playerLogicalZ: 8,
  }), true);
  const afterCommit = presentation.snapshot();
  const queuedAudit = presentation.canonicalAuditSnapshot();
  const queuedBuilding = queuedAudit.find(value => (
    value.identity.stableId === CANONICAL_BUILDING_ID
  ));
  const queuedRoad = queuedAudit.find(value => value.identity.stableId === road.stableId);
  assert.equal(queuedBuilding.composedInstanceCount, 0);
  assert.equal(queuedRoad.composedInstanceCount, 0);
  assert.deepEqual(nearHold.snapshot().heldOwnerKeys, ['5,0']);
  assert.deepEqual(nearHold.snapshot().nearStableIds,
    [CANONICAL_BUILDING_ID, road.stableId].sort());
  assert.equal(afterCommit.runtimePresentationCoverageBarrierPending, true);
  assert.equal(afterCommit.runtimePresentationCoverageBarrierReleasedCount, 0);
  assert.equal(afterCommit.runtimePresentationCoverageBarrierBlankFrameCount, 0);
  assert.equal(afterCommit.runtimePresentationCoverageBarrierDuplicateFrameCount, 0);
  let roadQueueFrames = 0;
  while (presentation.snapshot().runtimePresentationCoverageBarrierPending
    && roadQueueFrames < 64) {
    presentation.update(56, 8, distant.renderOrigin);
    presentation.markFirstDraw();
    const frameNear = new Set(nearHold.snapshot().nearStableIds);
    const frameAudit = presentation.canonicalAuditSnapshot();
    for (const stableId of [CANONICAL_BUILDING_ID, road.stableId]) {
      const distantCovered = (frameAudit.find(value => value.identity.stableId === stableId)
        ?.composedInstanceCount ?? 0) > 0;
      assert.equal(frameNear.has(stableId) || distantCovered, true,
        `Near or Distant coverage must remain visible for ${stableId}`);
    }
    roadQueueFrames += 1;
  }
  const afterRoadPublish = presentation.snapshot();
  const audit = presentation.canonicalAuditSnapshot();
  const building = audit.find(value => value.identity.stableId === CANONICAL_BUILDING_ID);
  const publishedRoad = audit.find(value => value.identity.stableId === road.stableId);
  assert.ok(building.composedInstanceCount > 0);
  assert.ok(publishedRoad.composedInstanceCount > 0);
  assert.deepEqual(nearHold.snapshot().nearStableIds, []);
  assert.deepEqual(nearHold.snapshot().heldOwnerKeys, []);
  assert.ok(roadQueueFrames > 1, 'Road coverage must remain held across multiple budget frames');
  assert.equal(afterRoadPublish.runtimePresentationCoverageBarrierPending, false);
  assert.equal(afterRoadPublish.runtimePresentationCoverageBarrierReleasedCount, 1);
  assert.equal(afterRoadPublish.runtimePresentationCoverageBarrierBlankFrameCount, 0);
  assert.equal(afterRoadPublish.runtimePresentationCoverageBarrierDuplicateFrameCount, 0);
  assert.deepEqual(afterRoadPublish.runtimePresentationCoverageBarrierLastRelease.ownerKeys, ['5,0']);
  assert.deepEqual(
    afterRoadPublish.runtimePresentationCoverageBarrierLastRelease.buildingSources
      .map(value => value.sourceIdentity),
    [CANONICAL_BUILDING_ID],
  );
  assert.deepEqual(
    afterRoadPublish.runtimePresentationCoverageBarrierLastRelease.roadSources.map(value => ({
      sourceIdentity: value.sourceIdentity,
      projectionIdentity: value.projectionIdentity,
    })),
    [{ sourceIdentity: road.sourceStableId, projectionIdentity: road.stableId }],
  );
  assert.equal(afterRoadPublish.runtimePresentationCoverageBarrierLastRelease.coverageGapMs, 0);
  assert.equal(afterRoadPublish.runtimePresentationCoverageBarrierLastRelease.blankFrames, 0);
  assert.equal(afterRoadPublish.runtimePresentationCoverageBarrierLastRelease.duplicateFrames, 0);
  assert.equal(afterRoadPublish.roadPresentationStalePublishCount, 0);
  assert.equal(afterRoadPublish.roadPresentationStarvationCount, 0);
  assert.equal(afterRoadPublish.roadPresentationOrphanGeometryCount, 0);
  assert.equal(afterRoadPublish.roadPresentationDoubleDisposeCount, 0);

  assert.equal(await presentation.sync({
    ...distant,
    quality: 'high',
    renderDistancePreset: 'current',
    playerLogicalX: 56,
    playerLogicalZ: 8,
  }), true);
  for (let frame = 0; frame < 128 && (
    presentation.snapshot().runtimePresentationHandoffPending
      || presentation.snapshot().distantPersistentPublicationPending
  ); frame += 1) {
    presentation.update(56, 8, distant.renderOrigin);
    presentation.markFirstDraw();
  }
  const completed = presentation.snapshot();
  assert.equal(completed.runtimePresentationHandoffPending, false);
  assert.equal(completed.distantPersistentPublicationPending, false);
  assert.equal(completed.runtimePresentationCoverageBarrierReleasedCount, 1);
  assert.equal(completed.runtimePresentationCoverageBarrierBlankFrameCount, 0);
  assert.equal(completed.runtimePresentationCoverageBarrierDuplicateFrameCount, 0);
  assert.equal(completed.duplicateVisibleStableIdCount, 0);

  nearHold.returnNear('5,0', handoffDescriptors);
  assert.equal(presentation.commitRuntimeState({
    activeDataKeys: near.activeDataKeys,
    renderedKeys: near.renderedKeys,
    renderOrigin: near.renderOrigin,
    quality: 'high',
    playerLogicalX: 72,
    playerLogicalZ: 8,
  }), true);
  assert.equal(await presentation.sync({
    ...near,
    quality: 'high',
    renderDistancePreset: 'current',
    playerLogicalX: 72,
    playerLogicalZ: 8,
  }), true);
  assert.equal(presentation.snapshot().distantPersistentPublicationPending, true);
  nearHold.hold('5,0', handoffDescriptors);
  assert.equal(presentation.commitRuntimeState({
    activeDataKeys: distant.activeDataKeys,
    renderedKeys: distant.renderedKeys,
    renderOrigin: distant.renderOrigin,
    quality: 'high',
    playerLogicalX: 56,
    playerLogicalZ: 8,
  }), true);
  assert.equal(presentation.snapshot().runtimePresentationCoverageBarrierPending, true,
    'the previous generation remains the release barrier while publication is pending');
  assert.equal(await presentation.sync({
    ...distant,
    quality: 'high',
    renderDistancePreset: 'current',
    playerLogicalX: 56,
    playerLogicalZ: 8,
  }), true);
  assert.equal(await presentation.sync({
    ...distant,
    quality: 'high',
    renderDistancePreset: 'current',
    playerLogicalX: 56,
    playerLogicalZ: 8,
  }), true);
  for (let frame = 0; frame < 256 && (
    presentation.snapshot().runtimePresentationHandoffPending
      || presentation.snapshot().distantPersistentPublicationPending
  ); frame += 1) {
    presentation.update(56, 8, distant.renderOrigin);
    presentation.markFirstDraw();
  }
  const superseded = presentation.snapshot();
  assert.equal(superseded.runtimePresentationHandoffPending, false);
  assert.equal(superseded.distantPersistentPublicationPending, false);
  assert.equal(superseded.runtimePresentationCoverageBarrierReleasedCount, 2);
  assert.equal(superseded.runtimePresentationCoverageBarrierBlankFrameCount, 0);
  assert.equal(superseded.runtimePresentationCoverageBarrierDuplicateFrameCount, 0);
  assert.equal(superseded.duplicateVisibleStableIdCount, 0);
  assert.ok(superseded.distantPersistentPublicationCount > 0);
  assert.ok(superseded.roadPresentationMaximumQueueLength > 0);
  assert.ok(superseded.roadPresentationMaximumWaitFrames <= 120);
  assert.ok(superseded.roadPresentationMaximumSliceMs
    <= superseded.roadPresentationFrameBudgetMs
      + superseded.roadPresentationMaximumUnitMs + 0.1);
  assert.equal(superseded.roadPresentationStalePublishCount, 0);
  assert.equal(superseded.roadPresentationStarvationCount, 0);
  assert.equal(superseded.roadPresentationOrphanGeometryCount, 0);
  assert.equal(superseded.roadPresentationDoubleDisposeCount, 0);
  t.diagnostic(JSON.stringify({
    coverage: superseded.runtimePresentationCoverageBarrierLastRelease,
    roadQueue: {
      budgetMs: superseded.roadPresentationFrameBudgetMs,
      maximumLength: superseded.roadPresentationMaximumQueueLength,
      maximumWaitFrames: superseded.roadPresentationMaximumWaitFrames,
      maximumSliceMs: superseded.roadPresentationMaximumSliceMs,
      maximumUnitMs: superseded.roadPresentationMaximumUnitMs,
      ownerWorkCount: superseded.roadPresentationOwnerWorkCount,
      bucketComposeCount: superseded.roadPresentationBucketComposeCount,
      recordComposeCount: superseded.roadPresentationRecordComposeCount,
      supersededDiscardCount: superseded.roadPresentationSupersededDiscardCount,
    },
  }));
  presentation.dispose();
  nearHold.dispose();
});

test('Building handoff keeps Near coverage when Distant publish fails and releases it on dispose', async () => {
  const source = canonicalChunk(5, 0, [CANONICAL_BUILDING]);
  const descriptor = Object.freeze({
    kind: 'building', stableId: CANONICAL_BUILDING_ID,
    sourceIdentity: CANONICAL_BUILDING_ID,
    projectionIdentity: CANONICAL_BUILDING_ID, ownerKey: '5,0',
  });
  const nearHold = createNearPresentationHoldHarness();
  nearHold.publishNear([descriptor]);
  let failCoveredRelease = true;
  const presentation = await createLocalTerrainTestPresentation(new DistantTestGroup(), {
    incrementalStaticTreePages: true,
    getNearVisibleStableIds: nearHold.getNearVisibleStableIds,
    getNearPresentationHolds: nearHold.getNearPresentationHolds,
    releaseNearPresentationHolds: request => {
      if (request.reason === 'distant-covered' && failCoveredRelease) {
        failCoveredRelease = false;
        throw new Error('forced Near release failure');
      }
      return nearHold.releaseNearPresentationHolds(request);
    },
    getCanonicalChunkData: async (chunkX, chunkZ) => (
      chunkX === 5 && chunkZ === 0 ? source : canonicalChunk(chunkX, chunkZ, [])
    ),
  });
  const coverage = centerChunkX => {
    const result = localTerrainCoverageFixture(centerChunkX, 0);
    if (result.chunks.has('5,0')) result.chunks.set('5,0', source);
    return result;
  };
  const near = coverage(4);
  const distant = coverage(3);
  assert.equal(await presentation.sync({
    ...near, quality: 'high', renderDistancePreset: 'current',
    playerLogicalX: 72, playerLogicalZ: 8,
  }), true);
  nearHold.hold('5,0', [descriptor]);
  assert.equal(presentation.commitRuntimeState({
    activeDataKeys: distant.activeDataKeys,
    renderedKeys: distant.renderedKeys,
    renderOrigin: distant.renderOrigin,
    quality: 'high', playerLogicalX: 56, playerLogicalZ: 8,
  }), true);
  let failure = null;
  for (let frame = 0; frame < 32 && failure === null; frame += 1) {
    try { presentation.update(56, 8, distant.renderOrigin); } catch (error) { failure = error; }
    const frameNear = new Set(nearHold.snapshot().nearStableIds);
    const distantCovered = (presentation.canonicalAuditSnapshot()
      .find(value => value.identity.stableId === CANONICAL_BUILDING_ID)
      ?.composedInstanceCount ?? 0) > 0;
    assert.equal(frameNear.has(CANONICAL_BUILDING_ID) || distantCovered, true);
  }
  assert.match(failure?.message ?? '', /forced Near release failure/);
  assert.deepEqual(nearHold.snapshot().heldOwnerKeys, ['5,0']);
  assert.equal(presentation.snapshot().runtimePresentationCoverageBarrierBlankFrameCount, 0);
  presentation.dispose();
  assert.deepEqual(nearHold.snapshot().heldOwnerKeys, []);
  assert.deepEqual(nearHold.snapshot().nearStableIds, []);
  nearHold.dispose();
});

test('Road presentation queue discards superseded owner work without stale publish or coverage gap', async t => {
  const roads = Object.freeze(Array.from({ length: 192 }, (_, index) => {
    const lane = index % 12;
    const row = Math.floor(index / 12);
    return Object.freeze({
      schemaVersion: 'w8-canonical-major-road-chunk-feature-1',
      stableId: `major-road-v1:queued-supersede:${index}:chunk:5:0`,
      sourceStableId: `major-road-v1:queued-supersede:${index}`,
      sourceSegmentStableId: `major-road-v1:queued-supersede:${index}:segment:0`,
      featureType: 'settlement-road',
      canonicalMajorRoad: true,
      settlementId: CANONICAL_SETTLEMENT_ID,
      settlementIds: Object.freeze([CANONICAL_SETTLEMENT_ID]),
      roadKind: 'MAJOR',
      routeId: `queued-route:${row}`,
      widthMeters: 1.75 + row * 0.1,
      start: Object.freeze({ x: 80 + lane, y: 0, z: 2 + row * 3 }),
      end: Object.freeze({ x: 84 + lane, y: 0, z: 2.5 + row * 3 }),
      worldPosition: Object.freeze({ x: 82 + lane, y: 0, z: 2.25 + row * 3 }),
      owningChunkCoordinate: Object.freeze({ x: 5, z: 0 }),
    });
  }));
  const source = canonicalChunk(5, 0, roads);
  const handoffDescriptors = Object.freeze(roads.map(road => Object.freeze({
    kind: 'road', stableId: road.stableId,
    sourceIdentity: road.sourceStableId,
    projectionIdentity: road.stableId, ownerKey: '5,0',
  })));
  const nearHold = createNearPresentationHoldHarness();
  nearHold.publishNear(handoffDescriptors);
  const presentation = await createLocalTerrainTestPresentation(new DistantTestGroup(), {
    incrementalStaticTreePages: true,
    getNearVisibleStableIds: nearHold.getNearVisibleStableIds,
    getNearPresentationHolds: nearHold.getNearPresentationHolds,
    releaseNearPresentationHolds: nearHold.releaseNearPresentationHolds,
    getCanonicalChunkData: async (chunkX, chunkZ) => (
      chunkX === 5 && chunkZ === 0 ? source : canonicalChunk(chunkX, chunkZ, [])
    ),
  });
  const coverage = centerChunkX => {
    const result = localTerrainCoverageFixture(centerChunkX, 0);
    if (result.chunks.has('5,0')) result.chunks.set('5,0', source);
    return result;
  };
  const near = coverage(4);
  const distant = coverage(3);
  assert.equal(await presentation.sync({
    ...near,
    quality: 'high',
    renderDistancePreset: 'current',
    playerLogicalX: 72,
    playerLogicalZ: 8,
  }), true);
  nearHold.hold('5,0', handoffDescriptors);
  assert.equal(presentation.commitRuntimeState({
    activeDataKeys: distant.activeDataKeys,
    renderedKeys: distant.renderedKeys,
    renderOrigin: distant.renderOrigin,
    quality: 'high',
    playerLogicalX: 56,
    playerLogicalZ: 8,
  }), true);
  let queuedFrames = 0;
  while (queuedFrames < 64) {
    presentation.update(56, 8, distant.renderOrigin);
    queuedFrames += 1;
    const frameNear = new Set(nearHold.snapshot().nearStableIds);
    const frameAudit = presentation.canonicalAuditSnapshot();
    for (const road of roads) {
      const distantCovered = (frameAudit.find(value => value.identity.stableId === road.stableId)
        ?.composedInstanceCount ?? 0) > 0;
      assert.equal(frameNear.has(road.stableId) || distantCovered, true,
        `queued Road must retain Near or publish Distant coverage: ${road.stableId}`);
    }
    const state = presentation.snapshot();
    if (state.roadPresentationOwnerWorkCount > 0
      && state.roadPresentationQueueLength > 0) break;
  }
  const queued = presentation.snapshot();
  assert.ok(queued.roadPresentationOwnerWorkCount > 0);
  assert.ok(queued.roadPresentationQueueLength > 0,
    'an over-budget owner unit must yield before Road publish');
  assert.equal(queued.runtimePresentationCoverageBarrierPending, true);

  nearHold.returnNear('5,0', handoffDescriptors);
  assert.equal(presentation.commitRuntimeState({
    activeDataKeys: near.activeDataKeys,
    renderedKeys: near.renderedKeys,
    renderOrigin: near.renderOrigin,
    quality: 'high',
    playerLogicalX: 72,
    playerLogicalZ: 8,
  }), true);
  const superseded = presentation.snapshot();
  assert.ok(superseded.roadPresentationSupersededDiscardCount > 0);
  for (let frame = 0; frame < 128
    && presentation.snapshot().runtimePresentationHandoffPending; frame += 1) {
    presentation.update(72, 8, near.renderOrigin);
    presentation.markFirstDraw();
  }
  const completed = presentation.snapshot();
  assert.equal(completed.runtimePresentationHandoffPending, false);
  assert.equal(completed.roadPresentationQueueLength, 0);
  assert.equal(completed.runtimePresentationCoverageBarrierBlankFrameCount, 0);
  assert.equal(completed.runtimePresentationCoverageBarrierDuplicateFrameCount, 0);
  assert.equal(completed.roadPresentationStalePublishCount, 0);
  assert.equal(completed.roadPresentationStarvationCount, 0);
  assert.equal(completed.roadPresentationOrphanGeometryCount, 0);
  assert.equal(completed.roadPresentationDoubleDisposeCount, 0);
  assert.equal(completed.duplicateVisibleStableIdCount, 0);
  assert.equal(completed.canonicalRoadRecordCount, roads.length);
  assert.equal(new Set(presentation.canonicalAuditSnapshot()
    .filter(value => value.identity.featureType === 'settlement-road')
    .map(value => value.identity.stableId)).size, roads.length);
  t.diagnostic(JSON.stringify({
    roadQueue: {
      budgetMs: completed.roadPresentationFrameBudgetMs,
      maximumLength: completed.roadPresentationMaximumQueueLength,
      maximumWaitFrames: completed.roadPresentationMaximumWaitFrames,
      maximumSliceMs: completed.roadPresentationMaximumSliceMs,
      maximumUnitMs: completed.roadPresentationMaximumUnitMs,
      ownerWorkCount: completed.roadPresentationOwnerWorkCount,
      bucketComposeCount: completed.roadPresentationBucketComposeCount,
      recordComposeCount: completed.roadPresentationRecordComposeCount,
      supersededDiscardCount: completed.roadPresentationSupersededDiscardCount,
    },
    coverage: {
      blankFrames: completed.runtimePresentationCoverageBarrierBlankFrameCount,
      duplicateFrames: completed.runtimePresentationCoverageBarrierDuplicateFrameCount,
    },
  }));
  presentation.dispose();
  nearHold.dispose();
});

test('persistent Distant reuses Settlement slots while Natural remains on Static Stream', async t => {
  const ownerX = 5;
  const ownerZ = 0;
  const bush = Object.freeze({
    candidateId: 'detail-v1:vegetation:persistent-distant:bush',
    subtype: 'shrub',
    variationSeed: 0.25,
    orientationSeed: 0.5,
    worldPosition: Object.freeze({ x: 88, y: 0.4, z: 10 }),
    owningChunkCoordinate: Object.freeze({ x: ownerX, z: ownerZ }),
    metadata: Object.freeze({ candidateRadiusMeters: 0.2 }),
  });
  const rock = Object.freeze({
    candidateId: 'detail-v1:rock:persistent-distant',
    candidateType: 'rock',
    subtype: 'medium-rock',
    sizeClass: 'medium',
    variationSeed: 0.4,
    orientationSeed: 0.6,
    worldPosition: Object.freeze({ x: 89, y: 0.4, z: 10 }),
    owningChunkCoordinate: Object.freeze({ x: ownerX, z: ownerZ }),
    metadata: Object.freeze({ candidateRadiusMeters: 0.22 }),
  });
  const grass = Object.freeze({
    stableId: 'wf1:ambient-detail:persistent-distant:grass',
    detailType: 'grass',
    worldPosition: Object.freeze({ x: 90, y: 0.4, z: 10 }),
    rotationY: 0.2,
    variation: 1,
    owningChunkCoordinate: Object.freeze({ x: ownerX, z: ownerZ }),
  });
  const source = canonicalChunk(ownerX, ownerZ, [CANONICAL_BUILDING]);
  source.vegetationCandidates = Object.freeze([bush]);
  source.rockCandidates = Object.freeze([rock]);
  source.ambientDetails = Object.freeze([grass]);
  source.presentationLayers.natural = {
    vegetation: source.vegetationCandidates,
    rocks: source.rockCandidates,
  };
  source.presentationLayers.ambientDetails = source.ambientDetails;
  const scene = new DistantTestGroup();
  const presentation = await createLocalTerrainTestPresentation(scene, {
    incrementalStaticTreePages: true,
    getCanonicalChunkData: async (chunkX, chunkZ) => (
      chunkX === ownerX && chunkZ === ownerZ
        ? source : canonicalChunk(chunkX, chunkZ, [])
    ),
    yieldToMainThread: () => new Promise(resolve => setImmediate(resolve)),
  });
  const coverage = centerChunkX => {
    const result = localTerrainCoverageFixture(centerChunkX, 0);
    if (result.chunks.has(`${ownerX},${ownerZ}`)) {
      result.chunks.set(`${ownerX},${ownerZ}`, source);
    }
    return result;
  };
  const initial = coverage(4);
  assert.equal(presentation.syncLocalTerrain({ coverageEpoch: 1, ...initial }).committed, true);
  assert.equal(await presentation.sync({
    ...initial,
    quality: 'high',
    renderDistancePreset: 'current',
    playerLogicalX: 72,
    playerLogicalZ: 8,
  }), true);
  presentation.markFirstDraw();
  const persistentRoot = scene.children[0].children.find(child => (
    /^w8-distant-presentation-epoch-/.test(child.name)
  ));
  const baseline = presentation.snapshot();
  assert.ok(persistentRoot);
  assert.equal(baseline.naturalLodMeshCount, 0);
  assert.equal(baseline.staticNaturalActiveLegacyRecordCount, 0);

  const updateDurations = [];
  const drain = (state, maximumFrames = 256) => {
    let frames = 0;
    while (presentation.snapshot().distantPersistentPublicationPending
      && frames < maximumFrames) {
      const startedAt = performance.now();
      presentation.update(
        state.centerChunkX * LEGACY_CHUNK_SIZE_METERS + 8,
        8,
        state.renderOrigin,
      );
      updateDurations.push(performance.now() - startedAt);
      presentation.markFirstDraw();
      frames += 1;
    }
    assert.equal(presentation.snapshot().distantPersistentPublicationPending, false);
    return frames;
  };

  const outer = coverage(3);
  assert.equal(presentation.commitRuntimeState({
    activeDataKeys: outer.activeDataKeys,
    renderedKeys: outer.renderedKeys,
    renderOrigin: outer.renderOrigin,
    quality: 'high',
    playerLogicalX: 56,
    playerLogicalZ: 8,
  }), true);
  assert.equal(await presentation.sync({
    ...outer,
    quality: 'high',
    renderDistancePreset: 'current',
    playerLogicalX: 56,
    playerLogicalZ: 8,
  }), true);
  const innerToOuterFrames = drain(outer);
  const afterOuter = presentation.snapshot();
  assert.equal(scene.children[0].children.includes(persistentRoot), true);
  assert.ok(afterOuter.distantPersistentReusedMeshCount > 0);
  assert.equal(afterOuter.distantPersistentNewCanonicalMeshCount, 0);

  for (let frame = 0; frame < 8; frame += 1) {
    const startedAt = performance.now();
    presentation.update(56, 8, outer.renderOrigin);
    updateDurations.push(performance.now() - startedAt);
    presentation.markFirstDraw();
  }
  const backInner = coverage(4);
  assert.equal(await presentation.sync({
    ...backInner,
    quality: 'high',
    renderDistancePreset: 'current',
    playerLogicalX: 72,
    playerLogicalZ: 8,
  }), true);
  const supersedingOuter = coverage(3);
  assert.equal(await presentation.sync({
    ...supersedingOuter,
    quality: 'high',
    renderDistancePreset: 'current',
    playerLogicalX: 56,
    playerLogicalZ: 8,
  }), true);
  const reaccelerateFrames = drain(supersedingOuter);
  const completed = presentation.snapshot();
  const audit = presentation.canonicalAuditSnapshot();
  const maximumUpdateMs = Math.max(...updateDurations);
  assert.equal(scene.children[0].children.includes(persistentRoot), true);
  assert.equal(completed.distantPersistentAdmissionLimitViolationCount, 0);
  assert.equal(completed.distantPersistentOverBudgetUploadCount, 0);
  assert.ok(completed.distantPersistentMaximumMeshAdmissionsPerFrame <= 1);
  assert.ok(completed.distantPersistentMaximumUploadBytesPerFrame
    <= completed.distantPersistentUploadBudgetBytes);
  assert.equal(completed.duplicateVisibleStableIdCount, 0);
  assert.equal(completed.staticNaturalActiveLegacyRecordCount, 0);
  assert.equal(completed.staticNaturalOverlappingStableIdCount, 0);
  assert.ok(completed.distantPersistentBoundsRecalculationCount > 0);
  assert.equal(new Set(audit.map(entry => entry.identity.stableId)).size, audit.length);
  assert.ok(audit.some(entry => entry.identity.stableId === CANONICAL_BUILDING_ID
    && entry.composedInstanceCount > 0));
  assert.ok(maximumUpdateMs < 50);
  t.diagnostic(JSON.stringify({
    innerToOuterFrames,
    stopFrames: 8,
    reaccelerateFrames,
    persistentRootReused: true,
    newCanonicalMeshes: completed.distantPersistentNewCanonicalMeshCount,
    newAuxiliaryMeshes: completed.distantPersistentNewAuxiliaryMeshCount,
    uploadBytesPerFrameMax: completed.distantPersistentMaximumUploadBytesPerFrame,
    uploadBudgetBytes: completed.distantPersistentUploadBudgetBytes,
    boundsRecalculations: completed.distantPersistentBoundsRecalculationCount,
    matrixUpdates: completed.distantPersistentMatrixUpdateCount,
    bufferUpdates: completed.distantPersistentBufferUpdateCount,
    maximumUpdateMs,
    duplicateStableIds: completed.duplicateVisibleStableIdCount,
  }));
  presentation.dispose();
});

test('revisited Near Building publication suppresses every persistent Distant part before render', async () => {
  const building = Object.freeze({
    ...CANONICAL_BUILDING,
    worldPosition: Object.freeze({ ...CANONICAL_BUILDING.worldPosition, y: 0 }),
  });
  const source = canonicalChunk(5, 0, [building]);
  const visualAssets = createDistantTestVisualAssets();
  const buildingParts = Object.freeze([
    CANONICAL_HOUSE_PART,
    Object.freeze({
      ...CANONICAL_HOUSE_PART,
      material: 'lotResidential',
      position: Object.freeze([0, 0.4, 0]),
      scale: Object.freeze([0.9, 0.8, 0.9]),
      materialRole: 'roof',
    }),
  ]);
  visualAssets.resolveBuildingParts = record => (
    record.buildingType === 'house' ? buildingParts : null
  );
  let nearVisibleStableIds = [];
  const scene = new DistantTestGroup();
  const presentation = await createLocalTerrainTestPresentation(scene, {
    incrementalStaticTreePages: true,
    visualAssets,
    getNearVisibleStableIds: () => nearVisibleStableIds,
    getCanonicalChunkData: async (chunkX, chunkZ) => (
      chunkX === 5 && chunkZ === 0 ? source : canonicalChunk(chunkX, chunkZ, [])
    ),
    yieldToMainThread: () => new Promise(resolve => setImmediate(resolve)),
  });
  const coverage = centerChunkX => {
    const result = localTerrainCoverageFixture(centerChunkX, 0);
    if (result.chunks.has('5,0')) result.chunks.set('5,0', source);
    return result;
  };
  const syncAndDrain = async (state, coverageEpoch) => {
    assert.equal(presentation.syncLocalTerrain({
      coverageEpoch,
      ...state,
    }).committed, true);
    assert.equal(await presentation.sync({
      ...state,
      quality: 'high',
      renderDistancePreset: 'current',
      playerLogicalX: state.centerChunkX * LEGACY_CHUNK_SIZE_METERS + 8,
      playerLogicalZ: 8,
    }), true);
    for (let frame = 0; frame < 128 && (
      presentation.snapshot().distantPersistentPublicationPending
        || presentation.snapshot().runtimePresentationHandoffPending
    ); frame += 1) {
      presentation.update(
        state.centerChunkX * LEGACY_CHUNK_SIZE_METERS + 8,
        8,
        state.renderOrigin,
      );
    }
    assert.equal(presentation.snapshot().distantPersistentPublicationPending, false);
    assert.equal(presentation.snapshot().runtimePresentationHandoffPending, false);
  };
  const visibleDistantParts = () => {
    const parts = [];
    const visit = node => {
      if (node?.matrices && node.userData?.canonicalStableIds) {
        node.userData.canonicalStableIds.forEach((stableId, slot) => {
          if (stableId === building.stableId) parts.push({ mesh: node, slot });
        });
      }
      for (const child of node?.children ?? []) visit(child);
    };
    visit(scene);
    return parts;
  };

  const initial = coverage(3);
  await syncAndDrain(initial, 1);
  assert.ok(visibleDistantParts().length >= 2, 'the outer Building uses multiple live buckets');

  const far = coverage(20);
  await syncAndDrain(far, 2);
  assert.equal(visibleDistantParts().length, 0, 'the far departure retires the city Building');

  const revisitedOuter = coverage(3);
  await syncAndDrain(revisitedOuter, 3);
  const revisitedParts = visibleDistantParts();
  assert.ok(revisitedParts.length >= 2, 'the Distant Building republishes on revisit');
  const wall = revisitedParts.find(({ mesh }) => mesh.name.includes('houseWall'));
  assert.ok(wall);
  const wallMatrix = wall.mesh.matrices[wall.slot].value;
  assert.equal(building.worldPosition.y, 0);
  assert.equal(
    wallMatrix.position.y - wallMatrix.scale.y / 2,
    0,
    'canonical Y, matrix base Y, and the flat current Terrain height agree',
  );
  const slotAudit = presentation.originTransformAuditSnapshot();
  assert.equal(slotAudit.buildingSlotCount >= 2, true);
  assert.equal(slotAudit.buildingSlots.every(slot => (
    slot.stableId === building.stableId
      && Number.isSafeInteger(slot.slotIndex)
      && slot.materialBucket.includes('building')
      && Object.hasOwn(slot, 'matrixUploadRevision')
      && Object.hasOwn(slot, 'handoffOpacityUploadRevision')
  )), true, 'reused Building slots expose identity, material bucket, and upload revisions');

  const revisitedNear = coverage(4);
  assert.equal(presentation.syncLocalTerrain({
    coverageEpoch: 4,
    ...revisitedNear,
  }).committed, true);
  nearVisibleStableIds = [building.stableId];
  assert.equal(presentation.commitRuntimeState({
    activeDataKeys: revisitedNear.activeDataKeys,
    renderedKeys: revisitedNear.renderedKeys,
    renderOrigin: revisitedNear.renderOrigin,
    quality: 'high',
    playerLogicalX: 72,
    playerLogicalZ: 8,
  }), true);
  assert.equal(
    visibleDistantParts().length,
    0,
    'draw-ready Near publication must suppress every old Distant part synchronously',
  );
  presentation.dispose();
});

test('continuous Local Terrain boundaries discard stale builds and shutdown blocks late publication', async () => {
  const pendingYields = [];
  const scene = new DistantTestGroup();
  const presentation = await createLocalTerrainTestPresentation(scene, {
    yieldToMainThread: () => new Promise(resolve => pendingYields.push(resolve)),
  });
  const initial = localTerrainCoverageFixture(0, 0);
  presentation.syncLocalTerrain({ coverageEpoch: 1, ...initial });
  const distantRoot = scene.children[0];
  const committedRoot = distantRoot.children[0];
  const first = presentation.syncLocalTerrainIncrementally({
    coverageEpoch: 2,
    ...localTerrainCoverageFixture(1, 0),
  });
  await waitForControlledYield(pendingYields);
  const latest = presentation.syncLocalTerrainIncrementally({
    coverageEpoch: 3,
    ...localTerrainCoverageFixture(2, 0),
  });
  const [firstResult, latestResult] = await drainControlledYields(
    [first, latest],
    pendingYields,
    {
      whilePending() {
        assert.equal(distantRoot.children.length, 1);
        assert.equal(distantRoot.children[0], committedRoot,
          'continuous boundaries retain the last complete Local root');
      },
    },
  );
  assert.equal(firstResult.committed, false);
  assert.equal(firstResult.reason, 'stale-after-build');
  assert.equal(latestResult.committed, true);
  assert.equal(distantRoot.children.length, 1);
  assert.equal(distantRoot.children[0], committedRoot);
  assert.equal(distantRoot.children[0].userData.coverageEpoch, 3);
  assert.equal(presentation.snapshot().committedLocalTerrainEpoch, 3);

  const shutdownBuild = presentation.syncLocalTerrainIncrementally({
    coverageEpoch: 4,
    ...localTerrainCoverageFixture(3, 0),
  });
  await waitForControlledYield(pendingYields);
  presentation.dispose();
  while (pendingYields.length) pendingYields.shift()();
  const shutdownResult = await shutdownBuild;
  assert.equal(shutdownResult.committed, false);
  assert.equal(shutdownResult.reason, 'disposed-during-build');
  assert.equal(scene.children.length, 0);
});

test('an older transition contract cannot roll back Local Terrain coverage or poison its epoch', async () => {
  const scene = new DistantTestGroup();
  const presentation = await createLocalTerrainTestPresentation(scene);
  const fixture = localTerrainCoverageFixture(0, 0);
  const contract = generation => createRuntimeTransitionContract({
    generation,
    centerChunkX: fixture.centerChunkX,
    centerChunkZ: fixture.centerChunkZ,
    renderedKeys: fixture.renderedKeys,
    activeDataKeys: fixture.activeDataKeys,
  });
  const currentContract = contract(2);
  const current = await presentation.syncLocalTerrainIncrementally({
    ...fixture,
    coverageEpoch: 2,
    transitionContract: currentContract,
  });
  assert.equal(current.committed, true);
  const currentRoot = scene.children[0].children.find(child => (
    child.name === current.activeRootId
  ));

  const stale = await presentation.syncLocalTerrainIncrementally({
    ...fixture,
    coverageEpoch: 999,
    transitionContract: contract(1),
  });
  assert.equal(stale.committed, false);
  assert.equal(stale.reason, 'stale-transition');
  assert.equal(scene.children[0].children.includes(currentRoot), true,
    'an older transition must leave the complete current root attached');
  assert.equal(presentation.snapshot().runtimeTransitionGeneration, 2);

  const reused = await presentation.syncLocalTerrainIncrementally({
    ...fixture,
    coverageEpoch: 3,
    transitionContract: currentContract,
  });
  assert.equal(reused.committed, true,
    'the rejected old transition must not advance the independent Local coverage epoch');
  assert.equal(presentation.snapshot().localTerrainTransitionGeneration, 2);
  assert.equal(presentation.snapshot().localTerrainCoverageSignature,
    currentContract.coverageSignature);
  presentation.dispose();
});

test('Local Terrain diagnostics prove complete strip/ring readiness precedes atomic publication', async () => {
  const scene = new DistantTestGroup();
  const events = [];
  const presentation = await createLocalTerrainTestPresentation(scene, {
    diagnosticsEnabled: true,
    recordDiagnosticEvent(type, details) {
      events.push({ type, ...details });
    },
  });
  assert.equal((await presentation.syncLocalTerrainIncrementally({
    coverageEpoch: 1,
    ...localTerrainCoverageFixture(0, 0),
  })).committed, true);
  events.length = 0;
  assert.equal((await presentation.syncLocalTerrainIncrementally({
    coverageEpoch: 2,
    ...localTerrainCoverageFixture(1, 0),
  })).committed, true);
  const ordered = events.map(event => event.type);
  assert.ok(ordered.indexOf('terrain-replacement-ready')
    < ordered.indexOf('terrain-replacement-attached'));
  assert.ok(ordered.indexOf('terrain-replacement-attached')
    < ordered.indexOf('terrain-old-released'));
  const ready = events.find(event => event.type === 'terrain-replacement-ready');
  const attached = events.find(event => event.type === 'terrain-replacement-attached');
  const released = events.find(event => event.type === 'terrain-old-released');
  assert.equal(ready.rootAttached, false);
  assert.equal(ready.oldRootAttached, true);
  assert.equal(attached.rootAttached, true);
  assert.equal(attached.oldRootAttached, false,
    'the detached staging shell is retired after its buffers publish into the live root');
  assert.equal(released.newRootAttached, true);
  assert.equal(released.oldRootAttached, false);
  const roots = presentation.visibleRootRevisionSnapshot();
  assert.equal(roots.find(root => root.role === 'local-terrain').coverageEpoch, 2);
  assert.equal(roots.find(root => root.role === 'local-terrain').attached, true);
  presentation.dispose();
});

test('Render Distance updates the complete Terrain ring without changing Local coverage', async () => {
  const scene = new DistantTestGroup();
  const presentation = await createLocalTerrainTestPresentation(scene);
  const coverage = localTerrainCoverageFixture(0, 0);
  assert.equal(presentation.syncLocalTerrain({
    coverageEpoch: 1,
    renderDistancePreset: 'current',
    ...coverage,
  }).committed, true);
  const distantRoot = scene.children[0];
  const currentRoot = distantRoot.children[0];
  const currentGeometries = currentRoot.children.map(child => child.geometry).filter(Boolean);
  assert.equal(presentation.snapshot().clipmapExtentMeters, 352);

  const switched = presentation.syncLocalTerrain({
    coverageEpoch: 2,
    renderDistancePreset: 'short',
    ...coverage,
  });
  assert.equal(switched.committed, true);
  assert.equal(switched.reused, false);
  assert.equal(distantRoot.children.length, 1);
  assert.equal(distantRoot.children[0], currentRoot,
    'preset changes retain the logical Terrain root and publish a complete replacement Low ring');
  const switchedGeometries = distantRoot.children[0].children
    .map(child => child.geometry).filter(Boolean);
  assert.equal(currentGeometries.filter(geometry => switchedGeometries.includes(geometry)).length, 1,
    'the preset-only swap reuses the unchanged 16-Chunk midground geometry');
  const retainedCurrentClipmap = currentGeometries.find(geometry => (
    !switchedGeometries.includes(geometry)
  ));
  assert.notEqual(retainedCurrentClipmap.disposed, true,
    'preset topology remains pooled for a deterministic switch back');
  assert.equal(presentation.snapshot().clipmapExtentMeters, 192);
  assert.equal(presentation.snapshot().renderDistancePreset, 'short');
  assert.equal(presentation.snapshot().localTerrainActiveKeyCount, 25);
  assert.equal(presentation.snapshot().localTerrainRenderedKeyCount, 9);
  assert.equal(presentation.snapshot().localTerrainMidgroundOwnerCount, 16);
  presentation.dispose();
  assert.equal(retainedCurrentClipmap.disposed, true);
});

test('a superseded incremental Terrain preset build cannot publish its stale root', async () => {
  let releaseSlice;
  let signalSlice;
  const sliceStarted = new Promise(resolve => { signalSlice = resolve; });
  const scene = new DistantTestGroup();
  const presentation = await createLocalTerrainTestPresentation(scene, {
    yieldToMainThread: () => new Promise(resolve => {
      releaseSlice = resolve;
      signalSlice();
    }),
  });
  const coverage = localTerrainCoverageFixture(0, 0);
  assert.equal(presentation.syncLocalTerrain({
    coverageEpoch: 1,
    renderDistancePreset: 'current',
    ...coverage,
  }).committed, true);
  const committedRoot = scene.children[0].children[0];
  const stalePreset = presentation.syncLocalTerrainPreset({
    coverageEpoch: 2,
    renderDistancePreset: 'short',
    ...coverage,
  });
  await sliceStarted;
  assert.equal(scene.children[0].children[0], committedRoot);
  assert.ok(presentation.invalidatePendingLocalTerrainSync() >= 3);
  releaseSlice();
  const staleResult = await stalePreset;
  assert.equal(staleResult.committed, false);
  assert.equal(staleResult.reason, 'stale-after-build');
  assert.equal(scene.children[0].children.length, 1);
  assert.equal(scene.children[0].children[0], committedRoot);
  assert.equal(presentation.snapshot().renderDistancePreset, 'current');
  assert.ok(presentation.snapshot().localTerrainStaleDiscardCount >= 1);
  presentation.dispose();
});

test('Local terrain remains current while Far owner generation is unresolved', async () => {
  let releaseOwner;
  const heldOwner = new Promise(resolve => { releaseOwner = resolve; });
  let signalOwner;
  const ownerStarted = new Promise(resolve => { signalOwner = resolve; });
  let firstOwner = true;
  const scene = new DistantTestGroup();
  const presentation = await createLocalTerrainTestPresentation(scene, {
    findSettlementsNear: async () => [CANONICAL_CANDIDATE],
    resolveTemplate: async () => CANONICAL_TEMPLATE,
    getCanonicalChunkData: async (chunkX, chunkZ) => {
      if (firstOwner) {
        firstOwner = false;
        signalOwner();
        await heldOwner;
      }
      return canonicalChunk(chunkX, chunkZ, []);
    },
  });
  const initial = localTerrainCoverageFixture(0, 0);
  assert.equal(presentation.syncLocalTerrain({ coverageEpoch: 1, ...initial }).committed, true);
  const pendingFar = presentation.sync({ ...initial, quality: 'high' });
  await ownerStarted;
  const next = localTerrainCoverageFixture(1, 0);
  const localCommit = presentation.syncLocalTerrain({ coverageEpoch: 2, ...next });
  assert.equal(localCommit.committed, true);
  const whilePending = presentation.snapshot();
  assert.equal(whilePending.farSyncPending, true);
  assert.deepEqual(whilePending.localTerrainCoverageCenter, { chunkX: 1, chunkZ: 0 });
  assert.equal(whilePending.committedLocalTerrainEpoch, 2);
  assert.equal(whilePending.midgroundChunkCount, 16);
  assert.equal(whilePending.clipmapMeshCount, 1);
  releaseOwner();
  assert.equal(await pendingFar, true);
  assert.equal(presentation.snapshot().farSyncPending, false);
  presentation.dispose();
});

test('Local terrain build failure never replaces or disposes the complete old root', async () => {
  const scene = new DistantTestGroup();
  const presentation = await createLocalTerrainTestPresentation(scene);
  const initial = localTerrainCoverageFixture(0, 0);
  presentation.syncLocalTerrain({ coverageEpoch: 1, ...initial });
  const distantRoot = scene.children[0];
  const oldRoot = distantRoot.children[0];
  const oldGeometries = oldRoot.children.map(child => child.geometry).filter(Boolean);
  const broken = localTerrainCoverageFixture(1, 0);
  const brokenKey = broken.activeDataKeys.find(key => !broken.renderedKeys.includes(key));
  broken.chunks.get(brokenKey).terrain.materialWeights = null;
  assert.throws(
    () => presentation.syncLocalTerrain({ coverageEpoch: 2, ...broken }),
    TypeError,
  );
  assert.equal(distantRoot.children.length, 1);
  assert.equal(distantRoot.children[0], oldRoot);
  assert.ok(oldGeometries.every(geometry => geometry.disposed !== true));
  assert.equal(presentation.snapshot().localTerrainLastRejectionReason, 'build-error');
  presentation.dispose();
});

test('canonical natural LOD moves cross-fade distance on the GPU without bucket rewrites', async () => {
  const candidates = Object.freeze([
    Object.freeze({
      candidateId: 'detail-v1:dirty-full', subtype: 'broadleaf-tree', variationSeed: 1,
      orientationSeed: 0.25, worldPosition: Object.freeze({ x: 56, y: 0.4, z: 8 }),
      owningChunkCoordinate: Object.freeze({ x: 5, z: 0 }),
      metadata: Object.freeze({ candidateRadiusMeters: 0.32 }),
    }),
    Object.freeze({
      candidateId: 'detail-v1:dirty-silhouette', subtype: 'conifer-tree', variationSeed: 1,
      orientationSeed: 0.25, worldPosition: Object.freeze({ x: 80, y: 0.4, z: 8 }),
      owningChunkCoordinate: Object.freeze({ x: 5, z: 0 }),
      metadata: Object.freeze({ candidateRadiusMeters: 0.32 }),
    }),
  ]);
  const chunk = canonicalChunk(5, 0, []);
  chunk.vegetationCandidates = candidates;
  chunk.presentationLayers.natural.vegetation = candidates;
  const scene = new DistantTestGroup();
  const presentation = await createW8DistantPresentation({
    THREE: DISTANT_TEST_THREE,
    scene,
    worldSeedHash: CANONICAL_WORLD_SEED_HASH,
    visualAssets: createSilhouetteTestVisualAssets(),
    findSettlementsNear: async () => [],
    resolveTemplate: async () => null,
    getCanonicalChunkData: async () => chunk,
    incrementalStaticTreePages: true,
  });
  const input = canonicalSyncInput({
    centerChunkX: 0, activeDataKeys: ['5,0'], renderedKeys: [], chunk,
    playerLogicalX: 8, quality: 'high',
  });
  assert.equal(await presentation.sync(input), true);
  presentation.applyStaticNaturalPlan({
    coverageGeneration: 1,
    planRevision: 1,
    planId: 'gpu-distance-natural-owner',
    destructionRevision: 'none',
    quality: 'high',
    renderDistancePreset: 'current',
    renderOrigin: input.renderOrigin,
    playerLogicalX: input.playerLogicalX,
    playerLogicalZ: input.playerLogicalZ,
    activeDataKeys: input.activeDataKeys,
    renderedKeys: input.renderedKeys,
    retainedOwnerKeys: ['5,0'],
    resourceKindEntries: [['5,0', 'presentation']],
    readyPages: [{
      ownerKey: '5,0', resourceKind: 'presentation', value: chunk,
      readyAtMs: performance.now(), required: true,
    }],
  });
  for (let frame = 0; frame < 100
    && presentation.snapshot().staticTreeCurrentPublishedOwnerCount !== 1; frame += 1) {
    presentation.update(8, 8, input.renderOrigin);
    await new Promise(resolve => setImmediate(resolve));
  }
  const baseline = presentation.snapshot();
  presentation.update(8, 8, input.renderOrigin);
  const unchanged = presentation.snapshot();
  assert.equal(unchanged.canonicalComposeCount, baseline.canonicalComposeCount);
  assert.equal(unchanged.canonicalMatrixUpdateCount, baseline.canonicalMatrixUpdateCount);
  assert.equal(unchanged.canonicalNeedsUpdateCount, baseline.canonicalNeedsUpdateCount);
  assert.equal(unchanged.naturalVisibilitySequence, baseline.naturalVisibilitySequence);
  const reused = unchanged;
  presentation.update(32, 8, input.renderOrigin);
  const changed = presentation.snapshot();
  assert.equal(changed.canonicalComposeCount, reused.canonicalComposeCount);
  assert.equal(changed.canonicalMatrixUpdateCount, reused.canonicalMatrixUpdateCount);
  assert.equal(changed.canonicalNeedsUpdateCount, reused.canonicalNeedsUpdateCount);
  assert.equal(changed.canonicalDirtyBucketCount, reused.canonicalDirtyBucketCount);
  assert.equal(changed.naturalVisibilitySequence, reused.naturalVisibilitySequence);
  assert.deepEqual(changed.naturalLodPlayerLocalXZ, { x: 8192, y: 2048 });
  assert.equal(changed.distantTreeProxyCount, 0);
  const audit = presentation.canonicalAuditSnapshot();
  assert.deepEqual(audit.map(value => value.ownerKey).sort(), ['5,0', '5,0']);
  assert.equal(new Set(audit.map(value => value.identity.stableId)).size, 2);
  presentation.dispose();
});

test('canonical MAJOR Road remains eligible across the Far handoff without a representative Settlement proxy', async () => {
  const majorRoad = Object.freeze({
    schemaVersion: 'w8-canonical-major-road-chunk-feature-1',
    stableId: 'major-road-v1:handoff:segment:0:chunk:5:0',
    sourceStableId: 'major-road-v1:handoff',
    sourceSegmentStableId: 'major-road-v1:handoff:segment:0',
    featureType: 'settlement-road',
    canonicalMajorRoad: true,
    settlementId: 'settlement-v1:left',
    settlementIds: Object.freeze(['settlement-v1:left', 'settlement-v1:right']),
    roadKind: 'MAJOR',
    widthMeters: 2.25,
    start: Object.freeze({ x: 84, y: 0, z: 8 }),
    end: Object.freeze({ x: 92, y: 0, z: 8 }),
    worldPosition: Object.freeze({ x: 88, y: 0, z: 8 }),
    owningChunkCoordinate: Object.freeze({ x: 5, z: 0 }),
  });
  const chunk = canonicalChunk(5, 0, [majorRoad]);
  const presentation = await createW8DistantPresentation({
    THREE: DISTANT_TEST_THREE,
    scene: new DistantTestGroup(),
    worldSeedHash: CANONICAL_WORLD_SEED_HASH,
    visualAssets: createDistantTestVisualAssets(),
    findSettlementsNear: async () => [],
    resolveTemplate: async () => null,
    getCanonicalChunkData: async (chunkX, chunkZ) => (
      chunkX === 5 && chunkZ === 0 ? chunk : null
    ),
  });
  const input = canonicalSyncInput({
    centerChunkX: 0,
    activeDataKeys: ['5,0'],
    renderedKeys: [],
    chunk,
    playerLogicalX: 8,
    quality: 'high',
  });
  assert.equal(await presentation.sync(input), true);
  const audit = presentation.canonicalAuditSnapshot();
  assert.equal(audit.filter(value => value.identity.stableId === majorRoad.stableId).length, 1);
  const roadSnapshot = presentation.snapshot();
  assert.equal(roadSnapshot.canonicalRoadRecordCount, 1);
  assert.equal(roadSnapshot.canonicalRoadMeshBucketCount, 1);
  assert.ok(roadSnapshot.canonicalRoadMeshComposeMs >= 0);
  assert.ok(roadSnapshot.canonicalRoadMatrixComposeMs >= 0);

  // Moving the same owner into Near rendering removes it from Distant rather
  // than creating a second Road identity; the Near adapter owns that exact
  // Chunk feature during the handoff.
  const nearInput = canonicalSyncInput({
    centerChunkX: 5,
    activeDataKeys: ['5,0'],
    renderedKeys: ['5,0'],
    chunk,
    playerLogicalX: 88,
    quality: 'high',
  });
  assert.equal(await presentation.sync(nearInput), true);
  const handedOff = presentation.canonicalAuditSnapshot().find(value => (
    value.identity.stableId === majorRoad.stableId
  ));
  assert.equal(handedOff.visibleLod, 'near');
  assert.equal(handedOff.composedInstanceCount, 0);
  assert.equal(handedOff.ownerRendered, true);
  presentation.dispose();
});

test('canonical River keeps the Far owner staged while active ownership hides and restores it atomically', async () => {
  const scene = new DistantTestGroup();
  const chunk = canonicalChunk(0, 0, []);
  const riverProjection = await createCanonicalRiverProjection({
    worldSeedHash: CANONICAL_WORLD_SEED_HASH,
    chunkX: 0,
    chunkZ: 0,
  });
  chunk.waterSurfaces = [riverProjection.waterSurface];
  chunk.presentationLayers.water = [riverProjection.waterSurface];
  const presentation = await createW8DistantPresentation({
    THREE: DISTANT_TEST_THREE,
    scene,
    worldSeedHash: CANONICAL_WORLD_SEED_HASH,
    visualAssets: createDistantTestVisualAssets(),
    findSettlementsNear: async () => [],
    resolveTemplate: async () => null,
    getCanonicalChunkData: async () => chunk,
  });
  assert.equal(await presentation.sync(canonicalSyncInput({
    centerChunkX: 0,
    activeDataKeys: ['0,0'],
    renderedKeys: ['0,0'],
    chunk,
    playerLogicalX: 8,
    quality: 'high',
  })), true);
  const generationRoot = scene.children[0].children[0];
  const riverMesh = generationRoot.children.find(child => (
    child.name === 'w8-far-canonical-river-water'
  ));
  assert.ok(riverMesh);
  const ownerIndices = riverMesh.userData.ownerKeys
    .map((ownerKey, index) => ownerKey === '0,0' ? index : -1)
    .filter(index => index >= 0);
  assert.ok(ownerIndices.length > 0);
  assert.ok(ownerIndices.every(index => (
    riverMesh.matrices[index].value.scale.x === 0
      && riverMesh.matrices[index].value.scale.y === 0
      && riverMesh.matrices[index].value.scale.z === 0
  )), 'Far River is staged but hidden while the same owner is active');
  const canonicalRiver = presentation.canonicalAuditSnapshot().find(value => (
    value.identity.stableId === riverProjection.waterSurface.stableId
  ));
  assert.equal(canonicalRiver.visibleLod, 'near');

  assert.equal(presentation.commitRuntimeState({
    activeDataKeys: [],
    renderedKeys: [],
    renderOrigin: { renderOriginChunkX: 0, renderOriginChunkZ: 0, rebaseCount: 1 },
    quality: 'high',
    playerLogicalX: 8,
    playerLogicalZ: 8,
  }), true);
  assert.ok(ownerIndices.every(index => (
    riverMesh.matrices[index].value.scale.x > 0
      && riverMesh.matrices[index].value.scale.y > 0
  )), 'the same staged Far instances return when active ownership ends');
  assert.equal(presentation.canonicalAuditSnapshot().find(value => (
    value.identity.stableId === riverProjection.waterSurface.stableId
  )).visibleLod, 'hidden', 'the old active record cannot remain as a second Far River');
  assert.equal(scene.children[0].children[0], generationRoot,
    'the complete Far root remains staged throughout the owner handoff');

  assert.equal(presentation.commitRuntimeState({
    activeDataKeys: ['0,0'],
    renderedKeys: ['0,0'],
    renderOrigin: { renderOriginChunkX: 0, renderOriginChunkZ: 0, rebaseCount: 2 },
    quality: 'high',
    playerLogicalX: 8,
    playerLogicalZ: 8,
  }), true);
  assert.ok(ownerIndices.every(index => (
    riverMesh.matrices[index].value.scale.x === 0
      && riverMesh.matrices[index].value.scale.y === 0
      && riverMesh.matrices[index].value.scale.z === 0
  )), 'Near ownership hides the same canonical Far instances again');
  assert.equal(presentation.canonicalAuditSnapshot().find(value => (
    value.identity.stableId === riverProjection.waterSurface.stableId
  )).visibleLod, 'near');
  presentation.dispose();
});

test('Far water has no moisture-grid proxy path outside canonical River records', async () => {
  const source = await readFile(new URL(
    '../src/infinite-world/render/w8-distant-presentation.js',
    import.meta.url,
  ), 'utf8');
  assert.doesNotMatch(source, /water-proxy|createDistantWaterProxies|DISTANT_WATER_PROXY/);
  assert.match(source, /createFarRiverPresentation/);
  assert.match(source, /projection\.waterSurface/);
});

test('runtime ownership changes cannot create non-canonical Far water', async () => {
  const source = await readFile(new URL(
    '../src/infinite-world/render/w8-distant-presentation.js',
    import.meta.url,
  ), 'utf8');
  assert.doesNotMatch(source, /distantWaterProxyPresentations|updateDistantWaterProxyVisibility/);
});

test('superseded distant sync cancels during owner acquisition and cannot commit an old epoch', async () => {
  let releaseFirstOwner;
  const firstOwner = new Promise(resolve => { releaseFirstOwner = resolve; });
  let signalFirstOwner;
  const firstOwnerStarted = new Promise(resolve => { signalFirstOwner = resolve; });
  let ownerCalls = 0;
  let firstOwnerKey = null;
  const requestMetadata = [];
  const cancelledConsumers = [];
  const presentation = await createW8DistantPresentation({
    THREE: DISTANT_TEST_THREE,
    scene: new DistantTestGroup(),
    worldSeedHash: CANONICAL_WORLD_SEED_HASH,
    visualAssets: createSilhouetteTestVisualAssets(),
    findSettlementsNear: async () => [CANONICAL_CANDIDATE],
    resolveTemplate: async () => CANONICAL_TEMPLATE,
    getCanonicalChunkData: async (chunkX, chunkZ, metadata) => {
      requestMetadata.push({ ...metadata, chunkX, chunkZ });
      ownerCalls += 1;
      if (ownerCalls === 1) {
        firstOwnerKey = `${chunkX},${chunkZ}`;
        signalFirstOwner();
        return firstOwner;
      }
      return canonicalChunk(chunkX, chunkZ, []);
    },
    cancelCanonicalChunkRequests: options => {
      cancelledConsumers.push(options);
      if (requestMetadata[0] && options.beforeEpoch > requestMetadata[0].epoch) {
        releaseFirstOwner(null);
      }
    },
  });
  const firstInput = canonicalSyncInput({
    centerChunkX: 0, activeDataKeys: [], renderedKeys: [], chunk: canonicalChunk(0, 0, []), quality: 'high',
  });
  firstInput.renderDistancePreset = 'short';
  firstInput.renderOrigin.rebaseCount = 1;
  const first = presentation.sync(firstInput);
  await firstOwnerStarted;
  assert.equal(ownerCalls > 0, true);
  assert.equal(presentation.commitRuntimeState({
    activeDataKeys: [], renderedKeys: [],
    renderOrigin: { renderOriginChunkX: 1, renderOriginChunkZ: 0, rebaseCount: 2 },
    quality: 'high', playerLogicalX: 24, playerLogicalZ: 8,
  }), true, 'publishing a newer committed origin invalidates the pending Far generation');
  const secondInput = canonicalSyncInput({
    centerChunkX: 1, activeDataKeys: [], renderedKeys: [], chunk: canonicalChunk(1, 0, []), quality: 'high',
  });
  secondInput.renderDistancePreset = 'current';
  secondInput.renderOrigin.rebaseCount = 2;
  const second = presentation.sync(secondInput);
  assert.equal(await first, false);
  assert.equal(await second, true);
  const snapshot = presentation.snapshot();
  assert.ok(snapshot.staleEpochDiscardCount >= 1);
  assert.equal(snapshot.committedEpoch, snapshot.syncEpoch);
  assert.equal(snapshot.renderDistancePreset, 'current');
  assert.equal(snapshot.visibilityMeters, 187.5);
  assert.ok(requestMetadata.every(value => value.consumerId === 'distant-owner-query'
    && Number.isSafeInteger(value.epoch)));
  assert.ok(cancelledConsumers.some(value => value.consumerId === 'distant-owner-query'
    && value.beforeEpoch > requestMetadata[0].epoch));
  assert.equal(requestMetadata.filter(value => (
    `${value.chunkX},${value.chunkZ}` === firstOwnerKey
  )).length >= 2, true, 'the new epoch must re-request an owner cancelled to null');
  assert.equal(snapshot.queryCanonicalChunkSuccessCount, snapshot.queryOwnerChunkCount);
  const callsBeforeCacheReuse = ownerCalls;
  assert.equal(await presentation.sync(secondInput), true);
  const reuseSnapshot = presentation.snapshot();
  const cacheHits = reuseSnapshot.queryFarOwnerChunkCacheHits;
  const cacheMisses = reuseSnapshot.queryFarOwnerChunkCacheMisses;
  assert.ok(cacheHits > 0,
    'successful replacement owners within the bounded caches remain reusable');
  assert.equal(ownerCalls - callsBeforeCacheReuse, cacheMisses,
    'only bounded-cache misses are reacquired after the cancelled null');
  presentation.dispose();
});

test('Far canonical records, buckets, and matrices are sliced with latest-only atomic publication', async () => {
  const pendingYields = [];
  let holdYields = false;
  const scene = new DistantTestGroup();
  const presentation = await createW8DistantPresentation({
    THREE: DISTANT_TEST_THREE,
    scene,
    worldSeedHash: CANONICAL_WORLD_SEED_HASH,
    visualAssets: createDistantTestVisualAssets(),
    findSettlementsNear: async () => [],
    resolveTemplate: async () => null,
    getCanonicalChunkData: async (chunkX, chunkZ) => canonicalChunk(chunkX, chunkZ, []),
    yieldToMainThread: () => holdYields
      ? new Promise(resolve => pendingYields.push(resolve))
      : Promise.resolve(),
  });
  const baselineInput = canonicalSyncInput({
    centerChunkX: 0,
    activeDataKeys: ['5,0'],
    renderedKeys: [],
    chunk: canonicalChunk(),
  });
  baselineInput.renderDistancePreset = 'short';
  assert.equal(await presentation.sync(baselineInput), true);
  const distantRoot = scene.children[0];
  const baselineRoot = distantRoot.children[0];
  const denseRecords = Array.from({ length: 300 }, (_, index) => Object.freeze({
    ...CANONICAL_BUILDING,
    stableId: `${CANONICAL_BUILDING_ID}:slice:${index}`,
    worldPosition: Object.freeze({ x: 80 + (index % 20) * 0.25, y: 0.4, z: 4 + Math.floor(index / 20) * 0.25 }),
  }));
  const denseChunk = canonicalChunk(5, 0, denseRecords);
  holdYields = true;
  const stale = presentation.sync({
    ...canonicalSyncInput({
      centerChunkX: 0,
      activeDataKeys: ['5,0'],
      renderedKeys: [],
      chunk: denseChunk,
    }),
    renderDistancePreset: 'short',
  });
  await waitForControlledYield(pendingYields);
  assert.equal(distantRoot.children.length, 1);
  assert.equal(distantRoot.children[0], baselineRoot);
  const latest = presentation.sync({
    ...canonicalSyncInput({
      centerChunkX: 1,
      activeDataKeys: ['5,0'],
      renderedKeys: [],
      chunk: denseChunk,
    }),
    renderDistancePreset: 'standard',
  });
  const [staleResult, latestResult] = await drainControlledYields(
    [stale, latest],
    pendingYields,
    {
      whilePending() {
        assert.equal(distantRoot.children.length, 1);
        assert.equal(distantRoot.children[0], baselineRoot,
          'Far record, bucket, and matrix slices remain detached until complete');
      },
    },
  );
  assert.equal(staleResult, false);
  assert.equal(latestResult, true);
  assert.equal(distantRoot.children.length, 1);
  assert.notEqual(distantRoot.children[0], baselineRoot);
  const snapshot = presentation.snapshot();
  assert.equal(distantRoot.children[0].userData.epoch, snapshot.committedEpoch);
  assert.equal(snapshot.committedEpoch, snapshot.syncEpoch);
  assert.equal(snapshot.renderDistancePreset, 'standard');
  assert.deepEqual(snapshot.buildOrigin, {
    renderOriginChunkX: 1,
    renderOriginChunkZ: 0,
  });
  assert.equal(snapshot.canonicalBuildingRecordCount, denseRecords.length);
  assert.equal(snapshot.farLastSliceCount > 0, true);
  assert.equal(snapshot.farLastMaximumSliceMs >= 0, true);
  assert.deepEqual(
    presentation.canonicalAuditSnapshot().map(value => value.identity.stableId).sort(),
    denseRecords.map(value => value.stableId).sort(),
  );

  const shutdownBuild = presentation.sync({
    ...canonicalSyncInput({
      centerChunkX: 0,
      activeDataKeys: ['5,0'],
      renderedKeys: [],
      chunk: denseChunk,
    }),
    renderDistancePreset: 'current',
  });
  await waitForControlledYield(pendingYields);
  presentation.dispose();
  while (pendingYields.length) pendingYields.shift()();
  assert.equal(await shutdownBuild, false);
  assert.equal(scene.children.length, 0);
});

test('time-sliced boundary compose covers representative Current/High, Standard/Medium, and Short/Low modes', async () => {
  const cases = [
    { renderDistancePreset: 'current', quality: 'high' },
    { renderDistancePreset: 'standard', quality: 'medium' },
    { renderDistancePreset: 'short', quality: 'low' },
  ];
  for (const options of cases) {
    const scene = new DistantTestGroup();
    const presentation = await createLocalTerrainTestPresentation(scene);
    const initial = localTerrainCoverageFixture(0, 0);
    presentation.syncLocalTerrain({
      coverageEpoch: 1,
      renderDistancePreset: options.renderDistancePreset,
      ...initial,
    });
    const next = localTerrainCoverageFixture(1, 0);
    const localResult = await presentation.syncLocalTerrainIncrementally({
      coverageEpoch: 2,
      renderDistancePreset: options.renderDistancePreset,
      ...next,
    });
    assert.equal(localResult.committed, true, JSON.stringify(options));
    assert.equal(await presentation.sync({
      ...next,
      quality: options.quality,
      renderDistancePreset: options.renderDistancePreset,
      playerLogicalX: 24,
      playerLogicalZ: 8,
    }), true, JSON.stringify(options));
    const snapshot = presentation.snapshot();
    assert.equal(snapshot.renderDistancePreset, options.renderDistancePreset);
    assert.equal(snapshot.quality, options.quality);
    assert.equal(snapshot.localTerrainLastSliceCount > 0, true);
    assert.equal(snapshot.farLastSliceCount > 0, true);
    assert.equal(snapshot.localTerrainRootAttached, true);
    assert.equal(snapshot.rootAttached, true);
    presentation.dispose();
  }
});

test('High active-local Settlement horizon uses canonical Building and Landmark records exclusively', async () => {
  const horizonBuilding = Object.freeze({ ...CANONICAL_BUILDING });
  const horizonLandmark = Object.freeze({
    ...CANONICAL_BUILDING,
    stableId: 'settlement-landmark-v1:gate-a-house',
    settlementId: undefined,
    parentSettlementId: CANONICAL_SETTLEMENT_ID,
    featureType: 'settlement-landmark',
    buildingType: undefined,
    landmarkType: 'house',
  });
  const chunk = canonicalChunk(5, 0, [horizonBuilding]);
  chunk.settlementLandmarks = [horizonLandmark];
  chunk.presentationLayers.landmarks = [horizonLandmark];
  const currentCandidate = Object.freeze({
    settlementId: CANONICAL_SETTLEMENT_ID,
    worldPosition: Object.freeze({ x: -56, z: 8 }),
  });
  const distantCandidate = Object.freeze({
    settlementId: 'settlement-v1:distant',
    worldPosition: Object.freeze({ x: 120, z: 8 }),
  });
  let destroyedBuilding = false;
  let templateCalls = 0;
  const scene = new DistantTestGroup();
  const presentation = await createW8DistantPresentation({
    THREE: DISTANT_TEST_THREE,
    scene,
    worldSeedHash: CANONICAL_WORLD_SEED_HASH,
    visualAssets: createDistantTestVisualAssets(),
    findSettlementsNear: async () => [distantCandidate, currentCandidate],
    resolveTemplate: async ({ candidate }) => {
      templateCalls += 1;
      if (candidate.settlementId === distantCandidate.settlementId) return null;
      assert.equal(candidate.settlementId, CANONICAL_SETTLEMENT_ID);
      return {
        settlementId: CANONICAL_SETTLEMENT_ID,
        center: currentCandidate.worldPosition,
        buildings: [horizonBuilding.worldPosition],
        roads: [],
      };
    },
    getCanonicalChunkData: async (chunkX, chunkZ) => (
      chunkX === 5 && chunkZ === 0 ? chunk : null
    ),
    isFeatureDestroyed: stableId => destroyedBuilding && stableId === horizonBuilding.stableId,
  });
  const horizonInput = canonicalSyncInput({
    centerChunkX: -4,
    activeDataKeys: [],
    renderedKeys: [],
    chunk,
    playerLogicalX: -62,
    quality: 'high',
  });
  assert.equal(await presentation.sync(horizonInput), true);
  const audit = Object.fromEntries(presentation.canonicalAuditSnapshot().map(object => [
    object.identity.stableId,
    object,
  ]));
  assert.equal(templateCalls, 2,
    'every local candidate is resolved even when one has no materializable template');
  assert.equal(audit[horizonBuilding.stableId].presentationTier, 'horizon');
  assert.equal(audit[horizonLandmark.stableId].presentationTier, 'horizon');
  assert.equal(audit[horizonBuilding.stableId].ownerKey, '5,0');
  assert.equal(audit[horizonLandmark.stableId].ownerKey, '5,0');
  assert.deepEqual(audit[horizonBuilding.stableId].identity.worldPosition, horizonBuilding.worldPosition);
  assert.deepEqual(audit[horizonLandmark.stableId].identity.worldPosition, horizonLandmark.worldPosition);
  assert.equal(audit[horizonBuilding.stableId].identity.rotationY, horizonBuilding.rotationY);
  assert.equal(audit[horizonLandmark.stableId].identity.landmarkType, 'house');
  const snapshot = presentation.snapshot();
  assert.equal(snapshot.activeLocalSettlementId, CANONICAL_SETTLEMENT_ID);
  assert.equal(snapshot.queryCandidateCount, 2);
  assert.equal(snapshot.queryTemplateSuccessCount, 1);
  assert.equal(snapshot.visibleCanonicalHorizonBuildingCount, 1);
  assert.equal(snapshot.visibleCanonicalHorizonLandmarkCount, 1);
  assert.equal(snapshot.visibleCanonicalHorizonPartInstanceCount, 2);
  assert.ok(snapshot.queryBuildingOwnerChunkCount >= 1);
  assert.equal(snapshot.queryBuildingOwnerChunkKeys.includes('5,0'), true);
  const meshes = scene.children[0].children[0].children.filter(
    child => child.name.startsWith('w8-canonical-lod-'),
  );
  const occurrences = stableId => meshes.reduce((count, mesh) => (
    count + mesh.userData.canonicalStableIds.filter(value => value === stableId).length
  ), 0);
  assert.equal(occurrences(horizonBuilding.stableId), 1);
  assert.equal(occurrences(horizonLandmark.stableId), 1);
  presentation.update(20, 8, { renderOriginChunkX: -4, renderOriginChunkZ: 0 });
  assert.equal(presentation.canonicalAuditSnapshot().find(object => (
    object.identity.stableId === horizonBuilding.stableId
  )).presentationTier, 'full');
  destroyedBuilding = true;
  presentation.update(-62, 8, { renderOriginChunkX: -4, renderOriginChunkZ: 0 });
  assert.equal(presentation.canonicalAuditSnapshot().find(object => (
    object.identity.stableId === horizonBuilding.stableId
  )).visibleLod, 'destroyed');
  assert.equal(presentation.snapshot().visibleCanonicalHorizonBuildingCount, 0);
  assert.equal(presentation.snapshot().destroyedHorizonBuildingCount, 1);
  presentation.dispose();
});

test('Settlement presentation policy separates preset range from quality silhouette detail', () => {
  const candidate = (settlementId, x, settlementType, townType) => Object.freeze({
    settlementId,
    settlementType,
    townType,
    center: Object.freeze({ x, z: 0 }),
  });
  const candidates = [
    candidate('settlement-v1:current', 0, 'RURAL', 'suburb'),
    candidate('settlement-v1:radius-included', 950, 'CITY', 'capital'),
    candidate('settlement-v1:near-remote', 400, 'RURAL', 'residential'),
    candidate('settlement-v1:town', 520, 'TOWN', 'church_town'),
    candidate('settlement-v1:city', 650, 'CITY', 'capital'),
    candidate('settlement-v1:rural', 760, 'RURAL', 'military'),
    candidate('settlement-v1:outside', 1_000, 'CITY', 'capital'),
  ];
  const high = selectW8SettlementPresentationCandidates({
    candidates, playerX: 0, playerZ: 0, quality: 'high',
  });
  assert.equal(W8_FINITE_SETTLEMENT_VIEW_CONTRACT.cameraFarMeters, 875);
  assert.equal(resolveW8SettlementPresentationPolicy('high').remote.hiddenDistanceMeters, 875);
  assert.equal(resolveW8SettlementPresentationPolicy('medium').remote.hiddenDistanceMeters, 875);
  assert.equal(resolveW8SettlementPresentationPolicy('low').remote.hiddenDistanceMeters, 875);
  assert.equal(resolveW8SettlementPresentationPolicy('high', 'standard').remote.hiddenDistanceMeters, 150);
  assert.equal(resolveW8SettlementPresentationPolicy('high', 'short').remote.hiddenDistanceMeters, 112.5);
  assert.equal(resolveW8SettlementPresentationPolicy('high').metadata.queryDistanceMeters, 875);
  assert.equal(resolveW8SettlementPresentationPolicy('high', 'standard').metadata.queryDistanceMeters,
    656.25);
  assert.equal(resolveW8SettlementPresentationPolicy('high', 'short').metadata.queryDistanceMeters,
    352);
  assert.equal(resolveW8SettlementPresentationPolicy('high').remote.enabled, true);
  assert.equal(resolveW8SettlementPresentationPolicy('high', 'standard').remote.enabled, false);
  assert.equal(resolveW8SettlementPresentationPolicy('high', 'short').remote.enabled, false);
  assert.equal(resolveW8SettlementPresentationPolicy('high').remote.fog, false);
  assert.equal(high.activeLocal.candidate.settlementId, 'settlement-v1:current');
  assert.equal(high.remote.length, resolveW8SettlementPresentationPolicy('high').remote.settlementLimit);
  assert.deepEqual(high.remote.map(value => value.candidate.settlementId), [
    'settlement-v1:near-remote',
    'settlement-v1:town',
    'settlement-v1:city',
    'settlement-v1:rural',
  ]);
  assert.deepEqual(selectW8SettlementPresentationCandidates({
    candidates: [...candidates].reverse(), playerX: 0, playerZ: 0, quality: 'high',
  }).remote.map(value => value.candidate.settlementId),
  high.remote.map(value => value.candidate.settlementId));
  assert.ok(high.ranked.find(value => (
    value.candidate.settlementId === 'settlement-v1:radius-included'
  )).boundaryDistanceMeters < W8_FINITE_SETTLEMENT_VIEW_CONTRACT.cameraFarMeters);
  assert.ok(high.ranked.find(value => (
    value.candidate.settlementId === 'settlement-v1:outside'
  )).boundaryDistanceMeters > W8_FINITE_SETTLEMENT_VIEW_CONTRACT.cameraFarMeters);
  assert.deepEqual(selectW8SettlementPresentationCandidates({
    candidates: [candidates[0], candidates[1], candidates[6]],
    playerX: 0, playerZ: 0, quality: 'high',
  }).remote.map(value => value.candidate.settlementId), ['settlement-v1:radius-included']);
  const medium = selectW8SettlementPresentationCandidates({
    candidates, playerX: 0, playerZ: 0, quality: 'medium',
  });
  assert.deepEqual(medium.remote.map(value => value.candidate.settlementId),
    high.remote.map(value => value.candidate.settlementId));
  const low = selectW8SettlementPresentationCandidates({
    candidates, playerX: 0, playerZ: 0, quality: 'low',
  });
  assert.deepEqual(low.remote.map(value => value.candidate.settlementId),
    high.remote.map(value => value.candidate.settlementId));
  assert.equal(selectW8SettlementPresentationCandidates({
    candidates, playerX: 0, playerZ: 0, quality: 'high', renderDistancePreset: 'standard',
  }).remote.length, 0);
  assert.equal(selectW8SettlementPresentationCandidates({
    candidates, playerX: 0, playerZ: 0, quality: 'high', renderDistancePreset: 'short',
  }).remote.length, 0);
  const limits = ['CITY', 'TOWN', 'RURAL'].map(settlementType => (
    resolveRemoteHorizonBuildingLimit({ settlementType, buildingCount: 100, quality: 'high' })
  ));
  assert.deepEqual(limits, [100, 100, 100]);
});

test('a second Settlement inside the local presentation band is not dropped', () => {
  const minimumRuralSeparationMeters = 504.859201;
  const ruralRadiusMeters = 87.75;
  const halfSeparation = minimumRuralSeparationMeters / 2;
  const candidates = [
    Object.freeze({
      settlementId: 'settlement-v1:rural-west',
      settlementType: 'RURAL',
      townType: 'residential',
      center: Object.freeze({ x: -halfSeparation, z: 0 }),
      radiusMeters: ruralRadiusMeters,
    }),
    Object.freeze({
      settlementId: 'settlement-v1:rural-east',
      settlementType: 'RURAL',
      townType: 'military',
      center: Object.freeze({ x: halfSeparation, z: 0 }),
      radiusMeters: ruralRadiusMeters,
    }),
  ];
  const selection = selectW8SettlementPresentationCandidates({
    candidates,
    playerX: 0,
    playerZ: 0,
    quality: 'high',
    renderDistancePreset: 'current',
  });
  const representedSettlementIds = new Set([
    ...selection.local.map(value => value.candidate.settlementId),
    ...selection.remote.map(value => value.candidate.settlementId),
  ]);

  assert.equal(selection.ranked.every(value => (
    value.boundaryDistanceMeters < selection.policy.local.hiddenDistanceMeters
  )), true);
  assert.deepEqual(
    [...representedSettlementIds].sort(),
    candidates.map(candidate => candidate.settlementId).sort(),
    'every Settlement inside the local band needs a Near or silhouette representation',
  );
  assert.equal(selection.activeLocal.candidate.settlementId, 'settlement-v1:rural-east');
  assert.deepEqual(selection.additionalLocal.map(value => value.candidate.settlementId), [
    'settlement-v1:rural-west',
  ]);
  assert.deepEqual(selection.local.map(value => value.tier), [
    'active-local',
    'additional-local',
  ]);
  assert.equal(selection.remote.length, 0);
  assert.equal(selection.excluded.length, 0);
});

test('adjacent TOWN Settlements stay local across presets and quality changes', () => {
  const minimumTownSeparationMeters = 394.196176;
  const townRadiusMeters = 94.5;
  const halfSeparation = minimumTownSeparationMeters / 2;
  const candidates = ['west', 'east'].map((side, index) => Object.freeze({
    settlementId: `settlement-v1:town-${side}`,
    settlementType: 'TOWN',
    townType: index ? 'school_town' : 'church_town',
    center: Object.freeze({ x: index ? halfSeparation : -halfSeparation, z: 0 }),
    radiusMeters: townRadiusMeters,
  }));
  for (const renderDistancePreset of ['short', 'standard', 'current']) {
    let expectedIds = null;
    for (const quality of ['high', 'medium', 'low']) {
      const selection = selectW8SettlementPresentationCandidates({
        candidates,
        playerX: 0,
        playerZ: 0,
        quality,
        renderDistancePreset,
      });
      const ids = selection.local.map(value => value.candidate.settlementId);
      expectedIds ??= ids;
      assert.deepEqual(ids, expectedIds);
      assert.equal(selection.local.length, 2);
      assert.equal(selection.additionalLocal.length, 1);
      assert.equal(selection.remote.length, 0);
      assert.ok(selection.local.every(value => value.boundaryDistanceMeters < 112.5));
    }
  }
  const westPriority = selectW8SettlementPresentationCandidates({
    candidates, playerX: -50, playerZ: 0, renderDistancePreset: 'current',
  });
  const eastPriority = selectW8SettlementPresentationCandidates({
    candidates, playerX: 50, playerZ: 0, renderDistancePreset: 'current',
  });
  assert.equal(westPriority.activeLocal.candidate.settlementId, 'settlement-v1:town-west');
  assert.equal(eastPriority.activeLocal.candidate.settlementId, 'settlement-v1:town-east');
});

test('Current combines multiple local Settlements with a separate bounded remote tier', () => {
  const candidates = [
    Object.freeze({
      settlementId: 'settlement-v1:mixed-local-west',
      settlementType: 'TOWN',
      townType: 'church_town',
      center: Object.freeze({ x: -197.098088, z: 0 }),
      radiusMeters: 94.5,
    }),
    Object.freeze({
      settlementId: 'settlement-v1:mixed-local-east',
      settlementType: 'TOWN',
      townType: 'school_town',
      center: Object.freeze({ x: 197.098088, z: 0 }),
      radiusMeters: 94.5,
    }),
    Object.freeze({
      settlementId: 'settlement-v1:mixed-remote',
      settlementType: 'RURAL',
      townType: 'suburb',
      center: Object.freeze({ x: 500, z: 0 }),
      radiusMeters: 80,
    }),
  ];
  const current = selectW8SettlementPresentationCandidates({
    candidates, playerX: 0, playerZ: 0, renderDistancePreset: 'current',
  });
  assert.equal(current.local.length, 2);
  assert.equal(current.additionalLocal.length, 1);
  assert.deepEqual(current.remote.map(value => value.candidate.settlementId), [
    'settlement-v1:mixed-remote',
  ]);
  assert.equal(new Set([...current.local, ...current.remote].map(value => (
    value.candidate.settlementId
  ))).size, 3);
  for (const renderDistancePreset of ['short', 'standard']) {
    const selection = selectW8SettlementPresentationCandidates({
      candidates, playerX: 0, playerZ: 0, renderDistancePreset,
    });
    assert.equal(selection.local.length, 2);
    assert.equal(selection.remote.length, 0);
    assert.equal(selection.excluded.find(value => (
      value.candidate.settlementId === 'settlement-v1:mixed-remote'
    )).selectedReason, renderDistancePreset === 'standard'
      ? 'remote-disabled' : 'outside-presentation-range');
  }
});

test('three formally spaced TOWN Settlements share the local band without an unbounded selection', () => {
  const sideMeters = 394.196176;
  const radiusFromPlayer = sideMeters / Math.sqrt(3);
  const candidates = [0, 1, 2].map(index => {
    const angle = -Math.PI / 2 + index * Math.PI * 2 / 3;
    return Object.freeze({
      settlementId: `settlement-v1:town-triad-${index}`,
      settlementType: 'TOWN',
      townType: index % 2 ? 'school_town' : 'church_town',
      center: Object.freeze({
        x: Math.cos(angle) * radiusFromPlayer,
        z: Math.sin(angle) * radiusFromPlayer,
      }),
      radiusMeters: 94.5,
    });
  });
  const selection = selectW8SettlementPresentationCandidates({
    candidates,
    playerX: 0,
    playerZ: 0,
    renderDistancePreset: 'standard',
  });
  assert.equal(W8_LOCAL_SETTLEMENT_SELECTION_LIMIT, 16);
  assert.equal(selection.policy.local.settlementLimit, 16);
  assert.equal(selection.local.length, 3);
  assert.equal(selection.additionalLocal.length, 2);
  assert.equal(selection.remote.length, 0);
  assert.ok(selection.local.every(value => value.boundaryDistanceMeters < 150));
  assert.deepEqual(selection.local.map(value => value.tier), [
    'active-local', 'additional-local', 'additional-local',
  ]);
});

test('local Settlement selection is explicitly bounded and reports overflow candidates', () => {
  const candidates = Array.from(
    { length: W8_LOCAL_SETTLEMENT_SELECTION_LIMIT + 1 },
    (_, index) => Object.freeze({
      settlementId: `settlement-v1:local-cap-${String(index).padStart(2, '0')}`,
      settlementType: 'TOWN',
      townType: 'church_town',
      center: Object.freeze({ x: index * 0.001, z: 0 }),
      radiusMeters: 100,
    }),
  );
  const selection = selectW8SettlementPresentationCandidates({
    candidates,
    playerX: 0,
    playerZ: 0,
    renderDistancePreset: 'current',
  });
  assert.equal(selection.local.length, W8_LOCAL_SETTLEMENT_SELECTION_LIMIT);
  assert.equal(selection.additionalLocal.length, W8_LOCAL_SETTLEMENT_SELECTION_LIMIT - 1);
  assert.equal(selection.excluded.length, 1);
  assert.equal(selection.excluded[0].tier, 'excluded');
  assert.equal(selection.excluded[0].selectedReason, 'local-limit');
  assert.equal(selection.remote.length, 0,
    'a local overflow is not relabeled as a remote Settlement');
});

test('multiple local Settlements materialize together and suppress only matching Near Stable IDs', async t => {
  const fixture = await createAdjacentTownPresentationFixture();
  const scene = new DistantTestGroup();
  let nearVisibleStableIds = [];
  const presentation = await fixture.createPresentation({
    scene,
    getNearVisibleStableIds: () => nearVisibleStableIds,
  });
  const input = {
    activeDataKeys: [],
    renderedKeys: [],
    getChunkData: () => null,
    renderOrigin: { renderOriginChunkX: 0, renderOriginChunkZ: 0, rebaseCount: 1 },
    centerChunkX: 0,
    centerChunkZ: 0,
    quality: 'high',
    renderDistancePreset: 'current',
    playerLogicalX: 0,
    playerLogicalZ: 0,
    includeFarNatural: false,
    includeUltraNatural: false,
  };
  assert.equal(await presentation.sync(input), true);
  let snapshot = presentation.snapshot({ includeSettlementSelectionDetails: true });
  assert.deepEqual(snapshot.localSettlementIds, fixture.candidates.map(
    candidate => candidate.settlementId,
  ).sort());
  assert.equal(snapshot.activeLocalSettlementId, 'settlement-v1:adjacent-town-east');
  assert.deepEqual(snapshot.additionalLocalSettlementIds, [
    'settlement-v1:adjacent-town-west',
  ]);
  assert.equal(snapshot.remoteHorizonMaterialCount, 1,
    'Current retains the B01 shared standby material for the active local Settlement');
  t.diagnostic(JSON.stringify({
    selections: snapshot.settlementSelections,
    audits: presentation.canonicalAuditSnapshot().filter(value => (
      fixture.stableIds.includes(value.identity.stableId)
    )),
  }));
  assert.deepEqual(snapshot.settlementSelections.map(value => ({
    settlementId: value.settlementId,
    tier: value.tier,
    selectedReason: value.selectedReason,
    buildingCount: value.buildingCount,
    stableIdSuppressionCount: value.stableIdSuppressionCount,
    visibleInstanceCount: value.visibleInstanceCount,
  })), [
    {
      settlementId: 'settlement-v1:adjacent-town-east',
      tier: 'active-local',
      selectedReason: 'nearest-local',
      buildingCount: 1,
      stableIdSuppressionCount: 0,
      visibleInstanceCount: 1,
    },
    {
      settlementId: 'settlement-v1:adjacent-town-west',
      tier: 'additional-local',
      selectedReason: 'within-local-band',
      buildingCount: 1,
      stableIdSuppressionCount: 0,
      visibleInstanceCount: 1,
    },
  ]);
  const initialAudit = presentation.canonicalAuditSnapshot().filter(value => (
    fixture.stableIds.includes(value.identity.stableId)
  ));
  assert.deepEqual(initialAudit.map(value => value.identity.stableId).sort(),
    [...fixture.stableIds].sort());
  assert.ok(initialAudit.every(value => value.visibleLod === 'far'
    && value.presentationTier === 'full'));
  const visibleStableIdOccurrences = () => {
    const occurrences = new Map();
    for (const mesh of scene.children[0].children[0].children) {
      if (!(mesh.count > 0)) continue;
      for (const stableId of mesh.userData.canonicalStableIds ?? []) {
        occurrences.set(stableId, (occurrences.get(stableId) ?? 0) + 1);
      }
    }
    return occurrences;
  };
  assert.deepEqual(fixture.stableIds.map(stableId => (
    visibleStableIdOccurrences().get(stableId)
  )), [1, 1]);

  nearVisibleStableIds = [fixture.stableIds[1]];
  assert.equal(presentation.update(0, 0, {
    renderOriginChunkX: 0, renderOriginChunkZ: 0, rebaseCount: 1,
  }), true);
  snapshot = presentation.snapshot({ includeSettlementSelectionDetails: true });
  const suppressed = snapshot.settlementSelections.find(value => (
    value.settlementId === fixture.candidates[1].settlementId
  ));
  assert.equal(suppressed.stableIdSuppressionCount, 1);
  assert.equal(suppressed.visibleInstanceCount, 0);
  assert.equal(visibleStableIdOccurrences().has(fixture.stableIds[1]), false);
  assert.equal(visibleStableIdOccurrences().get(fixture.stableIds[0]), 1,
    'Near suppression of one Building must not erase the additional Settlement');

  const identityBeforeRebase = presentation.canonicalAuditSnapshot().map(value => value.identity);
  assert.equal(presentation.update(0, 0, {
    renderOriginChunkX: 1, renderOriginChunkZ: 0, rebaseCount: 2,
  }), true);
  assert.deepEqual(presentation.canonicalAuditSnapshot().map(value => value.identity),
    identityBeforeRebase);
  assert.deepEqual(presentation.snapshot().currentOrigin, {
    renderOriginChunkX: 1,
    renderOriginChunkZ: 0,
  });

  nearVisibleStableIds = [];
  for (const renderDistancePreset of ['short', 'current']) {
    assert.equal(await presentation.sync({
      ...input,
      renderOrigin: { renderOriginChunkX: 1, renderOriginChunkZ: 0, rebaseCount: 2 },
      renderDistancePreset,
    }), true);
    snapshot = presentation.snapshot({ includeSettlementSelectionDetails: true });
    assert.equal(snapshot.localSettlementIds.length, 2);
    assert.equal(snapshot.settlementSelections.filter(value => (
      ['active-local', 'additional-local'].includes(value.tier)
    )).length, 2);
    assert.equal(snapshot.remoteHorizonMaterialCount,
      renderDistancePreset === 'current' ? 1 : 0);
  }
  presentation.dispose();
  assert.equal(scene.children.length, 0);
});

test('local Building Stable ID cross-fades deterministically through every preset handoff band', async t => {
  const fixture = await createAdjacentTownPresentationFixture();
  const scene = new DistantTestGroup();
  let nearVisibleStableIds = [];
  const visualAssets = createDistantTestVisualAssets();
  Object.assign(visualAssets.materials.houseWall, {
    transparent: true,
    opacity: 0.75,
    depthWrite: false,
  });
  const presentation = await fixture.createPresentation({
    scene,
    getNearVisibleStableIds: () => nearVisibleStableIds,
    visualAssets,
  });
  const targetStableId = fixture.stableIds[1];
  const targetBuildingX = fixture.candidates[1].center.x
    - fixture.candidates[1].radiusMeters;
  const inputFor = (presetId, distanceMeters) => ({
    activeDataKeys: [], renderedKeys: [], getChunkData: () => null,
    renderOrigin: { renderOriginChunkX: 0, renderOriginChunkZ: 0, rebaseCount: 1 },
    centerChunkX: 0, centerChunkZ: 0, quality: 'high',
    renderDistancePreset: presetId,
    playerLogicalX: targetBuildingX - distanceMeters,
    playerLogicalZ: 0,
    includeFarNatural: false,
    includeUltraNatural: false,
  });
  const expectedBands = {
    short: { start: 80.4, center: 84, end: 87.6 },
    standard: { start: 107.2, center: 112, end: 116.8 },
    current: { start: 134, center: 140, end: 146 },
  };
  const measured = {};
  for (const [presetId, band] of Object.entries(expectedBands)) {
    assert.equal(await presentation.sync(inputFor(presetId, band.center)), true);
    const samples = [
      ['ten-before', band.center - 10],
      ['start', band.start],
      ['center', band.center],
      ['end', band.end],
      ['ten-after', band.center + 10],
    ];
    const forward = [];
    for (const [label, distanceMeters] of samples) {
      assert.equal(presentation.update(targetBuildingX - distanceMeters, 0, {
        renderOriginChunkX: 0, renderOriginChunkZ: 0, rebaseCount: 1,
      }), true);
      const audit = presentation.canonicalAuditSnapshot().find(value => (
        value.identity.stableId === targetStableId
      ));
      assert.ok(audit?.stableIdHandoff);
      const handoff = audit.stableIdHandoff;
      assert.equal(handoff.stableId, targetStableId);
      assert.ok(Math.abs(handoff.distanceMeters - distanceMeters) < 1e-6);
      assert.equal(Number((handoff.fullOpacity + handoff.horizonOpacity).toFixed(6)), 1);
      assert.notEqual(handoff.fullOpacity === 0 && handoff.horizonOpacity === 0, true);
      assert.equal(handoff.remoteOpacity, 0);
      assert.equal(handoff.owner, audit.ownerKey);
      assert.equal(handoff.presentationOnly, true);
      assert.equal(handoff.gameplayRecord, true);
      if (label === 'center') {
        assert.equal(handoff.fullOpacity, 0.5);
        assert.equal(handoff.horizonOpacity, 0.5);
        assert.equal(handoff.fullInstanceCount, 1);
        assert.equal(handoff.horizonInstanceCount, 1);
        assert.equal(handoff.selectedTier, 'full-horizon-handoff');
      }
      forward.push(Object.freeze({ label, ...handoff }));
    }
    const reverse = [];
    for (const [label, distanceMeters] of [...samples].reverse()) {
      assert.equal(presentation.update(targetBuildingX - distanceMeters, 0, {
        renderOriginChunkX: 0, renderOriginChunkZ: 0, rebaseCount: 1,
      }), true);
      reverse.push(Object.freeze({
        label,
        ...presentation.canonicalAuditSnapshot().find(value => (
          value.identity.stableId === targetStableId
        )).stableIdHandoff,
      }));
    }
    assert.deepEqual(reverse, [...forward].reverse(),
      `${presetId} approach and retreat must produce identical handoff state`);
    measured[presetId] = forward;
  }

  assert.equal(await presentation.sync(inputFor('current', expectedBands.current.center)), true);
  const resourcesBefore = presentation.snapshot();
  const handoffMeshes = scene.children[0].children[0].children.filter(mesh => (
    mesh.material?.userData?.localBuildingHandoff === true
  ));
  const fullHandoffMaterial = handoffMeshes.find(mesh => (
    mesh.material.userData.localBuildingHandoffTier === 'full'
  )).material;
  const horizonHandoffMaterial = handoffMeshes.find(mesh => (
    mesh.material.userData.localBuildingHandoffTier === 'horizon'
  )).material;
  t.diagnostic(JSON.stringify({
    fullMaterial: {
      transparent: fullHandoffMaterial.transparent,
      opacity: fullHandoffMaterial.opacity,
      depthWrite: fullHandoffMaterial.depthWrite,
      alphaHash: fullHandoffMaterial.alphaHash,
    },
    sourceMaterial: {
      transparent: visualAssets.materials.houseWall.transparent,
      opacity: visualAssets.materials.houseWall.opacity,
      depthWrite: visualAssets.materials.houseWall.depthWrite,
      alphaHash: visualAssets.materials.houseWall.alphaHash,
    },
  }));
  assert.equal(fullHandoffMaterial.transparent, true);
  assert.equal(fullHandoffMaterial.opacity, 0.75);
  assert.equal(fullHandoffMaterial.depthWrite, false);
  assert.equal(fullHandoffMaterial.alphaHash, false);
  assert.equal(horizonHandoffMaterial.transparent, false);
  assert.equal(horizonHandoffMaterial.opacity, 1);
  assert.equal(horizonHandoffMaterial.depthWrite, true);
  assert.equal(horizonHandoffMaterial.alphaHash, true);
  assert.equal(visualAssets.materials.houseWall.onBeforeCompile, undefined,
    'handoff must not mutate the shared Near material');
  for (let pass = 0; pass < 20; pass += 1) {
    for (const distanceMeters of [130, 150, 130]) {
      assert.equal(presentation.update(targetBuildingX - distanceMeters, 0, {
        renderOriginChunkX: pass < 10 ? 0 : 1,
        renderOriginChunkZ: 0,
        rebaseCount: pass < 10 ? 1 : 2,
      }), true);
      const matching = presentation.canonicalAuditSnapshot().filter(value => (
        value.identity.stableId === targetStableId
      ));
      assert.equal(matching.length, 1, 'handoff uses one canonical Stable ID record');
      assert.ok(matching[0].stableIdHandoff);
    }
  }
  const resourcesAfter = presentation.snapshot();
  assert.equal(resourcesAfter.localBuildingHandoffMaterialCount,
    resourcesBefore.localBuildingHandoffMaterialCount);
  assert.equal(resourcesAfter.localBuildingHandoffMeshCount,
    resourcesBefore.localBuildingHandoffMeshCount);
  assert.equal(resourcesAfter.canonicalObjectCount, resourcesBefore.canonicalObjectCount);

  nearVisibleStableIds = [targetStableId];
  assert.equal(presentation.update(targetBuildingX - expectedBands.current.center, 0, {
    renderOriginChunkX: 1, renderOriginChunkZ: 0, rebaseCount: 2,
  }), true);
  const nearAudit = presentation.canonicalAuditSnapshot().find(value => (
    value.identity.stableId === targetStableId
  ));
  assert.equal(nearAudit.visibleLod, 'near');
  assert.equal(nearAudit.stableIdHandoff.fullInstanceCount, 0);
  assert.equal(nearAudit.stableIdHandoff.horizonInstanceCount, 0);
  assert.equal(presentation.snapshot().duplicateVisibleStableIdCount, 0);
  assert.equal(presentation.canonicalAuditSnapshot().some(value => (
    value.identity.stableId !== targetStableId && value.composedInstanceCount > 0
  )), true, 'Stable ID suppression must not erase the other local Settlement');

  nearVisibleStableIds = [];
  assert.equal(presentation.update(targetBuildingX - expectedBands.current.center, 0, {
    renderOriginChunkX: 1, renderOriginChunkZ: 0, rebaseCount: 2,
  }), true);
  const restoredHandoff = presentation.canonicalAuditSnapshot().find(value => (
    value.identity.stableId === targetStableId
  )).stableIdHandoff;
  assert.equal(restoredHandoff.fullOpacity, 0.5);
  assert.equal(restoredHandoff.horizonOpacity, 0.5);
  t.diagnostic(JSON.stringify({ bands: measured, resourcesBefore, resourcesAfter }));
  presentation.dispose();
  assert.equal(scene.children.length, 0);
});

test('a stale multi-local selection cannot replace the latest active-local priority', async () => {
  const fixture = await createAdjacentTownPresentationFixture();
  const pendingYields = [];
  let holdYields = false;
  const scene = new DistantTestGroup();
  const presentation = await fixture.createPresentation({
    scene,
    yieldToMainThread: () => holdYields
      ? new Promise(resolve => pendingYields.push(resolve))
      : Promise.resolve(),
  });
  const inputFor = playerLogicalX => ({
    activeDataKeys: [], renderedKeys: [], getChunkData: () => null,
    renderOrigin: { renderOriginChunkX: 0, renderOriginChunkZ: 0, rebaseCount: 1 },
    centerChunkX: 0, centerChunkZ: 0, quality: 'high',
    renderDistancePreset: 'current', playerLogicalX, playerLogicalZ: 0,
    includeFarNatural: false, includeUltraNatural: false,
  });
  assert.equal(await presentation.sync(inputFor(0)), true);
  const originalRoot = scene.children[0].children[0];
  holdYields = true;
  const stale = presentation.sync(inputFor(-50));
  await waitForControlledYield(pendingYields);
  const latest = presentation.sync(inputFor(50));
  const [staleResult, latestResult] = await drainControlledYields(
    [stale, latest],
    pendingYields,
    {
      whilePending() {
        assert.equal(scene.children[0].children.length, 1);
        assert.equal(scene.children[0].children[0], originalRoot);
      },
    },
  );
  assert.equal(staleResult, false);
  assert.equal(latestResult, true);
  const snapshot = presentation.snapshot({ includeSettlementSelectionDetails: true });
  assert.equal(snapshot.activeLocalSettlementId, 'settlement-v1:adjacent-town-east');
  assert.equal(snapshot.localSettlementIds.length, 2);
  assert.ok(snapshot.staleEpochDiscardCount >= 1);
  const latestEast = presentation.canonicalAuditSnapshot().find(value => (
    value.identity.stableId === fixture.stableIds[1]
  ));
  assert.equal(latestEast.stableIdHandoff.fullOpacity, 1,
    'the stale player position must not restore an older handoff state');
  assert.equal(latestEast.stableIdHandoff.horizonOpacity, 0);
  assert.notEqual(scene.children[0].children[0], originalRoot);
  presentation.dispose();
});

test('remote Settlement Horizon preserves every canonical Building Stable ID and yields per Building to Near ownership', async () => {
  const settlementId = 'settlement-v1:remote-horizon';
  const centerX = 401;
  const candidate = Object.freeze({
    settlementId,
    settlementType: 'RURAL',
    townType: 'suburb',
    center: Object.freeze({ x: centerX, z: 8 }),
    radiusMeters: 0,
  });
  const buildings = Object.freeze(Array.from({ length: 83 }, (_, index) => Object.freeze({
    stableId: `${settlementId}:building:${String(index).padStart(2, '0')}`,
    settlementId,
    buildingType: 'house',
    x: centerX - 33 + (index % 12) * 6,
    z: 8 - 24 + Math.floor(index / 12) * 8,
    rotationY: index * 0.05,
    widthMeters: 6,
    heightMeters: 4,
    depthMeters: 5,
  })));
  const template = Object.freeze({
    settlementId,
    settlementType: 'RURAL',
    townType: 'suburb',
    center: candidate.center,
    buildings,
    roads: Object.freeze([]),
  });
  const selected = selectRemoteHorizonBuildings({ template, quality: 'high' });
  assert.deepEqual(selected.map(value => value.stableId), buildings.map(value => value.stableId));
  const centerOwnerX = Math.floor(centerX / LEGACY_CHUNK_SIZE_METERS);
  const ownerChunk = canonicalChunk(centerOwnerX, 0, []);
  const factory = Object.freeze({
    stableId: `${settlementId}:landmark:factory`,
    parentSettlementId: settlementId,
    featureType: 'settlement-landmark',
    landmarkType: 'factory',
    worldPosition: Object.freeze({ x: centerX, y: 0.4, z: 8 }),
    rotationY: 0,
    widthMeters: 9,
    heightMeters: 8,
    depthMeters: 8,
    owningChunkCoordinate: Object.freeze({ x: centerOwnerX, z: 0 }),
  });
  ownerChunk.settlementLandmarks = [factory];
  ownerChunk.presentationLayers.landmarks = [factory];
  const scene = new DistantTestGroup();
  let nearStableIds = [];
  const destroyedStableIds = new Set();
  const presentation = await createW8DistantPresentation({
    THREE: DISTANT_TEST_THREE,
    scene,
    worldSeedHash: CANONICAL_WORLD_SEED_HASH,
    visualAssets: createDistantTestVisualAssets(),
    findSettlementsNear: async () => [candidate],
    resolveTemplate: async () => template,
    getCanonicalChunkData: async (chunkX, chunkZ) => (
      chunkX === centerOwnerX && chunkZ === 0
        ? ownerChunk : canonicalChunk(chunkX, chunkZ, [])
    ),
    getNearVisibleStableIds: () => nearStableIds,
    isFeatureDestroyed: stableId => destroyedStableIds.has(stableId),
  });
  assert.equal(await presentation.sync({
    activeDataKeys: [], renderedKeys: [], getChunkData: () => null,
    renderOrigin: { renderOriginChunkX: 0, renderOriginChunkZ: 0 },
    centerChunkX: 0, centerChunkZ: 0, quality: 'high',
    playerLogicalX: 8, playerLogicalZ: 8,
    includeFarNatural: false, includeUltraNatural: false,
  }), true);
  let snapshot = presentation.snapshot();
  assert.equal(snapshot.activeLocalSettlementId, null);
  assert.equal(snapshot.queryRemoteCandidateCount, 1);
  assert.equal(snapshot.queryRemoteSelectedCount, 1);
  assert.equal(snapshot.queryBuildingOwnerChunkCount, 0);
  assert.equal(snapshot.queryRemoteHorizonOwnerChunkCount, 1);
  assert.equal(snapshot.remoteHorizonSettlementCount, 1);
  assert.equal(snapshot.visibleRemoteHorizonSettlementCount, 1);
  assert.equal(snapshot.remoteHorizonCanonicalBuildingCount, buildings.length);
  assert.equal(snapshot.remoteHorizonBuildingCount, selected.length);
  assert.equal(snapshot.remoteHorizonMissingBuildingCount, 0);
  assert.equal(snapshot.remoteHorizonLandmarkCount, 1);
  assert.equal(snapshot.queryRadius, 875);
  assert.equal(snapshot.settlementMetadataQueryDistanceMeters, 875);
  assert.equal(snapshot.remoteHorizonFadeStartMeters, 187.5);
  assert.equal(snapshot.remoteHorizonFadeEndMeters, 875);
  assert.equal(snapshot.remoteHorizonHiddenDistanceMeters, 875);
  assert.equal(snapshot.remoteHorizonAtmosphereMode, 'manual-fog-blend');
  assert.equal(snapshot.remoteHorizonFogIntegrationEndMeters, 300);
  assert.ok(snapshot.remoteHorizonPartInstanceCount <= snapshot.queryRemotePartLimit);
  assert.ok(presentation.canonicalAuditSnapshot().every(object => object.remoteHorizon));
  assert.equal(presentation.canonicalAuditSnapshot().find(object => (
    object.identity.landmarkType === 'factory'
  )).identity.dimensions.heightMeters, 8);
  const remoteMeshes = scene.children[0].children[0].children.filter(child => (
    child.name.includes('remote-horizon')
  ));
  assert.ok(remoteMeshes.length > 0);
  assert.ok(remoteMeshes.every(mesh => mesh.material.fog === false));
  assert.ok(remoteMeshes.every(mesh => mesh.material.transparent === false));
  assert.ok(remoteMeshes.every(mesh => mesh.material.alphaHash === true));
  assert.ok(remoteMeshes.every(mesh => mesh.material.depthWrite === true));
  assert.equal(new Set(remoteMeshes.map(mesh => mesh.material)).size, 1);
  assert.equal(snapshot.remoteHorizonMaterialCount, 1);
  assert.equal(snapshot.remoteHorizonAtmosphereShaderEnabled, true);
  assert.ok(remoteMeshes.every(mesh => (
    mesh.geometry.attributes.w8RemoteAnchorXZ instanceof DistantTestInstancedBufferAttribute
  )));
  assert.ok(remoteMeshes.every(mesh => (
    mesh.geometry.attributes.w8RemoteSourceColor instanceof DistantTestInstancedBufferAttribute
  )));
  const remoteMaterial = remoteMeshes[0].material;
  const remoteUniforms = remoteMaterial.userData.remoteAtmosphereUniforms;
  assert.equal(remoteUniforms.w8RemoteFogColor.value.isColor, true);
  assert.ok(remoteUniforms.w8RemoteFogColor.value.r < (0x5d / 0xff));
  const compiledShader = {
    uniforms: {},
    vertexShader: 'void main() {\n#include <begin_vertex>\n}',
    fragmentShader: 'void main() {\n#include <color_fragment>\n}',
  };
  remoteMaterial.onBeforeCompile(compiledShader);
  assert.match(compiledShader.vertexShader, /attribute vec2 w8RemoteAnchorXZ/);
  assert.match(compiledShader.vertexShader, /attribute vec3 w8RemoteSourceColor/);
  assert.match(compiledShader.vertexShader, /vW8RemoteSourceColor = w8RemoteSourceColor/);
  assert.match(compiledShader.vertexShader, /vW8RemoteDistanceMeters = length/);
  assert.match(compiledShader.fragmentShader, /mix\(vW8RemoteSourceColor, w8RemoteFogColor/);
  assert.doesNotMatch(compiledShader.fragmentShader, /w8RemoteSilhouetteColor/);
  assert.match(compiledShader.fragmentShader, /diffuseColor\.a \*= w8RemoteOpacity/);
  assert.equal(remoteMaterial.customProgramCacheKey(), 'w8-remote-building-atmosphere-v2');
  const baselineIdentityById = new Map(presentation.canonicalAuditSnapshot()
    .filter(object => buildings.some(building => building.stableId === object.identity.stableId))
    .map(object => [object.identity.stableId, object.identity]));
  assert.equal(new Set([...baselineIdentityById.values()].map(identity => (
    `${identity.owningChunkCoordinate.x},${identity.owningChunkCoordinate.z}`
  ))).size > 1, true);
  for (const mesh of remoteMeshes) {
    mesh.boundingBox = { stale: true };
    mesh.boundingSphere = { stale: true };
  }
  presentation.update(centerX - 950, 8, {
    renderOriginChunkX: 0,
    renderOriginChunkZ: 0,
  });
  assert.ok(remoteMeshes.every(mesh => mesh.count === 0));
  assert.ok(remoteMeshes.every(mesh => mesh.boundingBox === null));
  assert.ok(remoteMeshes.every(mesh => mesh.boundingSphere === null));
  let previousVisibleIds = null;
  for (const mesh of remoteMeshes) {
    mesh.boundingBox = { stale: true };
    mesh.boundingSphere = { stale: true };
  }
  for (const distanceMeters of [800, 750, 500, 300, 200, 150, 100, 50]) {
    presentation.update(centerX - distanceMeters, 8, {
      renderOriginChunkX: 0,
      renderOriginChunkZ: 0,
    });
    if (distanceMeters === 800) {
      assert.ok(remoteMeshes.every(mesh => mesh.boundingBox === null));
      assert.ok(remoteMeshes.every(mesh => mesh.boundingSphere === null));
    }
    const visible = presentation.canonicalAuditSnapshot().filter(object => (
      baselineIdentityById.has(object.identity.stableId) && object.composedInstanceCount > 0
    ));
    const visibleIds = visible.map(object => object.identity.stableId).sort();
    assert.deepEqual(visibleIds, buildings.map(building => building.stableId));
    if (previousVisibleIds) assert.deepEqual(visibleIds, previousVisibleIds);
    previousVisibleIds = visibleIds;
    for (const object of visible) {
      assert.deepEqual(object.identity, baselineIdentityById.get(object.identity.stableId));
      assert.equal(object.presentationTier, 'remote-horizon');
    }
    const atmosphereSnapshot = presentation.snapshot({ includeRemoteHorizonAtmospheres: true });
    assert.equal(atmosphereSnapshot.remoteHorizonMaterialCount, 1);
    assert.equal(remoteMaterial.opacity, 1);
    for (const object of visible) {
      const atmosphere = atmosphereSnapshot
        .remoteHorizonBuildingAtmospheres[object.identity.stableId];
      const expectedDistance = Math.hypot(
        object.identity.worldPosition.x - (centerX - distanceMeters),
        object.identity.worldPosition.z - 8,
      );
      assert.equal(atmosphere.distanceMeters, expectedDistance);
      assert.deepEqual({
        visible: atmosphere.visible,
        opacity: atmosphere.opacity,
        fogBlend: atmosphere.fogBlend,
        contrast: atmosphere.contrast,
        colorHex: atmosphere.colorHex,
      }, resolveW8RemoteSettlementAtmosphere({
        boundaryDistanceMeters: expectedDistance,
        renderDistancePreset: 'current',
      }));
    }
  }
  nearStableIds = [buildings[0].stableId];
  presentation.update(centerX - 50, 8, {
    renderOriginChunkX: 0,
    renderOriginChunkZ: 0,
  });
  assert.equal(presentation.canonicalAuditSnapshot().filter(object => (
    baselineIdentityById.has(object.identity.stableId) && object.composedInstanceCount > 0
  )).length, buildings.length - 1);
  assert.equal(presentation.snapshot().visibleRemoteHorizonSettlementCount, 1);
  nearStableIds = [];
  destroyedStableIds.add(buildings[1].stableId);
  presentation.update(centerX - 50, 8, {
    renderOriginChunkX: 0,
    renderOriginChunkZ: 0,
  });
  assert.equal(presentation.canonicalAuditSnapshot().find(object => (
    object.identity.stableId === buildings[1].stableId
  )).visibleLod, 'destroyed');
  assert.equal(presentation.canonicalAuditSnapshot().filter(object => (
    baselineIdentityById.has(object.identity.stableId) && object.composedInstanceCount > 0
  )).length, buildings.length - 1);
  destroyedStableIds.clear();
  nearStableIds = buildings.map(value => value.stableId).concat(factory.stableId);
  assert.equal(presentation.commitRuntimeState({
    activeDataKeys: [`${centerOwnerX},0`],
    renderedKeys: [`${centerOwnerX},0`],
    renderOrigin: { renderOriginChunkX: centerOwnerX, renderOriginChunkZ: 0 },
    quality: 'high', playerLogicalX: centerX, playerLogicalZ: 8,
  }), true);
  snapshot = presentation.snapshot();
  assert.equal(snapshot.visibleRemoteHorizonSettlementCount, 0);
  assert.ok(snapshot.remoteHorizonSuppressedByNearCount > 0);
  assert.ok(remoteMeshes.every(mesh => mesh.count === 0));
  nearStableIds = [];
  assert.equal(presentation.commitRuntimeState({
    activeDataKeys: [], renderedKeys: [],
    renderOrigin: { renderOriginChunkX: centerOwnerX, renderOriginChunkZ: 0 },
    quality: 'high', playerLogicalX: 8, playerLogicalZ: 8,
  }), true);
  assert.equal(presentation.snapshot().visibleRemoteHorizonSettlementCount, 1);
  assert.ok(remoteMeshes.some(mesh => mesh.count > 0));
  presentation.dispose();
});

test('Remote Horizon carries canonical wall and roof tints per instance without multiplying materials', async () => {
  const settlementId = 'settlement-v1:remote-source-tints';
  const centerX = 401;
  const ownerX = Math.floor(centerX / LEGACY_CHUNK_SIZE_METERS);
  const wallPart = Object.freeze({
    ...CANONICAL_HOUSE_PART,
    material: 'houseWall',
    materialRole: 'wall',
  });
  const roofPart = Object.freeze({
    geometry: 'pyramid',
    material: 'houseRoof',
    position: Object.freeze([0, 0.9, 0]),
    scale: Object.freeze([1, 0.35, 1]),
    rotation: Object.freeze([0, 0, 0]),
    materialRole: 'roof',
  });
  const palettes = Object.freeze([
    Object.freeze({ wallColor: 0x9a8569, roofColor: 0x66615a, visualVariant: 'canonical-a' }),
    Object.freeze({ wallColor: 0xc2a06c, roofColor: 0x714238, visualVariant: 'canonical-b' }),
  ]);
  const buildings = Object.freeze(palettes.map((visual, index) => Object.freeze({
    stableId: index === 0
      ? 'settlement-building-v1:c0ad6ce14b0c8967945b4bbf'
      : `${settlementId}:building:${index}`,
    settlementId,
    buildingType: 'house',
    x: centerX + index * 12,
    z: 8 + index * 2,
    rotationY: index * 0.2,
    widthMeters: 6,
    heightMeters: 4,
    depthMeters: 5,
    visual,
  })));
  const candidate = Object.freeze({
    settlementId,
    settlementType: 'RURAL',
    townType: 'suburb',
    center: Object.freeze({ x: centerX, z: 8 }),
    radiusMeters: 12,
  });
  const template = Object.freeze({
    ...candidate,
    buildings,
    roads: Object.freeze([]),
  });
  const canonicalBuildings = buildings.map(building => Object.freeze({
    ...building,
    featureType: 'settlement-building',
    worldPosition: Object.freeze({ x: building.x, y: 0, z: building.z }),
    owningChunkCoordinate: Object.freeze({ x: ownerX, z: 0 }),
  }));
  const visualAssets = createDistantTestVisualAssets();
  visualAssets.geometries.pyramid = new DistantTestGeometry();
  visualAssets.materials.houseWall = new DistantTestMaterial({ color: new DistantTestColor(0xffffff) });
  visualAssets.materials.houseRoof = new DistantTestMaterial({ color: new DistantTestColor(0xffffff) });
  visualAssets.featureParts.house = [wallPart, roofPart];
  visualAssets.resolveBuildingParts = record => (
    record.buildingType === 'house' ? [wallPart, roofPart] : null
  );
  const scene = new DistantTestGroup();
  let nearStableIds = [];
  let includeRemoteCandidate = true;
  const presentation = await createW8DistantPresentation({
    THREE: DISTANT_TEST_THREE,
    scene,
    worldSeedHash: CANONICAL_WORLD_SEED_HASH,
    visualAssets,
    findSettlementsNear: async () => (includeRemoteCandidate ? [candidate] : []),
    resolveTemplate: async () => template,
    getCanonicalChunkData: async (chunkX, chunkZ) => canonicalChunk(
      chunkX,
      chunkZ,
      chunkX === ownerX && chunkZ === 0 ? canonicalBuildings : [],
    ),
    getNearVisibleStableIds: () => nearStableIds,
  });
  assert.equal(await presentation.sync({
    activeDataKeys: [], renderedKeys: [], getChunkData: () => null,
    renderOrigin: { renderOriginChunkX: 0, renderOriginChunkZ: 0 },
    centerChunkX: 0, centerChunkZ: 0, quality: 'high',
    playerLogicalX: 0, playerLogicalZ: 0,
    includeFarNatural: false, includeUltraNatural: false,
  }), true);
  const remoteMeshes = scene.children[0].children[0].children.filter(child => (
    child.name.includes('remote-horizon-building')
  ));
  assert.equal(remoteMeshes.length, 2);
  assert.equal(new Set(remoteMeshes.map(mesh => mesh.material)).size, 1);
  assert.equal(presentation.snapshot().remoteHorizonMaterialCount, 1);
  const assertPartTints = (mesh, role) => {
    const attribute = mesh.geometry.attributes.w8RemoteSourceColor;
    assert.equal(attribute.itemSize, 3);
    for (let slot = 0; slot < mesh.count; slot += 1) {
      const stableId = mesh.userData.canonicalStableIds[slot];
      const buildingIndex = buildings.findIndex(building => building.stableId === stableId);
      assert.notEqual(buildingIndex, -1);
      const expected = new DistantTestColor(palettes[buildingIndex][`${role}Color`]);
      const actual = attribute.values.slice(slot * 3, slot * 3 + 3);
      assert.ok(actual.every(Number.isFinite));
      for (const [componentIndex, expectedValue] of [expected.r, expected.g, expected.b].entries()) {
        assert.ok(Math.abs(actual[componentIndex] - expectedValue) < 1e-7);
      }
    }
  };
  assertPartTints(remoteMeshes.find(mesh => mesh.name.includes('-box-')), 'wall');
  assertPartTints(remoteMeshes.find(mesh => mesh.name.includes('-pyramid-')), 'roof');
  const auditById = new Map(presentation.canonicalAuditSnapshot().map(entry => (
    [entry.identity.stableId, entry]
  )));
  for (let index = 0; index < buildings.length; index += 1) {
    const audit = auditById.get(buildings[index].stableId);
    assert.equal(audit.presentationTier, 'remote-horizon');
    assert.deepEqual(audit.identity.visual, palettes[index]);
  }
  assert.notDeepEqual(
    [...remoteMeshes.find(mesh => mesh.name.includes('-box-'))
      .geometry.attributes.w8RemoteSourceColor.values.slice(0, 3)],
    [...remoteMeshes.find(mesh => mesh.name.includes('-pyramid-'))
      .geometry.attributes.w8RemoteSourceColor.values.slice(0, 3)],
  );
  const allocatedTintBytes = remoteMeshes.reduce((sum, mesh) => (
    sum + mesh.geometry.attributes.w8RemoteSourceColor.values.byteLength
  ), 0);
  assert.equal(
    allocatedTintBytes,
    buildings.length * 2 * 3 * Float32Array.BYTES_PER_ELEMENT,
  );
  includeRemoteCandidate = false;
  assert.equal(await presentation.sync({
    activeDataKeys: [`${ownerX},0`], renderedKeys: [],
    getChunkData: (chunkX, chunkZ) => (chunkX === ownerX && chunkZ === 0
      ? canonicalChunk(ownerX, 0, canonicalBuildings) : null),
    renderOrigin: { renderOriginChunkX: ownerX, renderOriginChunkZ: 0 },
    centerChunkX: ownerX, centerChunkZ: 0, quality: 'high',
    playerLogicalX: centerX, playerLogicalZ: 8,
    includeFarNatural: false, includeUltraNatural: false,
  }), true);
  const midAuditById = new Map(presentation.canonicalAuditSnapshot().map(entry => (
    [entry.identity.stableId, entry]
  )));
  for (let index = 0; index < buildings.length; index += 1) {
    const audit = midAuditById.get(buildings[index].stableId);
    assert.deepEqual(audit.identity.visual, palettes[index]);
    assert.notEqual(audit.presentationTier, 'remote-horizon');
  }
  nearStableIds = buildings.map(building => building.stableId);
  assert.equal(presentation.commitRuntimeState({
    activeDataKeys: [`${ownerX},0`], renderedKeys: [`${ownerX},0`],
    renderOrigin: { renderOriginChunkX: ownerX, renderOriginChunkZ: 0 },
    quality: 'high', playerLogicalX: centerX, playerLogicalZ: 8,
  }), true);
  const nearAuditById = new Map(presentation.canonicalAuditSnapshot().map(entry => (
    [entry.identity.stableId, entry]
  )));
  for (let index = 0; index < buildings.length; index += 1) {
    assert.deepEqual(nearAuditById.get(buildings[index].stableId).identity.visual, palettes[index]);
  }
  presentation.dispose();
});

test('Current remote Settlements share one material while keeping Building atmosphere independent', async () => {
  const candidates = [300, 700].map((x, index) => Object.freeze({
    settlementId: `settlement-v1:atmosphere-${index}`,
    settlementType: 'RURAL',
    townType: 'suburb',
    center: Object.freeze({ x, z: 0 }),
    radiusMeters: 0,
  }));
  const templateFor = candidate => Object.freeze({
    settlementId: candidate.settlementId,
    settlementType: candidate.settlementType,
    townType: candidate.townType,
    center: candidate.center,
    buildings: Object.freeze([Object.freeze({
      stableId: `${candidate.settlementId}:building:0`,
      settlementId: candidate.settlementId,
      buildingType: 'house',
      x: candidate.center.x,
      z: candidate.center.z,
      rotationY: 0,
      widthMeters: 6,
      heightMeters: 4,
      depthMeters: 5,
    })]),
    roads: Object.freeze([]),
  });
  const scene = new DistantTestGroup();
  const presentation = await createW8DistantPresentation({
    THREE: DISTANT_TEST_THREE,
    scene,
    worldSeedHash: CANONICAL_WORLD_SEED_HASH,
    visualAssets: createDistantTestVisualAssets(),
    findSettlementsNear: async () => candidates,
    resolveTemplate: async ({ candidate }) => templateFor(candidate),
    getCanonicalChunkData: async (chunkX, chunkZ) => canonicalChunk(chunkX, chunkZ, []),
  });
  assert.equal(await presentation.sync({
    activeDataKeys: [], renderedKeys: [], getChunkData: () => null,
    renderOrigin: { renderOriginChunkX: 0, renderOriginChunkZ: 0 },
    centerChunkX: 0, centerChunkZ: 0, quality: 'high',
    renderDistancePreset: 'current',
    playerLogicalX: 0, playerLogicalZ: 0,
    includeFarNatural: false, includeUltraNatural: false,
  }), true);
  const remoteMeshes = scene.children[0].children[0].children.filter(child => (
    child.name.includes('remote-horizon')
  ));
  assert.equal(remoteMeshes.length, 1);
  const [sharedMesh] = remoteMeshes;
  assert.deepEqual(sharedMesh.userData.remoteSettlementIds, candidates.map(
    candidate => candidate.settlementId,
  ));
  assert.equal(sharedMesh.geometry.attributes.w8RemoteAnchorXZ.values.length, 4);
  assert.deepEqual(presentation.snapshot().remoteHorizonBuildingAtmospheres, {});
  let atmosphereSnapshot = presentation.snapshot({ includeRemoteHorizonAtmospheres: true });
  assert.equal(atmosphereSnapshot.remoteHorizonMaterialCount, 1);
  assert.equal(atmosphereSnapshot.remoteHorizonMeshCount, 1);
  assert.equal(atmosphereSnapshot.remoteHorizonVisibleMeshCount, 1);
  assert.equal(atmosphereSnapshot.remoteHorizonAtmosphereShaderEnabled, true);
  let atmospheres = atmosphereSnapshot.remoteHorizonBuildingAtmospheres;
  const nearStableId = `${candidates[0].settlementId}:building:0`;
  const farStableId = `${candidates[1].settlementId}:building:0`;
  assert.ok(atmospheres[nearStableId].opacity > atmospheres[farStableId].opacity);
  assert.notEqual(atmospheres[nearStableId].colorHex, atmospheres[farStableId].colorHex);
  assert.equal(sharedMesh.material.opacity, 1);

  presentation.update(-200, 0, { renderOriginChunkX: 0, renderOriginChunkZ: 0 });
  atmosphereSnapshot = presentation.snapshot({ includeRemoteHorizonAtmospheres: true });
  atmospheres = atmosphereSnapshot.remoteHorizonBuildingAtmospheres;
  assert.ok(atmospheres[nearStableId].opacity > 0);
  assert.equal(atmospheres[farStableId].opacity, 0);
  assert.equal(sharedMesh.count, 1);
  assert.deepEqual(sharedMesh.userData.canonicalStableIds, [nearStableId]);
  assert.deepEqual(sharedMesh.userData.remoteSettlementIds, [candidates[0].settlementId]);
  assert.equal(sharedMesh.material.opacity, 1);
  assert.equal(atmosphereSnapshot.remoteHorizonVisibleMeshCount, 1);
  presentation.dispose();
});

test('rounded-zero remote opacity removes the Building instance and survives preset churn', async t => {
  const settlementId = 'settlement-v1:rounded-opacity-boundary';
  const stableId = `${settlementId}:building:0`;
  const candidate = Object.freeze({
    settlementId,
    settlementType: 'RURAL',
    townType: 'suburb',
    center: Object.freeze({ x: 500, z: 0 }),
    radiusMeters: 0,
  });
  const template = Object.freeze({
    settlementId,
    settlementType: candidate.settlementType,
    townType: candidate.townType,
    center: candidate.center,
    buildings: Object.freeze([Object.freeze({
      stableId,
      settlementId,
      buildingType: 'house',
      x: candidate.center.x,
      z: candidate.center.z,
      rotationY: 0,
      widthMeters: 6,
      heightMeters: 4,
      depthMeters: 5,
    })]),
    roads: Object.freeze([]),
  });
  const scene = new DistantTestGroup();
  const presentation = await createW8DistantPresentation({
    THREE: DISTANT_TEST_THREE,
    scene,
    worldSeedHash: CANONICAL_WORLD_SEED_HASH,
    visualAssets: createDistantTestVisualAssets(),
    findSettlementsNear: async () => [candidate],
    resolveTemplate: async () => template,
    getCanonicalChunkData: async (chunkX, chunkZ) => canonicalChunk(chunkX, chunkZ, []),
  });
  const syncInput = renderDistancePreset => ({
    activeDataKeys: [], renderedKeys: [], getChunkData: () => null,
    renderOrigin: { renderOriginChunkX: 0, renderOriginChunkZ: 0 },
    centerChunkX: 0, centerChunkZ: 0, quality: 'high',
    renderDistancePreset,
    playerLogicalX: 0, playerLogicalZ: 0,
    includeFarNatural: false, includeUltraNatural: false,
  });
  assert.equal(await presentation.sync(syncInput('current')), true);
  const remoteMesh = () => scene.children[0].children[0].children.find(child => (
    child.name.includes('remote-horizon')
  ));
  const boundary = [];
  for (const distanceMeters of [874, 874.5, 874.9, 875, 875.1]) {
    presentation.update(candidate.center.x - distanceMeters, 0, {
      renderOriginChunkX: 0,
      renderOriginChunkZ: 0,
    });
    const snapshot = presentation.snapshot({ includeRemoteHorizonAtmospheres: true });
    const atmosphere = snapshot.remoteHorizonBuildingAtmospheres[stableId];
    const instanceCount = remoteMesh().userData.canonicalStableIds.filter(value => (
      value === stableId
    )).length;
    boundary.push(Object.freeze({
      distanceMeters,
      opacity: atmosphere.opacity,
      visible: atmosphere.visible,
      instanceCount,
    }));
    assert.equal(atmosphere.visible, atmosphere.opacity > 0);
    assert.equal(instanceCount, atmosphere.visible ? 1 : 0);
  }
  assert.deepEqual(boundary, [
    { distanceMeters: 874, opacity: 0.000003, visible: true, instanceCount: 1 },
    { distanceMeters: 874.5, opacity: 0.000001, visible: true, instanceCount: 1 },
    { distanceMeters: 874.9, opacity: 0, visible: false, instanceCount: 0 },
    { distanceMeters: 875, opacity: 0, visible: false, instanceCount: 0 },
    { distanceMeters: 875.1, opacity: 0, visible: false, instanceCount: 0 },
  ]);

  for (let switchIndex = 0; switchIndex < 20; switchIndex += 1) {
    const previousRemoteMesh = remoteMesh();
    const renderDistancePreset = switchIndex % 2 === 0 ? 'short' : 'current';
    assert.equal(await presentation.sync(syncInput(renderDistancePreset)), true);
    if (previousRemoteMesh) {
      assert.equal(previousRemoteMesh.material.disposed, true);
      assert.equal(previousRemoteMesh.geometry.disposed, true);
    }
    const snapshot = presentation.snapshot();
    assert.equal(snapshot.remoteHorizonMaterialCount,
      renderDistancePreset === 'current' ? 1 : 0);
    assert.equal(scene.children[0].children.filter(child => (
      child.name.startsWith('w8-distant-presentation-epoch-')
    )).length, 1);
  }
  const finalRemoteMesh = remoteMesh();
  assert.ok(finalRemoteMesh);
  t.diagnostic(JSON.stringify(boundary));
  presentation.dispose();
  assert.equal(finalRemoteMesh.material.disposed, true);
  assert.equal(finalRemoteMesh.geometry.disposed, true);
  assert.equal(scene.children.length, 0);
});

test('large remote Settlement fades its near, center, and far Buildings independently', async () => {
  const settlementId = 'settlement-v1:wide-atmosphere';
  const radiusMeters = 121.5;
  const centerX = 187.5 + radiusMeters;
  const nearBuilding = Object.freeze({
    stableId: `${settlementId}:building:near`,
    settlementId,
    buildingType: 'house',
    x: centerX - radiusMeters,
    z: 0,
    rotationY: 0,
    widthMeters: 6,
    heightMeters: 4,
    depthMeters: 5,
  });
  const centerBuilding = Object.freeze({
    ...nearBuilding,
    stableId: `${settlementId}:building:center`,
    x: centerX,
  });
  const farBuilding = Object.freeze({
    ...nearBuilding,
    stableId: `${settlementId}:building:far`,
    x: centerX + radiusMeters,
  });
  const candidate = Object.freeze({
    settlementId,
    settlementType: 'CITY',
    townType: 'capital',
    center: Object.freeze({ x: centerX, z: 0 }),
    radiusMeters,
  });
  const template = Object.freeze({
    settlementId,
    settlementType: candidate.settlementType,
    townType: candidate.townType,
    center: candidate.center,
    buildings: Object.freeze([nearBuilding, centerBuilding, farBuilding]),
    roads: Object.freeze([]),
  });
  const scene = new DistantTestGroup();
  const presentation = await createW8DistantPresentation({
    THREE: DISTANT_TEST_THREE,
    scene,
    worldSeedHash: CANONICAL_WORLD_SEED_HASH,
    visualAssets: createDistantTestVisualAssets(),
    findSettlementsNear: async () => [candidate],
    resolveTemplate: async () => template,
    getCanonicalChunkData: async (chunkX, chunkZ) => canonicalChunk(chunkX, chunkZ, []),
  });
  assert.equal(await presentation.sync({
    activeDataKeys: [], renderedKeys: [], getChunkData: () => null,
    renderOrigin: { renderOriginChunkX: 0, renderOriginChunkZ: 0 },
    centerChunkX: 0, centerChunkZ: 0, quality: 'high',
    renderDistancePreset: 'current',
    playerLogicalX: 0, playerLogicalZ: 0,
    includeFarNatural: false, includeUltraNatural: false,
  }), true);
  const sharedMesh = scene.children[0].children[0].children.find(mesh => (
    mesh.userData.canonicalStableIds?.includes(nearBuilding.stableId)
      && mesh.userData.canonicalStableIds.includes(centerBuilding.stableId)
      && mesh.userData.canonicalStableIds.includes(farBuilding.stableId)
  ));
  assert.ok(sharedMesh);
  const snapshot = presentation.snapshot({ includeRemoteHorizonAtmospheres: true });
  assert.equal(snapshot.remoteHorizonMaterialCount, 1);
  assert.equal(snapshot.remoteHorizonMeshCount, 1);
  assert.equal(sharedMesh.material.opacity, 1);
  const remoteAnchorValues = sharedMesh.geometry.attributes.w8RemoteAnchorXZ.values;
  assert.equal(remoteAnchorValues.length, 6);
  const remoteAnchorFor = stableId => {
    const instanceIndex = sharedMesh.userData.canonicalStableIds.indexOf(stableId);
    assert.notEqual(instanceIndex, -1);
    return Object.freeze({
      localRenderX: remoteAnchorValues[instanceIndex * 2],
      localRenderZ: remoteAnchorValues[instanceIndex * 2 + 1],
    });
  };
  const buildings = [nearBuilding, centerBuilding, farBuilding];
  const actual = buildings.map(building => (
    snapshot.remoteHorizonBuildingAtmospheres[building.stableId]
  ));
  for (let index = 0; index < buildings.length; index += 1) {
    const building = buildings[index];
    const atmosphere = actual[index];
    const expected = resolveW8RemoteSettlementAtmosphere({
      boundaryDistanceMeters: building.x,
      renderDistancePreset: 'current',
    });
    assert.deepEqual({
      visible: atmosphere.visible,
      opacity: atmosphere.opacity,
      fogBlend: atmosphere.fogBlend,
      contrast: atmosphere.contrast,
      colorHex: atmosphere.colorHex,
    }, expected);
    const anchor = remoteAnchorFor(building.stableId);
    const shaderDistanceMeters = Math.hypot(
      anchor.localRenderX - snapshot.remoteHorizonPlayerLocalXZ.x,
      anchor.localRenderZ - snapshot.remoteHorizonPlayerLocalXZ.y,
    ) / (RENDER_CHUNK_SIZE / LEGACY_CHUNK_SIZE_METERS);
    assert.equal(shaderDistanceMeters, atmosphere.distanceMeters);
  }
  assert.equal(actual[0].distanceMeters, 187.5);
  assert.equal(actual[0].opacity, 1);
  assert.ok(actual[0].opacity > actual[1].opacity);
  assert.ok(actual[1].opacity > actual[2].opacity);
  assert.ok(actual[0].fogBlend < actual[1].fogBlend);
  assert.ok(actual[1].fogBlend < actual[2].fogBlend);
  assert.equal(actual[2].distanceMeters, 430.5);
  assert.equal(actual[2].opacity, 0.243279);
  const anchorsBeforeRebase = [...remoteAnchorValues];
  presentation.update(16, 0, { renderOriginChunkX: 1, renderOriginChunkZ: 0 });
  const rebasedSnapshot = presentation.snapshot({ includeRemoteHorizonAtmospheres: true });
  assert.deepEqual([...remoteAnchorValues], anchorsBeforeRebase);
  assert.deepEqual(rebasedSnapshot.remoteHorizonPlayerLocalXZ, {
    x: RENDER_CHUNK_SIZE,
    y: 0,
  });
  for (const building of buildings) {
    assert.equal(
      rebasedSnapshot.remoteHorizonBuildingAtmospheres[building.stableId].distanceMeters,
      Math.abs(building.x - 16),
    );
  }
  presentation.dispose();
});

test('remote Settlement material and draw buckets do not scale with candidate count', async t => {
  const results = [];
  const performanceResults = [];
  for (const candidateCount of [1, 2, 4, 8]) {
    const candidates = Object.freeze(Array.from({ length: candidateCount }, (_, index) => {
      const settlementId = `settlement-v1:shared-material-${index}`;
      return Object.freeze({
        settlementId,
        settlementType: 'RURAL',
        townType: 'suburb',
        center: Object.freeze({ x: 250 + index * 70, z: 0 }),
        radiusMeters: 0,
      });
    }));
    const scene = new DistantTestGroup();
    const presentation = await createW8DistantPresentation({
      THREE: DISTANT_TEST_THREE,
      scene,
      worldSeedHash: CANONICAL_WORLD_SEED_HASH,
      visualAssets: createDistantTestVisualAssets(),
      findSettlementsNear: async () => candidates,
      resolveTemplate: async ({ candidate }) => Object.freeze({
        settlementId: candidate.settlementId,
        settlementType: candidate.settlementType,
        townType: candidate.townType,
        center: candidate.center,
        buildings: Object.freeze([Object.freeze({
          stableId: `${candidate.settlementId}:building:0`,
          settlementId: candidate.settlementId,
          buildingType: 'house',
          x: candidate.center.x,
          z: candidate.center.z,
          rotationY: 0,
          widthMeters: 6,
          heightMeters: 4,
          depthMeters: 5,
        })]),
        roads: Object.freeze([]),
      }),
      getCanonicalChunkData: async (chunkX, chunkZ) => canonicalChunk(chunkX, chunkZ, []),
    });
    const syncInput = {
      activeDataKeys: [], renderedKeys: [], getChunkData: () => null,
      renderOrigin: { renderOriginChunkX: 0, renderOriginChunkZ: 0 },
      centerChunkX: 0, centerChunkZ: 0, quality: 'high',
      renderDistancePreset: 'current',
      playerLogicalX: 0, playerLogicalZ: 0,
      includeFarNatural: false, includeUltraNatural: false,
    };
    const syncDurations = [];
    const maximumSlices = [];
    for (let run = 0; run < 5; run += 1) {
      const startedAt = performance.now();
      assert.equal(await presentation.sync(syncInput), true);
      syncDurations.push(performance.now() - startedAt);
      maximumSlices.push(presentation.snapshot().farLastMaximumSliceMs);
    }
    const remoteMeshes = scene.children[0].children[0].children.filter(child => (
      child.name.includes('remote-horizon')
    ));
    const snapshot = presentation.snapshot();
    const selectedCount = Math.min(candidateCount, 4);
    results.push(Object.freeze({
      candidateCount,
      selectedCount: snapshot.queryRemoteSelectedCount,
      materialCount: new Set(remoteMeshes.map(mesh => mesh.material)).size,
      meshCount: remoteMeshes.length,
      drawCallEquivalent: remoteMeshes.filter(mesh => (
        mesh.visible !== false && mesh.count > 0
      )).length,
      instanceCount: remoteMeshes.reduce((sum, mesh) => sum + mesh.count, 0),
    }));
    assert.equal(snapshot.queryRemoteSelectedCount, selectedCount);
    assert.equal(snapshot.remoteHorizonMaterialCount, 1);
    assert.equal(snapshot.remoteHorizonMeshCount, 1);
    assert.equal(snapshot.remoteHorizonVisibleMeshCount, 1);
    assert.equal(remoteMeshes.length, 1);
    assert.equal(remoteMeshes[0].count, selectedCount);
    const sortedDurations = [...syncDurations].sort((left, right) => left - right);
    const snapshotStartedAt = performance.now();
    for (let sample = 0; sample < 100; sample += 1) {
      presentation.snapshot({ includeSettlementSelectionDetails: true });
    }
    performanceResults.push(Object.freeze({
      candidateCount,
      syncMeanMs: Number((syncDurations.reduce((sum, value) => sum + value, 0)
        / syncDurations.length).toFixed(3)),
      syncP95Ms: Number(sortedDurations[Math.ceil(sortedDurations.length * 0.95) - 1].toFixed(3)),
      syncMaxMs: Number(Math.max(...syncDurations).toFixed(3)),
      maximumSliceMs: Number(Math.max(...maximumSlices).toFixed(3)),
      snapshotMeanMs: Number(((performance.now() - snapshotStartedAt) / 100).toFixed(6)),
    }));
    const remoteMaterial = remoteMeshes[0].material;
    const remoteGeometry = remoteMeshes[0].geometry;
    presentation.dispose();
    assert.equal(remoteMaterial.disposed, true);
    assert.equal(remoteGeometry.disposed, true);
    assert.equal(scene.children.length, 0);
  }
  assert.deepEqual(results, [
    { candidateCount: 1, selectedCount: 1, materialCount: 1, meshCount: 1,
      drawCallEquivalent: 1, instanceCount: 1 },
    { candidateCount: 2, selectedCount: 2, materialCount: 1, meshCount: 1,
      drawCallEquivalent: 1, instanceCount: 2 },
    { candidateCount: 4, selectedCount: 4, materialCount: 1, meshCount: 1,
      drawCallEquivalent: 1, instanceCount: 4 },
    { candidateCount: 8, selectedCount: 4, materialCount: 1, meshCount: 1,
      drawCallEquivalent: 1, instanceCount: 4 },
  ]);
  t.diagnostic(JSON.stringify({ resources: results, performance: performanceResults }));
});

test('multi-local Settlement buckets stay shared as selected candidate count grows', async t => {
  const results = [];
  for (const candidateCount of [1, 2, 4, 8]) {
    const candidates = [];
    const templates = new Map();
    const recordsByOwner = new Map();
    const stableIds = new Set();
    for (let index = 0; index < candidateCount; index += 1) {
      const angle = 0.17 + index * Math.PI * 2 / candidateCount;
      const settlementId = `settlement-v1:local-scaling-${index}`;
      const stableId = `${settlementId}:building:0`;
      const center = Object.freeze({
        x: Math.cos(angle) * 140,
        z: Math.sin(angle) * 140,
      });
      const building = Object.freeze({
        stableId,
        settlementId,
        buildingType: 'house',
        x: Math.cos(angle) * 112,
        z: Math.sin(angle) * 112,
        rotationY: angle,
        widthMeters: 6,
        heightMeters: 4,
        depthMeters: 5,
      });
      const owner = determineDetailCandidateOwner(building);
      const ownerKey = `${owner.x},${owner.z}`;
      const record = Object.freeze({
        ...building,
        featureType: 'settlement-building',
        worldPosition: Object.freeze({ x: building.x, y: 1, z: building.z }),
        visual: null,
        owningChunkCoordinate: Object.freeze(owner),
        lodPolicy: Object.freeze({
          near: Object.freeze({ ownerSet: 'rendered', presentationTier: 'full' }),
          outer: Object.freeze({ ownerSet: 'active', presentationTier: 'full' }),
          far: Object.freeze({ ownerSet: 'queried', presentationTier: 'horizon' }),
          presentationTiers: Object.freeze(['full', 'horizon']),
        }),
      });
      candidates.push(Object.freeze({
        settlementId,
        settlementType: 'TOWN',
        townType: 'church_town',
        center,
        radiusMeters: 70,
      }));
      templates.set(settlementId, Object.freeze({
        settlementId,
        settlementType: 'TOWN',
        townType: 'church_town',
        center,
        buildings: Object.freeze([building]),
        roads: Object.freeze([]),
      }));
      if (!recordsByOwner.has(ownerKey)) recordsByOwner.set(ownerKey, []);
      recordsByOwner.get(ownerKey).push(record);
      stableIds.add(stableId);
    }
    const scene = new DistantTestGroup();
    const presentation = await createW8DistantPresentation({
      THREE: DISTANT_TEST_THREE,
      scene,
      worldSeedHash: CANONICAL_WORLD_SEED_HASH,
      visualAssets: createDistantTestVisualAssets(),
      findSettlementsNear: async () => candidates,
      resolveTemplate: async ({ candidate }) => templates.get(candidate.settlementId),
      getCanonicalChunkData: async (chunkX, chunkZ) => canonicalChunk(
        chunkX,
        chunkZ,
        recordsByOwner.get(`${chunkX},${chunkZ}`) ?? [],
      ),
    });
    const syncInput = {
      activeDataKeys: [], renderedKeys: [], getChunkData: () => null,
      renderOrigin: { renderOriginChunkX: 0, renderOriginChunkZ: 0 },
      centerChunkX: 0, centerChunkZ: 0, quality: 'high',
      renderDistancePreset: 'standard',
      playerLogicalX: 0, playerLogicalZ: 0,
      includeFarNatural: false, includeUltraNatural: false,
    };
    const syncDurations = [];
    const maximumSlices = [];
    for (let run = 0; run < 3; run += 1) {
      const startedAt = performance.now();
      assert.equal(await presentation.sync(syncInput), true);
      syncDurations.push(performance.now() - startedAt);
      maximumSlices.push(presentation.snapshot().farLastMaximumSliceMs);
    }
    const snapshot = presentation.snapshot({ includeSettlementSelectionDetails: true });
    const canonicalBuildingMeshes = scene.children[0].children[0].children.filter(mesh => (
      mesh.name.startsWith('w8-canonical-lod-')
        && (mesh.name.includes('building') || mesh.name.includes('horizon'))
    ));
    const visibleMeshes = canonicalBuildingMeshes.filter(mesh => (
      mesh.visible !== false && mesh.count > 0
    ));
    const sortedDurations = [...syncDurations].sort((left, right) => left - right);
    const snapshotStartedAt = performance.now();
    for (let sample = 0; sample < 100; sample += 1) {
      presentation.snapshot({ includeSettlementSelectionDetails: true });
    }
    const result = Object.freeze({
      candidateCount,
      selectedLocalCount: snapshot.localSettlementIds.length,
      materialCount: new Set(canonicalBuildingMeshes.map(mesh => mesh.material)).size,
      meshCount: canonicalBuildingMeshes.length,
      drawCallEquivalent: visibleMeshes.length,
      instanceCount: visibleMeshes.reduce((sum, mesh) => sum + mesh.count, 0),
      syncMeanMs: Number((syncDurations.reduce((sum, value) => sum + value, 0)
        / syncDurations.length).toFixed(3)),
      syncP95Ms: Number(sortedDurations[Math.ceil(sortedDurations.length * 0.95) - 1].toFixed(3)),
      syncMaxMs: Number(Math.max(...syncDurations).toFixed(3)),
      maximumSliceMs: Number(Math.max(...maximumSlices).toFixed(3)),
      snapshotMeanMs: Number(((performance.now() - snapshotStartedAt) / 100).toFixed(6)),
    });
    results.push(result);
    assert.equal(result.selectedLocalCount, candidateCount);
    assert.equal(snapshot.additionalLocalSettlementIds.length, candidateCount - 1);
    assert.equal(snapshot.remoteHorizonMaterialCount, 0);
    assert.equal(snapshot.settlementSelections.every(selection => (
      selection.presentationStableIdCount === 1
        && selection.stableIdSuppressionCount === 0
        && selection.visibleInstanceCount === 2
    )), true);
    assert.deepEqual(new Set(presentation.canonicalAuditSnapshot()
      .map(value => value.identity.stableId)
      .filter(stableId => stableIds.has(stableId))), stableIds);
    const ownedHandoffMaterials = new Set(canonicalBuildingMeshes.map(mesh => mesh.material));
    const ownedHandoffGeometries = new Set(canonicalBuildingMeshes.map(mesh => mesh.geometry));
    presentation.dispose();
    assert.equal([...ownedHandoffMaterials].every(material => material.disposed === true), true);
    assert.equal([...ownedHandoffGeometries].every(geometry => geometry.disposed === true), true);
    assert.equal(scene.children.length, 0);
  }
  assert.deepEqual(results.map(({ candidateCount, selectedLocalCount, materialCount,
    meshCount, drawCallEquivalent, instanceCount }) => ({
    candidateCount, selectedLocalCount, materialCount, meshCount,
    drawCallEquivalent, instanceCount,
  })), [
    { candidateCount: 1, selectedLocalCount: 1, materialCount: 2, meshCount: 2,
      drawCallEquivalent: 2, instanceCount: 2 },
    { candidateCount: 2, selectedLocalCount: 2, materialCount: 2, meshCount: 2,
      drawCallEquivalent: 2, instanceCount: 4 },
    { candidateCount: 4, selectedLocalCount: 4, materialCount: 2, meshCount: 2,
      drawCallEquivalent: 2, instanceCount: 8 },
    { candidateCount: 8, selectedLocalCount: 8, materialCount: 2, meshCount: 2,
      drawCallEquivalent: 2, instanceCount: 16 },
  ]);
  t.diagnostic(JSON.stringify(results));
});

test('Near Stable IDs suppress the matching Distant representation before duplicate composition', async () => {
  const presentation = await createW8DistantPresentation({
    THREE: DISTANT_TEST_THREE,
    scene: new DistantTestGroup(),
    worldSeedHash: CANONICAL_WORLD_SEED_HASH,
    visualAssets: createDistantTestVisualAssets(),
    findSettlementsNear: async () => [CANONICAL_CANDIDATE],
    resolveTemplate: async () => CANONICAL_TEMPLATE,
    getCanonicalChunkData: async (chunkX, chunkZ) => (
      chunkX === 5 && chunkZ === 0 ? canonicalChunk() : null
    ),
    getNearVisibleStableIds: () => [CANONICAL_BUILDING_ID],
  });
  assert.equal(await presentation.sync(canonicalSyncInput({
    centerChunkX: 0, activeDataKeys: [], renderedKeys: [], quality: 'medium',
  })), true);
  assert.equal(presentation.snapshot().duplicateVisibleStableIdCount, 0);
  assert.deepEqual(presentation.snapshot().duplicateVisibleStableIds, []);
  assert.equal(presentation.canonicalAuditSnapshot()[0].composedInstanceCount, 0);
  assert.equal(presentation.commitRuntimeState({
    activeDataKeys: ['5,0'], renderedKeys: ['5,0'],
    renderOrigin: { renderOriginChunkX: 4, renderOriginChunkZ: 0 },
    quality: 'medium', playerLogicalX: 72, playerLogicalZ: 8,
  }), true);
  assert.equal(presentation.snapshot().duplicateVisibleStableIdCount, 0);
  assert.equal(presentation.canonicalAuditSnapshot()[0].composedInstanceCount, 0);
  presentation.dispose();
});

test('High and Medium keep every remote Building while reducing only silhouette parts', async () => {
  const settlementId = 'settlement-v1:quality-silhouette';
  const candidate = Object.freeze({
    settlementId,
    settlementType: 'TOWN',
    townType: 'church_town',
    center: Object.freeze({ x: 401, z: 8 }),
  });
  const buildings = Object.freeze(Array.from({ length: 12 }, (_, index) => Object.freeze({
    stableId: `${settlementId}:building:${index}`,
    settlementId,
    buildingType: 'house',
    x: 390 + index * 2,
    z: 8 + index % 3,
    rotationY: index * 0.1,
    widthMeters: 6,
    heightMeters: 4,
    depthMeters: 5,
  })));
  const template = Object.freeze({
    settlementId,
    settlementType: 'TOWN',
    townType: 'church_town',
    center: candidate.center,
    buildings,
    roads: Object.freeze([]),
  });
  const roof = Object.freeze({
    ...CANONICAL_HOUSE_PART,
    position: Object.freeze([0, 1.1, 0]),
    scale: Object.freeze([1, 0.25, 1]),
    materialRole: 'roof',
  });
  const run = async quality => {
    const assets = createDistantTestVisualAssets();
    assets.featureParts.house = [CANONICAL_HOUSE_PART, roof];
    assets.resolveBuildingParts = () => [CANONICAL_HOUSE_PART, roof];
    const presentation = await createW8DistantPresentation({
      THREE: DISTANT_TEST_THREE,
      scene: new DistantTestGroup(),
      worldSeedHash: CANONICAL_WORLD_SEED_HASH,
      visualAssets: assets,
      findSettlementsNear: async () => [candidate],
      resolveTemplate: async () => template,
      getCanonicalChunkData: async (chunkX, chunkZ) => canonicalChunk(chunkX, chunkZ, []),
    });
    await presentation.sync({
      activeDataKeys: [], renderedKeys: [], getChunkData: () => null,
      renderOrigin: { renderOriginChunkX: 0, renderOriginChunkZ: 0 },
      centerChunkX: 0, centerChunkZ: 0, quality,
      playerLogicalX: 8, playerLogicalZ: 8,
      includeFarNatural: false, includeUltraNatural: false,
    });
    const result = {
      snapshot: presentation.snapshot(),
      audit: presentation.canonicalAuditSnapshot(),
    };
    presentation.dispose();
    return result;
  };
  const high = await run('high');
  const medium = await run('medium');
  const low = await run('low');
  for (const result of [high, medium, low]) {
    assert.equal(result.snapshot.renderDistancePreset, 'current');
    assert.equal(result.snapshot.visibilityMeters, 187.5);
    assert.equal(result.snapshot.naturalVisibilityMeters, 0,
      'the Building-quality fixture explicitly disables legacy Natural generation');
    assert.equal(result.snapshot.remoteHorizonHiddenDistanceMeters, 875);
    assert.equal(result.snapshot.remoteHorizonCanonicalBuildingCount, buildings.length);
    assert.equal(result.snapshot.remoteHorizonBuildingCount, buildings.length);
    assert.equal(result.snapshot.remoteHorizonMissingBuildingCount, 0);
    assert.deepEqual(result.audit.map(object => object.identity.stableId).sort(),
      buildings.map(building => building.stableId).sort());
  }
  assert.equal(high.snapshot.remoteHorizonPartInstanceCount, buildings.length * 2);
  assert.equal(medium.snapshot.remoteHorizonPartInstanceCount, buildings.length);
  assert.equal(low.snapshot.remoteHorizonBuildingCount, buildings.length);
  assert.equal(low.snapshot.remoteHorizonPartInstanceCount, buildings.length);
});

test('incremental Tree pages publish per owner within dirty-range frame budgets', async t => {
  const tree = (candidateId, ownerX, x) => Object.freeze({
    candidateId,
    subtype: 'broadleaf-tree',
    variationSeed: 0.75,
    orientationSeed: 0.25,
    worldPosition: Object.freeze({ x, y: 0.4, z: 8 }),
    owningChunkCoordinate: Object.freeze({ x: ownerX, z: 0 }),
    metadata: Object.freeze({ candidateRadiusMeters: 0.32 }),
  });
  const page = (ownerX, candidate) => {
    const chunk = canonicalChunk(ownerX, 0, []);
    chunk.vegetationCandidates = [candidate];
    chunk.presentationLayers.natural = { vegetation: [candidate], rocks: [] };
    return Object.freeze({
      ownerKey: `${ownerX},0`,
      resourceKind: 'presentation',
      value: chunk,
      readyAtMs: performance.now(),
    });
  };
  const firstTree = tree('detail-v1:vegetation:incremental-tree-a', 5, 88);
  const secondTree = tree('detail-v1:vegetation:incremental-tree-b', 6, 104);
  const publications = [];
  let ownerBuildYieldCount = 0;
  const telemetry = createWorldStreamingTelemetry({
    enabled: true,
    capacity: 64,
    sessionId: 'incremental-tree-harness',
  });
  for (const ownerKey of ['5,0', '6,0']) {
    const details = {
      target: WORLD_STREAMING_TARGET.TREE,
      stream: WORLD_STREAMING_STREAM.DISTANT,
      resourceKey: ownerKey,
      ownerKey,
    };
    const correlationId = telemetry.beginRequest(details);
    telemetry.record(WORLD_STREAMING_EVENT.WORKER_START, { ...details, correlationId });
    telemetry.record(WORLD_STREAMING_EVENT.WORKER_COMPLETE, { ...details, correlationId });
  }
  const scene = new DistantTestGroup();
  const presentation = await createW8DistantPresentation({
    THREE: DISTANT_TEST_THREE,
    scene,
    worldSeedHash: CANONICAL_WORLD_SEED_HASH,
    visualAssets: createSilhouetteTestVisualAssets(),
    findSettlementsNear: async () => [],
    resolveTemplate: async () => null,
    getCanonicalChunkData: async () => null,
    incrementalStaticTreePages: true,
    telemetry,
    yieldToMainThread: () => {
      ownerBuildYieldCount += 1;
      return new Promise(resolve => setImmediate(resolve));
    },
    publishStaticOwnerTickets: input => {
      publications.push(Object.freeze({ ...input, atMs: performance.now() }));
      return Object.freeze(input.ownerKeys.map(ownerKey => Object.freeze({ ownerKey })));
    },
  });
  const basePlan = {
    coverageGeneration: 1,
    planRevision: 1,
    planId: 'incremental-tree-plan:1',
    destructionRevision: 'none',
    quality: 'high',
    renderDistancePreset: 'current',
    renderOrigin: { renderOriginChunkX: 0, renderOriginChunkZ: 0 },
    playerLogicalX: 8,
    playerLogicalZ: 8,
    activeDataKeys: [],
    renderedKeys: [],
    retainedOwnerKeys: ['5,0', '6,0'],
  };
  const driveUntil = async predicate => {
    const frameDurations = [];
    for (let frame = 0; frame < 200 && !predicate(); frame += 1) {
      const startedAt = performance.now();
      presentation.update(8, 8, basePlan.renderOrigin);
      frameDurations.push(performance.now() - startedAt);
      await new Promise(resolve => setImmediate(resolve));
    }
    assert.equal(predicate(), true, 'incremental Tree owner did not publish');
    return frameDurations;
  };

  presentation.applyStaticTreePlan({ ...basePlan, readyPages: [page(5, firstTree)] });
  presentation.update(8, 8, basePlan.renderOrigin);
  await Promise.resolve();
  assert.equal(ownerBuildYieldCount, 1,
    'an admitted owner build must cross a task boundary before it starts');
  assert.equal(presentation.snapshot().staticTreeResidentOwnerCount, 0,
    'an admitted owner must not build in the animation-frame microtask checkpoint');
  const firstFrames = await driveUntil(() => publications.length === 1);
  let snapshot = presentation.snapshot();
  assert.equal(publications[0].ownerKeys[0], '5,0');
  assert.equal(snapshot.staticTreeCurrentPublishedOwnerCount, 1);
  assert.equal(snapshot.staticTreeResidentOwnerCount, 1);

  presentation.applyStaticTreePlan({
    ...basePlan,
    planRevision: 2,
    planId: 'incremental-tree-plan:2',
    readyPages: [page(6, secondTree)],
  });
  const secondFrames = await driveUntil(() => publications.length === 2);
  const firstDrawRecorded = markCompletedRenderFrame(presentation, scene);
  snapshot = presentation.snapshot();
  const lifecycleSnapshot = telemetry.snapshot();
  assert.equal(firstDrawRecorded, 2);
  const publishLatencies = lifecycleSnapshot.lifecycles
    .map(value => value.workerCompleteToPublishMs)
    .filter(Number.isFinite);
  const updateMaximumMs = Math.max(...firstFrames, ...secondFrames);

  assert.deepEqual(publications.map(value => value.ownerKeys[0]), ['5,0', '6,0']);
  assert.equal(snapshot.staticTreeCoverageGeneration, 1);
  assert.equal(snapshot.staticTreePlanRevision, 2);
  assert.equal(snapshot.staticTreeCurrentPublishedOwnerCount, 2);
  assert.equal(snapshot.staticTreeResidentOwnerCount, 2);
  assert.equal(snapshot.staticTreePendingOwnerCount, 0);
  assert.equal(snapshot.staticTreeMatrixUpdateCount > 0, true);
  assert.equal(snapshot.staticTreeAttributeUpdateCount > 0, true);
  assert.equal(snapshot.staticTreeMaximumSliceMs < 50, true);
  assert.equal(updateMaximumMs < 50, true);
  assert.equal(lifecycleSnapshot.lifecycles.every(value => value.firstDrawAtMs !== null), true);
  assert.equal(publishLatencies.length, 2);
  t.diagnostic(JSON.stringify({
    workerCompleteToPublishMs: publishLatencies,
    publicationWaitingMaximumMs: snapshot.staticTreeMaximumPublicationWaitMs,
    dirtyMatrixUpdates: snapshot.staticTreeMatrixUpdateCount,
    bufferUpdates: snapshot.staticTreeAttributeUpdateCount,
    composeMaximumSliceMs: snapshot.staticTreeMaximumSliceMs,
    updateMaximumMs,
  }));
  presentation.dispose();
});

test('clipmap topology and terrain sampling remain Float32-identical to the pre-refactor path', () => {
  const legacyTopology = legacyClipmapTopology();
  const topology = createW8ClipmapTopology();
  assert.equal(topology.vertices.length, 8_288);
  assert.equal(topology.indices.length, 48_384);
  assert.deepEqual(topology.vertices, legacyTopology.vertices);
  assert.deepEqual(topology.indices, legacyTopology.indices);

  for (const weights of [
    [1, 0, 0, 0, 0],
    [0.05, 0.15, 0.25, 0.3, 0.25],
    [0.123456789, 0.234567891, 0.345678912, 0.111111111, 0.185185297],
  ]) {
    assert.deepEqual(w8TerrainColorFromWeights(weights), legacyTerrainColorFromWeights(weights));
  }

  for (const { centerChunkX, centerChunkZ, originChunkX, originChunkZ } of [
    { centerChunkX: 0, centerChunkZ: 0, originChunkX: 0, originChunkZ: 0 },
    { centerChunkX: -11, centerChunkZ: 39, originChunkX: -11, originChunkZ: 39 },
    { centerChunkX: 8_191, centerChunkZ: -4_097, originChunkX: 8_190, originChunkZ: -4_096 },
  ]) {
    const projected = topology.vertices.flatMap(({ x, z }) => [
      ((centerChunkX + 0.5) * 16 + x - originChunkX * 16) * 64,
      ((centerChunkZ + 0.5) * 16 + z - originChunkZ * 16) * 64,
    ]);
    const legacyProjected = legacyTopology.vertices.flatMap(({ x, z }) => [
      ((centerChunkX + 0.5) * 16 + x - originChunkX * 16) * 64,
      ((centerChunkZ + 0.5) * 16 + z - originChunkZ * 16) * 64,
    ]);
    assert.deepEqual(new Float32Array(projected), new Float32Array(legacyProjected));
  }

  const chunk = deterministicTerrainFixture();
  const originX = chunk.chunkX * LEGACY_CHUNK_SIZE_METERS;
  const originZ = chunk.chunkZ * LEGACY_CHUNK_SIZE_METERS;
  let sampleCount = 0;
  for (let z = 0; z < 165; z += 1) {
    for (let x = 0; x < 165; x += 1) {
      const worldX = originX - 1.25 + x / 164 * 18.5;
      const worldZ = originZ - 0.75 + z / 164 * 17.5;
      const expected = legacyTerrainSampleAt(chunk, worldX, worldZ);
      const actual = sampleW8DistantTerrainAt(chunk, worldX, worldZ);
      assert.deepEqual(
        new Float32Array([actual.height, ...actual.color]),
        new Float32Array([expected.height, ...expected.color]),
        `${x},${z}`,
      );
      sampleCount += 1;
    }
  }
  assert.equal(sampleCount, 27_225);

  const centerWorldX = (chunk.chunkX + 0.5) * LEGACY_CHUNK_SIZE_METERS;
  const centerWorldZ = (chunk.chunkZ + 0.5) * LEGACY_CHUNK_SIZE_METERS;
  const actualPositions = [];
  const legacyPositions = [];
  const actualColors = [];
  const legacyColors = [];
  for (const { x, z } of topology.vertices) {
    const worldX = centerWorldX + x;
    const worldZ = centerWorldZ + z;
    const actual = sampleW8DistantTerrainAt(chunk, worldX, worldZ);
    const expected = legacyTerrainSampleAt(chunk, worldX, worldZ);
    actualPositions.push(
      (worldX - originX) * 64,
      actual.height * 64,
      (worldZ - originZ) * 64,
    );
    legacyPositions.push(
      (worldX - originX) * 64,
      expected.height * 64,
      (worldZ - originZ) * 64,
    );
    actualColors.push(...actual.color);
    legacyColors.push(...expected.color);
  }
  assert.deepEqual(new Float32Array(actualPositions), new Float32Array(legacyPositions));
  assert.deepEqual(new Float32Array(actualColors), new Float32Array(legacyColors));
  assert.deepEqual(
    new Uint32Array(topology.indices),
    new Uint32Array(legacyTopology.indices),
  );

  const clipmapChecksum = (positions, colors) => {
    let checksum = 0x811c9dc5;
    for (const value of [...positions, ...colors]) {
      checksum ^= Math.round(value * 1000);
      checksum = Math.imul(checksum, 0x01000193) >>> 0;
    }
    return checksum;
  };
  assert.equal(
    clipmapChecksum(actualPositions, actualColors),
    clipmapChecksum(legacyPositions, legacyColors),
  );
});

test('persistent Static Natural pages publish only coarse Tree while detail availability stays separate', async t => {
  const vegetation = Object.freeze([
    Object.freeze({
      candidateId: 'detail-v1:vegetation:static-page-tree',
      subtype: 'broadleaf-tree', variationSeed: 1, orientationSeed: 0.25,
      worldPosition: Object.freeze({ x: 88, y: 0.4, z: 8 }),
      owningChunkCoordinate: Object.freeze({ x: 5, z: 0 }),
      metadata: Object.freeze({ candidateRadiusMeters: 0.32 }),
    }),
    ...Array.from({ length: 64 }, (_, index) => Object.freeze({
      candidateId: `detail-v1:vegetation:static-page-bush:${index}`,
      subtype: 'shrub', variationSeed: 0.5, orientationSeed: 0.75,
      worldPosition: Object.freeze({ x: 89 + (index % 4), y: 0.4, z: 4 + (index % 8) }),
      owningChunkCoordinate: Object.freeze({ x: 5, z: 0 }),
      metadata: Object.freeze({ candidateRadiusMeters: 0.2 }),
    })),
  ]);
  const rocks = Object.freeze(Array.from({ length: 64 }, (_, index) => Object.freeze({
    candidateId: `detail-v1:rock:static-page:${index}`, candidateType: 'rock',
    subtype: 'medium-rock', sizeClass: 'medium', variationSeed: 0.5,
    orientationSeed: 0.25,
    worldPosition: Object.freeze({ x: 90 + (index % 4), y: 0.4, z: 4 + (index % 8) }),
    owningChunkCoordinate: Object.freeze({ x: 5, z: 0 }),
    metadata: Object.freeze({ candidateRadiusMeters: 0.22 }),
  })));
  const grass = Object.freeze(Array.from({ length: 48 }, (_, index) => Object.freeze({
    stableId: `wf1:ambient-detail:static-page-grass:${index}`, detailType: 'grass',
    worldPosition: Object.freeze({ x: 91 + (index % 4), y: 0.4, z: 4 + (index % 8) }), rotationY: 0,
    variation: 1, owningChunkCoordinate: Object.freeze({ x: 5, z: 0 }),
  })));
  const chunk = canonicalChunk(5, 0, []);
  chunk.vegetationCandidates = vegetation;
  chunk.rockCandidates = rocks;
  chunk.ambientDetails = grass;
  chunk.presentationLayers.natural = { vegetation, rocks };
  chunk.presentationLayers.ambientDetails = grass;
  const destroyed = new Set();
  const scene = new DistantTestGroup();
  const presentation = await createW8DistantPresentation({
    THREE: DISTANT_TEST_THREE,
    scene,
    worldSeedHash: CANONICAL_WORLD_SEED_HASH,
    visualAssets: createDistantTestVisualAssets(),
    findSettlementsNear: async () => [],
    resolveTemplate: async () => null,
    getCanonicalChunkData: async () => chunk,
    incrementalStaticTreePages: true,
    isFeatureDestroyed: stableId => destroyed.has(stableId),
  });
  t.after(() => presentation.dispose());
  const input = canonicalSyncInput({
    centerChunkX: 3, activeDataKeys: ['5,0'], renderedKeys: [], chunk,
  });
  assert.equal(await presentation.sync(input), true);
  const fullAvailabilityOnly = presentation.snapshot();
  assert.equal(fullAvailabilityOnly.queryNaturalOwnerChunkCount, 0);
  assert.equal(fullAvailabilityOnly.queryNaturalCandidateCount, 0);
  assert.equal(fullAvailabilityOnly.staticNaturalResidentOwnerCount, 0);
  assert.equal(fullAvailabilityOnly.staticNaturalActiveLegacyRecordCount, 0);
  assert.equal(presentation.canonicalAuditSnapshot().length, 0,
    'Full active ChunkData must not seed a Natural visual record');
  assert.equal(presentation.applyStaticNaturalPlan({
    coverageGeneration: 1,
    planRevision: 1,
    planId: 'static-natural-all-kinds',
    destructionRevision: 'none',
    quality: 'high',
    renderDistancePreset: 'current',
    renderOrigin: input.renderOrigin,
    playerLogicalX: input.playerLogicalX,
    playerLogicalZ: input.playerLogicalZ,
    activeDataKeys: input.activeDataKeys,
    renderedKeys: input.renderedKeys,
    retainedOwnerKeys: ['5,0'],
    readyPages: [{
      ownerKey: '5,0', resourceKind: 'presentation', value: chunk,
      readyAtMs: performance.now(), required: true, deadlineAtMs: performance.now() + 100,
    }],
  }), true);
  for (let frame = 0; frame < 100
    && presentation.snapshot().staticTreeCurrentPublishedOwnerCount !== 1; frame += 1) {
    presentation.update(input.playerLogicalX, input.playerLogicalZ, input.renderOrigin);
    presentation.markFirstDraw();
    await new Promise(resolve => setImmediate(resolve));
  }
  const snapshot = presentation.snapshot();
  assert.equal(snapshot.staticTreeCurrentPublishedOwnerCount, 1);
  assert.equal(snapshot.canonicalTreeRecordCount, 1);
  assert.equal(snapshot.canonicalShrubRecordCount, 0);
  assert.equal(snapshot.canonicalGrassRecordCount, 0);
  assert.equal(snapshot.canonicalRockRecordCount, 0);
  const audit = presentation.canonicalAuditSnapshot();
  const stableIds = audit.map(object => object.identity.stableId).sort();
  assert.deepEqual(new Set(audit.map(object => object.naturalLod.kind)),
    new Set(['tree']),
  'Bush, Grass, and Rock never enter the coarse publication or receipt path');
  assert.equal(new Set(audit.map(object => object.identity.stableId)).size, audit.length);
  assert.equal(snapshot.staticTreePromotionPendingOwnerCount, 0);
  assert.equal(snapshot.staticTreePromotionRequestCount, 0);
  assert.equal(snapshot.staticTreePromotionOwnerBuildCount, 0);
  assert.equal(snapshot.staticTreeFarOnlyResidentOwnerCount, 0);
  const buildsBeforeFullAvailability = snapshot.staticTreeOwnerBuildCount;
  const rebuildsBeforeFullAvailability = snapshot.staticTreeOwnerRebuildCount;
  presentation.advanceStaticNaturalFrame({
    coverageGeneration: 1,
    planRevision: 1,
    planId: 'static-natural-all-kinds',
    destructionRevision: 'none',
    playerLogicalX: input.playerLogicalX,
    playerLogicalZ: input.playerLogicalZ,
    activeDataKeys: input.activeDataKeys,
    renderedKeys: input.renderedKeys,
    readyPages: [{
      ownerKey: '5,0', resourceKind: 'canonical', value: chunk,
      readyAtMs: performance.now(), required: true,
    }],
  });
  presentation.update(input.playerLogicalX, input.playerLogicalZ, input.renderOrigin);
  const afterFullAvailability = presentation.snapshot();
  assert.equal(afterFullAvailability.staticNaturalDetailAvailableOwnerCount, 1);
  assert.equal(afterFullAvailability.staticTreeOwnerBuildCount, buildsBeforeFullAvailability);
  assert.equal(afterFullAvailability.staticTreeOwnerRebuildCount, rebuildsBeforeFullAvailability);
  assert.deepEqual(
    presentation.canonicalAuditSnapshot().map(object => object.identity.stableId).sort(),
    stableIds,
    'Full availability must preserve the Presentation-owned Stable IDs and slots',
  );
  const visibilitySequenceBeforeExactMotion = afterFullAvailability.naturalVisibilitySequence;
  const visibilityDiscardBeforeExactMotion =
    afterFullAvailability.naturalVisibilitySupersededDiscardCount;
  for (let frame = 0; frame < 12; frame += 1) {
    presentation.update(
      input.playerLogicalX + (frame + 1) * 0.125,
      input.playerLogicalZ,
      input.renderOrigin,
    );
  }
  const afterExactMotion = presentation.snapshot();
  assert.equal(afterExactMotion.naturalVisibilitySequence, visibilitySequenceBeforeExactMotion,
    'exact player X/Z motion must not restart an owner visibility scan');
  assert.equal(afterExactMotion.naturalVisibilitySupersededDiscardCount,
    visibilityDiscardBeforeExactMotion);
  assert.equal(afterExactMotion.naturalVisibilityQueueLength, 0);
  assert.equal(snapshot.staticTreeMaximumAdmissionsPerFrame <= 1, true);
  assert.equal(snapshot.staticTreeAdmissionLimitViolationCount, 0);
  const naturalDensityAttributes = [];
  const pendingNodes = [...scene.children];
  while (pendingNodes.length > 0) {
    const node = pendingNodes.shift();
    pendingNodes.push(...(node.children ?? []));
    const attribute = node.geometry?.attributes?.w8NaturalDensityRank;
    if (attribute) naturalDensityAttributes.push(attribute);
  }
  if (naturalDensityAttributes.length === 0) {
    t.diagnostic('fixture visual assets do not materialize a density attribute for every Natural kind');
  }
  for (const attribute of naturalDensityAttributes) {
    attribute.clearUpdateRanges();
    attribute.needsUpdate = false;
  }
  const densityStableId = audit.find(object => (
    object.naturalLod.kind === 'tree'
  )).identity.stableId;
  const densityMesh = (() => {
    const nodes = [...scene.children];
    while (nodes.length > 0) {
      const node = nodes.shift();
      nodes.push(...(node.children ?? []));
      if (node.userData?.canonicalCoarseTreeSubmission === true
        && node.userData?.canonicalStableIds?.includes(densityStableId)) return node;
    }
    return null;
  })();
  assert.ok(densityMesh, 'fixture must expose the target coarse Tree mesh');
  const densityAttribute = densityMesh.geometry.attributes.w8NaturalDensityRank;
  const densitySlot = densityMesh.userData.canonicalStableIds.indexOf(densityStableId);
  assert.ok(densitySlot >= 0 && densitySlot < densityMesh.count);
  const pendingDensitySlot = densitySlot + 1;
  assert.ok(pendingDensitySlot < densityAttribute.array.length,
    'fixture must expose one inactive capacity slot for range-union coverage');
  densityAttribute.addUpdateRange(pendingDensitySlot, 1);
  destroyed.add(densityStableId);
  presentation.advanceStaticNaturalFrame({
    coverageGeneration: 1,
    planRevision: 1,
    planId: 'static-natural-all-kinds',
    destructionRevision: densityStableId,
    playerLogicalX: input.playerLogicalX,
    playerLogicalZ: input.playerLogicalZ,
    activeDataKeys: input.activeDataKeys,
    renderedKeys: input.renderedKeys,
  });
  const densityTreeIsDrawable = () => densityMesh.userData.canonicalStableIds
    .slice(0, densityMesh.count).some((stableId, slot) => (
      stableId === densityStableId
        && (densityMesh.userData.canonicalOpacities?.[slot] ?? 0) > 0
    ));
  for (let frame = 0; frame < 32 && densityTreeIsDrawable(); frame += 1) {
    presentation.update(input.playerLogicalX, input.playerLogicalZ, input.renderOrigin);
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(densityTreeIsDrawable(), false,
    'destruction must remove the target Tree from the submitted coarse prefix');
  assert.equal(densityAttribute.needsUpdate, true);
  for (const slot of [densitySlot, pendingDensitySlot]) {
    assert.equal(densityAttribute.updateRanges.some(range => (
      range.start <= slot && range.start + range.count >= slot + 1
    )), true, 'Static Natural density upload ranges must union dirty and pending slots');
  }
  destroyed.clear();
  presentation.advanceStaticNaturalFrame({
    coverageGeneration: 1,
    planRevision: 1,
    planId: 'static-natural-all-kinds',
    destructionRevision: 'none',
    playerLogicalX: input.playerLogicalX,
    playerLogicalZ: input.playerLogicalZ,
    activeDataKeys: input.activeDataKeys,
    renderedKeys: input.renderedKeys,
    readyPages: [{
      ownerKey: '5,0', resourceKind: 'presentation', value: chunk,
      readyAtMs: performance.now(), required: true, deadlineAtMs: performance.now() + 100,
    }],
  });
  presentation.update(input.playerLogicalX, input.playerLogicalZ, input.renderOrigin);
  const restored = presentation.canonicalAuditSnapshot();
  assert.notEqual(restored.find(object => object.identity.stableId === densityStableId).visibleLod,
    'destroyed');
  assert.equal(presentation.snapshot().staticTreeOwnerReuseCount > 0, true);
  assert.equal(presentation.snapshot().staticTreeDuplicatePageQueueCount, 0);
  assert.equal(presentation.snapshot().staticNaturalCoverageApplyCount, 1);
  assert.equal(presentation.snapshot().staticNaturalFrameAdvanceCount >= 3, true);
});

test('PresentationOwner page publishes canonical Building and Road through the Static page path', async t => {
  const boundaryTree = Object.freeze({
    candidateId: 'detail-v1:vegetation:static-page-boundary-tree',
    subtype: 'broadleaf-tree', variationSeed: 0.25, orientationSeed: 0.75,
    densityRank: 0,
    worldPosition: Object.freeze({ x: 95.999999, y: 0.4, z: 15.999999 }),
    owningChunkCoordinate: Object.freeze({ x: 5, z: 0 }),
    metadata: Object.freeze({ candidateRadiusMeters: 0.32 }),
  });
  const road = Object.freeze({
    schemaVersion: 'w8-canonical-major-road-chunk-feature-1',
    stableId: 'major-road-v1:static-page:segment:0:chunk:5:0',
    sourceStableId: 'major-road-v1:static-page',
    sourceSegmentStableId: 'major-road-v1:static-page:segment:0',
    featureType: 'settlement-road',
    canonicalMajorRoad: true,
    settlementId: CANONICAL_SETTLEMENT_ID,
    settlementIds: Object.freeze([CANONICAL_SETTLEMENT_ID]),
    roadKind: 'MAJOR',
    widthMeters: 2.25,
    start: Object.freeze({ x: 84, y: 0, z: 8 }),
    end: Object.freeze({ x: 92, y: 0, z: 8 }),
    worldPosition: Object.freeze({ x: 88, y: 0, z: 8 }),
    owningChunkCoordinate: Object.freeze({ x: 5, z: 0 }),
  });
  const chunk = canonicalChunk(5, 0, [CANONICAL_BUILDING, road]);
  chunk.vegetationCandidates = [boundaryTree];
  chunk.presentationLayers.natural = { vegetation: [boundaryTree], rocks: [] };
  const scene = new DistantTestGroup();
  let nearStableIds = [];
  const presentation = await createW8DistantPresentation({
    THREE: DISTANT_TEST_THREE,
    scene,
    worldSeedHash: CANONICAL_WORLD_SEED_HASH,
    visualAssets: createDistantTestVisualAssets(),
    findSettlementsNear: async () => [],
    resolveTemplate: async () => null,
    getCanonicalChunkData: async () => null,
    getNearVisibleStableIds: () => nearStableIds,
    incrementalStaticTreePages: true,
  });
  t.after(() => presentation.dispose());
  const renderOrigin = { renderOriginChunkX: 0, renderOriginChunkZ: 0, rebaseCount: 0 };
  const syncInput = canonicalSyncInput({
    centerChunkX: 3, activeDataKeys: ['5,0'], renderedKeys: [], chunk,
  });
  assert.equal(await presentation.sync(syncInput), true);
  const coarsePlayerX = 80 - 300 / Math.SQRT2;
  const coarsePlayerZ = -300 / Math.SQRT2;
  assert.equal(presentation.applyStaticNaturalPlan({
    coverageGeneration: 1,
    planRevision: 1,
    planId: 'static-page-coarse-structures',
    destructionRevision: 'none',
    quality: 'high',
    renderDistancePreset: 'current',
    renderOrigin,
    playerLogicalX: coarsePlayerX,
    playerLogicalZ: coarsePlayerZ,
    activeDataKeys: [],
    renderedKeys: [],
    retainedOwnerKeys: ['5,0'],
    resourceKindEntries: [['5,0', 'presentation']],
    readyPages: [{
      ownerKey: '5,0', resourceKind: 'presentation', value: chunk,
      readyAtMs: performance.now(), required: true,
    }],
  }), true);
  for (let frame = 0; frame < 100
    && presentation.snapshot().staticTreeCurrentPublishedOwnerCount !== 1; frame += 1) {
    presentation.update(coarsePlayerX, coarsePlayerZ, renderOrigin);
    await new Promise(resolve => setImmediate(resolve));
  }

  const persistentRoot = scene.children.find(child => (
    child.name === 'w8-persistent-static-natural-pages'
  ));
  assert.ok(persistentRoot);
  const presenterIds = persistentRoot.children.flatMap(mesh => (
    mesh.userData?.canonicalStableIds ?? []
  )).filter(Boolean);
  assert.equal(presenterIds.filter(value => value === CANONICAL_BUILDING_ID).length > 0, true);
  assert.equal(presenterIds.filter(value => value === road.stableId).length, 1);
  assert.deepEqual(new Set(presenterIds), new Set([
    CANONICAL_BUILDING_ID, road.stableId, boundaryTree.candidateId,
  ]));
  const roadMesh = persistentRoot.children.find(mesh => (
    mesh.userData?.canonicalStableIds?.includes(road.stableId)
  ));
  assert.equal((roadMesh?.geometry?.attributes?.position?.array?.length ?? 0) > 0, true);
  const buildingMeshes = persistentRoot.children.filter(mesh => (
    mesh.userData?.canonicalStableIds?.includes(CANONICAL_BUILDING_ID)
  ));
  assert.equal(buildingMeshes.length > 0, true);
  assert.equal(buildingMeshes.every(mesh => mesh.count > 0), true);
  assert.equal(persistentRoot.children.some(mesh => (
    (mesh.userData?.canonicalStableIds ?? []).some((stableId, slot) => (
      (stableId === CANONICAL_BUILDING_ID || stableId === road.stableId)
        && (mesh.userData?.canonicalOpacities?.[slot] ?? 0) > 0
    ))
  )), true, 'coarse structures remain drawable near the 300 m fog boundary');
  assert.equal(persistentRoot.children.some(mesh => (
    (mesh.userData?.canonicalStableIds ?? []).some((stableId, slot) => (
      stableId === boundaryTree.candidateId
        && (mesh.userData?.canonicalOpacities?.[slot] ?? 0) > 0
    ))
  )), true, 'coarse Tree remains drawable at the far corner of a boundary owner');
  const visualRegistry = createVisualContinuityRegistry();
  visualRegistry.expect({ ownerKey: '5,0' });
  visualRegistry.resolveCoarseRequirements({
    ownerKey: '5,0',
    structureStableIds: [],
    forestStableIds: [boundaryTree.candidateId],
  });
  const frames = createRenderFrameAcknowledger();
  const token = frames.beginFrame({ frameSequence: 1 });
  const receipt = frames.completeFrame(token, { scene });
  visualRegistry.acknowledgeScene({ receipt, scene });
  assert.deepEqual(visualRegistry.get('5,0').drawnForestStableIds, [
    boundaryTree.candidateId,
  ], 'the exact 300 m owner-intersection far corner remains positive on a completed receipt');
  for (let frame = 0; frame < 8; frame += 1) {
    presentation.update(coarsePlayerX, coarsePlayerZ, renderOrigin);
    await new Promise(resolve => setImmediate(resolve));
  }
  const legacyPresenterIds = scene.children
    .filter(child => child !== persistentRoot)
    .flatMap(root => {
      const ids = [];
      const pending = [root];
      while (pending.length > 0) {
        const node = pending.pop();
        pending.push(...(node.children ?? []));
        ids.push(...(node.userData?.canonicalStableIds ?? []).filter(Boolean));
      }
      return ids;
    });
  assert.equal(legacyPresenterIds.includes(CANONICAL_BUILDING_ID), false);
  assert.equal(legacyPresenterIds.includes(road.stableId), false);

  nearStableIds = [CANONICAL_BUILDING_ID];
  presentation.advanceStaticNaturalFrame({
    coverageGeneration: 1,
    planRevision: 1,
    planId: 'static-page-coarse-structures',
    destructionRevision: 'none',
    playerLogicalX: coarsePlayerX,
    playerLogicalZ: coarsePlayerZ,
    activeDataKeys: [],
    renderedKeys: [],
  });
  presentation.update(coarsePlayerX, coarsePlayerZ, renderOrigin);
  const afterNearIds = persistentRoot.children.flatMap(mesh => (
    mesh.userData?.canonicalStableIds ?? []
  )).filter(Boolean);
  assert.equal(persistentRoot.children.every(mesh => (
    !(mesh.userData?.canonicalStableIds ?? []).some((stableId, slot) => (
      stableId === CANONICAL_BUILDING_ID
        && (mesh.userData?.canonicalOpacities?.[slot] ?? 0) > 0
    ))
  )), true);
  assert.equal(afterNearIds.includes(road.stableId), true);

  nearStableIds = [];
  presentation.applyStaticNaturalPlan({
    coverageGeneration: 2,
    planRevision: 2,
    planId: 'static-page-coarse-structures-retired',
    destructionRevision: 'none',
    quality: 'high',
    renderDistancePreset: 'current',
    renderOrigin,
    playerLogicalX: coarsePlayerX,
    playerLogicalZ: coarsePlayerZ,
    activeDataKeys: [],
    renderedKeys: [],
    retainedOwnerKeys: [],
    resourceKindEntries: [],
    readyPages: [],
  });
  for (let frame = 0; frame < 40
    && presentation.snapshot().staticNaturalResidentOwnerCount !== 0; frame += 1) {
    presentation.update(coarsePlayerX, coarsePlayerZ, renderOrigin);
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(persistentRoot.children.some(mesh => (
    mesh.userData?.canonicalStableIds?.includes(road.stableId)
  )), false);
});

test('persistent Natural capacity covers Current stationary and MAX corridor slot pressure', () => {
  const grassCapacity = resolveW8PersistentNaturalBucketCapacity({
    kind: 'grass',
    mode: 'full',
    maximumCanonicalOwnerCount: 331,
    maximumManifestOwnerCount: 0,
    requiredSlots: 15_844,
  });
  const treeCapacity = resolveW8PersistentNaturalBucketCapacity({
    kind: 'tree',
    mode: 'full',
    maximumCanonicalOwnerCount: 54,
    maximumManifestOwnerCount: 1,
    requiredSlots: 6_896,
  });
  assert.equal(grassCapacity, 15_888);
  assert.equal(treeCapacity, 6_912);
  assert.throws(() => resolveW8PersistentNaturalBucketCapacity({
    kind: 'tree',
    mode: 'full',
    maximumCanonicalOwnerCount: 1,
    maximumManifestOwnerCount: 1,
    requiredSlots: 129,
  }), /persistent Natural bucket capacity exceeded/);
});

test('Static coarse pages include only owners covered by Tree policy', async t => {
  const allKindsChunk = ownerX => {
    const vegetation = [
      Object.freeze({
        candidateId: `detail-v1:vegetation:coverage-tree:${ownerX}`,
        subtype: 'broadleaf-tree', variationSeed: 1, orientationSeed: 0.25,
        worldPosition: Object.freeze({ x: ownerX * 16 + 2, y: 0.4, z: 8 }),
        owningChunkCoordinate: Object.freeze({ x: ownerX, z: 0 }),
        metadata: Object.freeze({ candidateRadiusMeters: 0.32 }),
      }),
      Object.freeze({
        candidateId: `detail-v1:vegetation:coverage-bush:${ownerX}`,
        subtype: 'shrub', variationSeed: 1, orientationSeed: 0.25,
        worldPosition: Object.freeze({ x: ownerX * 16 + 4, y: 0.4, z: 8 }),
        owningChunkCoordinate: Object.freeze({ x: ownerX, z: 0 }),
        metadata: Object.freeze({ candidateRadiusMeters: 0.2 }),
      }),
    ];
    const rock = Object.freeze({
      candidateId: `detail-v1:rock:coverage:${ownerX}`, candidateType: 'rock',
      subtype: 'medium-rock', sizeClass: 'medium', variationSeed: 0.5,
      orientationSeed: 0.25,
      worldPosition: Object.freeze({ x: ownerX * 16 + 6, y: 0.4, z: 8 }),
      owningChunkCoordinate: Object.freeze({ x: ownerX, z: 0 }),
      metadata: Object.freeze({ candidateRadiusMeters: 0.22 }),
    });
    const grass = Object.freeze({
      stableId: `wf1:ambient-detail:coverage-grass:${ownerX}`, detailType: 'grass',
      worldPosition: Object.freeze({ x: ownerX * 16 + 8, y: 0.4, z: 8 }),
      rotationY: 0, variation: 1,
      owningChunkCoordinate: Object.freeze({ x: ownerX, z: 0 }),
    });
    const chunk = canonicalChunk(ownerX, 0, []);
    chunk.contentHash = `sha256:${String(ownerX).padStart(64, '0')}`;
    chunk.vegetationCandidates = vegetation;
    chunk.rockCandidates = [rock];
    chunk.ambientDetails = [grass];
    chunk.presentationLayers.natural = { vegetation, rocks: [rock] };
    chunk.presentationLayers.ambientDetails = [grass];
    return chunk;
  };
  const treeChunk = allKindsChunk(5);
  const grassChunk = allKindsChunk(6);
  const policyCoverage = (naturalKind, resourceKindEntries) => Object.freeze({
    schemaVersion: 'static-natural-policy-coverage-1',
    policyKind: `natural-${naturalKind}`,
    naturalKind,
    resourceKindEntries: Object.freeze(resourceKindEntries),
    maximumCanonicalOwnerCount: 4,
    maximumManifestOwnerCount: naturalKind === 'tree' ? 4 : 0,
  });
  const presentation = await createW8DistantPresentation({
    THREE: DISTANT_TEST_THREE,
    scene: new DistantTestGroup(),
    worldSeedHash: CANONICAL_WORLD_SEED_HASH,
    visualAssets: createDistantTestVisualAssets(),
    findSettlementsNear: async () => [],
    resolveTemplate: async () => null,
    getCanonicalChunkData: async () => null,
    incrementalStaticTreePages: true,
  });
  t.after(() => presentation.dispose());
  presentation.applyStaticNaturalPlan({
    coverageGeneration: 1,
    planRevision: 1,
    planId: 'object-policy-filter',
    destructionRevision: 'none',
    quality: 'high',
    renderDistancePreset: 'current',
    renderOrigin: { renderOriginChunkX: 0, renderOriginChunkZ: 0 },
    playerLogicalX: 88,
    playerLogicalZ: 8,
    retainedOwnerKeys: ['5,0'],
    resourceKindEntries: [['5,0', 'presentation']],
    policyResourceCoverage: [
      policyCoverage('tree', [['5,0', 'presentation'], ['6,0', 'manifest']]),
      policyCoverage('grass', [['5,0', 'manifest'], ['6,0', 'manifest']]),
      policyCoverage('bush', [['5,0', 'manifest'], ['6,0', 'manifest']]),
      policyCoverage('rock', [['5,0', 'manifest'], ['6,0', 'manifest']]),
    ],
    readyPages: [
      { ownerKey: '5,0', resourceKind: 'presentation', value: treeChunk,
        readyAtMs: performance.now(), required: true, deadlineAtMs: performance.now() + 100 },
    ],
  });
  for (let frame = 0; frame < 100
    && presentation.snapshot().staticNaturalCurrentPublishedOwnerCount !== 1; frame += 1) {
    presentation.update(88, 8, { renderOriginChunkX: 0, renderOriginChunkZ: 0 });
    await new Promise(resolve => setImmediate(resolve));
  }
  const audit = presentation.canonicalAuditSnapshot();
  assert.deepEqual(audit.map(object => [object.ownerKey, object.naturalLod.kind]).sort(), [
    ['5,0', 'tree'],
  ]);
  const snapshot = presentation.snapshot();
  assert.equal(snapshot.staticNaturalCurrentPublishedOwnerCount, 1);
  assert.equal(snapshot.staticNaturalOrphanObjectCount, 0);
  assert.equal(snapshot.staticNaturalOrphanSlotCount, 0);
  assert.equal(new Set(audit.map(object => object.identity.stableId)).size, audit.length);
});

test('Near handoff suppresses only the matching natural Stable ID across every tier', async t => {
  const candidate = (candidateId, x) => Object.freeze({
    candidateId,
    subtype: 'broadleaf-tree',
    variationSeed: 1,
    orientationSeed: 0.25,
    worldPosition: Object.freeze({ x, y: 0.4, z: 8 }),
    owningChunkCoordinate: Object.freeze({ x: 5, z: 0 }),
    metadata: Object.freeze({ candidateRadiusMeters: 0.32 }),
  });
  const trees = Object.freeze([
    candidate('detail-v1:vegetation:near-handoff:a', 88),
    candidate('detail-v1:vegetation:near-handoff:b', 90),
    candidate('detail-v1:vegetation:near-handoff:c', 92),
    candidate('detail-v1:vegetation:near-handoff:d', 94),
  ].map((tree, index) => Object.freeze({ ...tree, densityRank: (index + 1) / 100 })));
  const chunk = canonicalChunk(5, 0, []);
  chunk.vegetationCandidates = trees;
  chunk.presentationLayers.natural.vegetation = trees;
  let nearReceiptIds = [];
  let nearPublishedIds = [];
  const scene = new DistantTestGroup();
  const presentation = await createW8DistantPresentation({
    THREE: DISTANT_TEST_THREE,
    scene,
    worldSeedHash: CANONICAL_WORLD_SEED_HASH,
    visualAssets: createDistantTestVisualAssets(),
    findSettlementsNear: async () => [],
    resolveTemplate: async () => null,
    getCanonicalChunkData: async () => chunk,
    getNearVisibleStableIds: () => nearReceiptIds,
    getNearPublishedStableIds: () => nearPublishedIds,
    incrementalStaticTreePages: true,
  });
  t.after(() => presentation.dispose());
  const distantOpacitiesFor = stableId => {
    const opacities = [];
    const pending = [...scene.children];
    while (pending.length > 0) {
      const node = pending.shift();
      pending.push(...(node.children ?? []));
      for (let slot = 0; slot < (node.userData?.canonicalStableIds?.length ?? 0); slot += 1) {
        if (node.userData.canonicalStableIds[slot] === stableId) {
          opacities.push(node.userData.canonicalOpacities?.[slot] ?? 0);
        }
      }
    }
    return opacities;
  };
  const input = canonicalSyncInput({
    centerChunkX: 3, activeDataKeys: ['5,0'], renderedKeys: [], chunk,
  });
  assert.equal(await presentation.sync(input), true);
  presentation.applyStaticNaturalPlan({
    coverageGeneration: 1,
    planRevision: 1,
    planId: 'near-handoff-presentation-owner',
    destructionRevision: 'none',
    quality: 'high',
    renderDistancePreset: 'current',
    renderOrigin: input.renderOrigin,
    playerLogicalX: input.playerLogicalX,
    playerLogicalZ: input.playerLogicalZ,
    activeDataKeys: input.activeDataKeys,
    renderedKeys: input.renderedKeys,
    retainedOwnerKeys: ['5,0'],
    resourceKindEntries: [['5,0', 'presentation']],
    readyPages: [{
      ownerKey: '5,0', resourceKind: 'presentation', value: chunk,
      readyAtMs: performance.now(), required: true,
    }],
  });
  for (let frame = 0; frame < 100
    && presentation.snapshot().staticTreeCurrentPublishedOwnerCount !== 1; frame += 1) {
    presentation.update(input.playerLogicalX, input.playerLogicalZ, input.renderOrigin);
    await new Promise(resolve => setImmediate(resolve));
  }
  nearPublishedIds = [trees[0].candidateId];
  assert.equal(presentation.commitRuntimeState({
    activeDataKeys: input.activeDataKeys,
    renderedKeys: input.renderedKeys,
    renderOrigin: input.renderOrigin,
    quality: 'high',
    playerLogicalX: input.playerLogicalX,
    playerLogicalZ: input.playerLogicalZ,
  }), true);
  presentation.update(input.playerLogicalX, input.playerLogicalZ, input.renderOrigin);
  let audit = Object.fromEntries(presentation.canonicalAuditSnapshot().map(value => (
    [value.identity.stableId, value]
  )));
  assert.equal(audit[trees[0].candidateId].visibleLod, 'mid',
    'coarse OLD remains until the published Near presenter has a completed receipt');
  assert.equal(distantOpacitiesFor(trees[0].candidateId).some(opacity => opacity > 0), true);

  const persistentRoot = scene.children.find(child => (
    child.name === 'w8-persistent-static-natural-pages'
  ));
  const coarseTreeMesh = persistentRoot.children.find(child => (
    child.userData?.canonicalCoarseTreeSubmission === true
      && child.userData.canonicalStableIds?.includes(trees[0].candidateId)
  ));
  assert.ok(coarseTreeMesh, 'fixture must publish the persistent coarse Tree mesh');
  const pendingSlot = coarseTreeMesh.userData.canonicalStableIds.findIndex((stableId, slot) => (
    stableId !== trees[0].candidateId && slot < coarseTreeMesh.count - 1
  ));
  assert.ok(pendingSlot >= 0, 'fixture must retain an unrelated submitted slot');
  const pendingAttributes = [
    [coarseTreeMesh.instanceMatrix, 16],
    [coarseTreeMesh.geometry.attributes.w8NaturalAnchorXZ, 2],
    [coarseTreeMesh.geometry.attributes.w8NaturalInitialReveal, 1],
  ];
  for (const [attribute, itemSize] of pendingAttributes) {
    attribute.clearUpdateRanges();
    attribute.addUpdateRange(pendingSlot * itemSize, itemSize);
  }

  nearReceiptIds = [trees[0].candidateId];
  presentation.update(input.playerLogicalX, input.playerLogicalZ, input.renderOrigin);
  for (const [attribute, itemSize] of pendingAttributes) {
    const pendingStart = pendingSlot * itemSize;
    assert.equal(attribute.updateRanges.some(range => (
      range.start <= pendingStart && range.start + range.count >= pendingStart + itemSize
    )), true,
    'Near dense-prefix compose must preserve earlier same-frame GPU update ranges');
  }
  audit = Object.fromEntries(presentation.canonicalAuditSnapshot().map(value => (
    [value.identity.stableId, value]
  )));
  assert.equal(audit[trees[0].candidateId].visibleLod, 'near');
  assert.deepEqual([
    audit[trees[0].candidateId].naturalLod.fullInstanceCount,
    audit[trees[0].candidateId].naturalLod.forestInstanceCount,
    audit[trees[0].candidateId].naturalLod.atmosphericInstanceCount,
    audit[trees[0].candidateId].naturalLod.farInstanceCount,
  ], [0, 0, 0, 0], 'Near handoff hides the submitted coarse Tree slot');
  assert.equal(audit[trees[0].candidateId].instanceCount, 2,
    'Near handoff retains both LOD slots on one canonical resident Tree identity');
  assert.equal(distantOpacitiesFor(trees[0].candidateId).every(opacity => opacity === 0), true);
  assert.equal(audit[trees[1].candidateId].visibleLod, 'mid');
  assert.deepEqual([
    audit[trees[1].candidateId].naturalLod.fullInstanceCount,
    audit[trees[1].candidateId].naturalLod.forestInstanceCount,
    audit[trees[1].candidateId].naturalLod.atmosphericInstanceCount,
    audit[trees[1].candidateId].naturalLod.farInstanceCount,
  ], [0, 1, 0, 1]);
  assert.equal(distantOpacitiesFor(trees[1].candidateId).some(opacity => opacity > 0), true);
  assert.equal(presentation.snapshot().duplicateVisibleStableIdCount, 0);

  nearPublishedIds = [];
  presentation.commitRuntimeState({
    activeDataKeys: input.activeDataKeys,
    renderedKeys: input.renderedKeys,
    renderOrigin: input.renderOrigin,
    quality: 'high',
    playerLogicalX: input.playerLogicalX,
    playerLogicalZ: input.playerLogicalZ,
  });
  presentation.update(input.playerLogicalX, input.playerLogicalZ, input.renderOrigin);
  audit = Object.fromEntries(presentation.canonicalAuditSnapshot().map(value => (
    [value.identity.stableId, value]
  )));
  assert.equal(audit[trees[0].candidateId].visibleLod, 'mid');
  assert.deepEqual([
    audit[trees[0].candidateId].naturalLod.fullInstanceCount,
    audit[trees[0].candidateId].naturalLod.forestInstanceCount,
    audit[trees[0].candidateId].naturalLod.atmosphericInstanceCount,
    audit[trees[0].candidateId].naturalLod.farInstanceCount,
  ], [0, 1, 0, 1]);
  assert.equal(distantOpacitiesFor(trees[0].candidateId).some(opacity => opacity > 0), true);
  assert.equal(distantOpacitiesFor(trees[0].candidateId)
    .filter(opacity => opacity > 0).length, 2,
  'Near disappearance restores the two GPU LOD tiers of one logical presenter');
  assert.equal(audit[trees[0].candidateId].ownerKey, '5,0');
  presentation.dispose();
});

test('persistent coarse replacement keeps one attached root and one Tree presenter', async t => {
  const tree = Object.freeze({
    candidateId: 'detail-v1:vegetation:single-root-replacement',
    subtype: 'broadleaf-tree', variationSeed: 0.25, orientationSeed: 0.75,
    worldPosition: Object.freeze({ x: 88, y: 0.4, z: 8 }),
    owningChunkCoordinate: Object.freeze({ x: 5, z: 0 }),
    metadata: Object.freeze({ candidateRadiusMeters: 0.32 }),
  });
  const chunk = canonicalChunk(5, 0, []);
  chunk.vegetationCandidates = [tree];
  chunk.presentationLayers.natural.vegetation = [tree];
  const scene = new DistantTestGroup();
  const presentation = await createW8DistantPresentation({
    THREE: DISTANT_TEST_THREE,
    scene,
    worldSeedHash: CANONICAL_WORLD_SEED_HASH,
    visualAssets: createDistantTestVisualAssets(),
    findSettlementsNear: async () => [],
    resolveTemplate: async () => null,
    getCanonicalChunkData: async () => chunk,
    incrementalStaticTreePages: true,
  });
  t.after(() => presentation.dispose());
  const input = canonicalSyncInput({
    centerChunkX: 3, activeDataKeys: ['5,0'], renderedKeys: [], chunk,
  });
  assert.equal(await presentation.sync(input), true);
  const apply = (coverageGeneration, quality) => presentation.applyStaticNaturalPlan({
    coverageGeneration,
    planRevision: coverageGeneration,
    planId: `single-root:${coverageGeneration}`,
    destructionRevision: 'none',
    quality,
    renderDistancePreset: 'current',
    renderOrigin: input.renderOrigin,
    playerLogicalX: input.playerLogicalX,
    playerLogicalZ: input.playerLogicalZ,
    activeDataKeys: input.activeDataKeys,
    renderedKeys: input.renderedKeys,
    retainedOwnerKeys: ['5,0'],
    resourceKindEntries: [['5,0', 'presentation']],
    readyPages: [{
      ownerKey: '5,0', resourceKind: 'presentation', value: chunk,
      readyAtMs: performance.now(), required: true,
    }],
  });
  assert.equal(apply(1, 'high'), true);
  for (let frame = 0; frame < 100
    && presentation.snapshot().staticTreeCurrentPublishedOwnerCount !== 1; frame += 1) {
    presentation.update(input.playerLogicalX, input.playerLogicalZ, input.renderOrigin);
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(apply(2, 'low'), true);
  const attachedRoots = () => scene.children.filter(child => (
    child.name === 'w8-persistent-static-natural-pages'
  ));
  assert.equal(attachedRoots().length, 1,
    'the retained coarse root remains the sole attached presenter during staging');
  for (let frame = 0; frame < 120
    && (presentation.snapshot().staticTreeCurrentPublishedOwnerCount !== 1
      || presentation.snapshot().naturalVisibilityRetainedGenerationPending); frame += 1) {
    presentation.update(input.playerLogicalX, input.playerLogicalZ, input.renderOrigin);
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(attachedRoots().length, 1,
    'replacement publication atomically leaves one attached persistent root');
  const presenters = attachedRoots()[0].children.flatMap(mesh => (
    (mesh.userData?.canonicalStableIds ?? []).map((stableId, slot) => ({
      stableId,
      opacity: mesh.userData?.canonicalOpacities?.[slot] ?? 0,
    }))
  )).filter(value => value.stableId === tree.candidateId && value.opacity > 0);
  assert.equal(presenters.length, 2,
    'one canonical Tree object owns one Mid slot and one Far slot');
  assert.equal(new Set(presenters.map(value => value.stableId)).size, 1);
});

test('coarse Tree destruction hides its stable slot and survives Save Continue', async t => {
  const tree = Object.freeze({
    candidateId: 'detail-v1:vegetation:destroy-continue',
    subtype: 'broadleaf-tree', variationSeed: 1, orientationSeed: 0.25,
    worldPosition: Object.freeze({ x: 88, y: 0.4, z: 8 }),
    owningChunkCoordinate: Object.freeze({ x: 5, z: 0 }),
    metadata: Object.freeze({ candidateRadiusMeters: 0.32 }),
  });
  const rock = Object.freeze({
    candidateId: 'detail-v1:rock:destroy-continue',
    candidateType: 'rock', subtype: 'medium-rock', sizeClass: 'medium',
    variationSeed: 0.5, orientationSeed: 0.25,
    worldPosition: Object.freeze({ x: 90, y: 0.4, z: 8 }),
    owningChunkCoordinate: Object.freeze({ x: 5, z: 0 }),
    metadata: Object.freeze({ candidateRadiusMeters: 0.22 }),
  });
  const bush = Object.freeze({
    candidateId: 'detail-v1:vegetation:shrub:destroy-continue',
    candidateType: 'vegetation',
    subtype: 'shrub', variationSeed: 0.5, orientationSeed: 0.75,
    worldPosition: Object.freeze({ x: 89, y: 0.4, z: 8 }),
    owningChunkCoordinate: Object.freeze({ x: 5, z: 0 }),
    metadata: Object.freeze({ candidateRadiusMeters: 0.2 }),
  });
  const chunk = canonicalChunk(5, 0, []);
  chunk.vegetationCandidates = [tree, bush];
  chunk.rockCandidates = [rock];
  chunk.presentationLayers.natural = { vegetation: [tree, bush], rocks: [rock] };
  let activeState = new InfiniteWorldState({
    worldSeed: 'vegetation-continue',
    worldSeedHash: CANONICAL_WORLD_SEED_HASH,
    playerSpawn: { x: 8, z: 8 },
  });
  const scene = new DistantTestGroup();
  const presentation = await createW8DistantPresentation({
    THREE: DISTANT_TEST_THREE,
    scene,
    worldSeedHash: CANONICAL_WORLD_SEED_HASH,
    visualAssets: createDistantTestVisualAssets(),
    findSettlementsNear: async () => [],
    resolveTemplate: async () => null,
    getCanonicalChunkData: async () => chunk,
    isFeatureDestroyed: stableId => activeState.isFeatureDestroyed(stableId),
    incrementalStaticTreePages: true,
  });
  t.after(() => presentation.dispose());
  const midInput = canonicalSyncInput({
    centerChunkX: 3, activeDataKeys: ['5,0'], renderedKeys: [], chunk,
  });
  assert.equal(await presentation.sync(midInput), true);
  presentation.applyStaticNaturalPlan({
    coverageGeneration: 1,
    planRevision: 1,
    planId: 'destroyed-presentation-owner',
    destructionRevision: 'none',
    quality: 'high',
    renderDistancePreset: 'current',
    renderOrigin: midInput.renderOrigin,
    playerLogicalX: midInput.playerLogicalX,
    playerLogicalZ: midInput.playerLogicalZ,
    activeDataKeys: midInput.activeDataKeys,
    renderedKeys: midInput.renderedKeys,
    retainedOwnerKeys: ['5,0'],
    resourceKindEntries: [['5,0', 'presentation']],
    readyPages: [{
      ownerKey: '5,0', resourceKind: 'presentation', value: chunk,
      readyAtMs: performance.now(), required: true,
    }],
  });
  for (let frame = 0; frame < 100
    && presentation.snapshot().staticTreeCurrentPublishedOwnerCount !== 1; frame += 1) {
    presentation.update(8, 8, midInput.renderOrigin);
    await new Promise(resolve => setImmediate(resolve));
  }
  const coarseTreeDrawable = () => {
    const nodes = [...scene.children];
    while (nodes.length > 0) {
      const node = nodes.shift();
      nodes.push(...(node.children ?? []));
      if (node.userData?.canonicalCoarseTreeSubmission !== true) continue;
      if ((node.userData?.canonicalStableIds ?? []).slice(0, node.count)
        .some((stableId, slot) => (
          stableId === tree.candidateId
            && (node.userData?.canonicalOpacities?.[slot] ?? 0) > 0
        ))) return true;
    }
    return false;
  };
  assert.equal(coarseTreeDrawable(), true,
    'fixture must begin with one submitted coarse Tree presenter');
  const contract = W6_STATIC_TARGET_CONTRACTS.tree;
  activeState.damageFeature(
    { stableId: tree.candidateId, maxHp: contract.maxHp },
    contract.maxHp,
  );
  presentation.advanceStaticNaturalFrame({
    coverageGeneration: 1,
    planRevision: 1,
    planId: 'destroyed-presentation-owner',
    destructionRevision: tree.candidateId,
    playerLogicalX: 8,
    playerLogicalZ: 8,
    activeDataKeys: midInput.activeDataKeys,
    renderedKeys: midInput.renderedKeys,
  });
  for (let frame = 0; frame < 32 && coarseTreeDrawable(); frame += 1) {
    presentation.update(8, 8, midInput.renderOrigin);
    await new Promise(resolve => setImmediate(resolve));
  }
  const coarseAudit = presentation.canonicalAuditSnapshot();
  assert.equal(activeState.isFeatureDestroyed(tree.candidateId), true);
  assert.equal(coarseTreeDrawable(), false,
    'destroyed Tree identity remains resident but cannot remain in the draw prefix');
  assert.equal(coarseAudit.length, 1,
    'Bush and Rock remain Full/Near detail and have no persistent coarse slots');
  for (const object of coarseAudit) {
    assert.ok(object.instanceCount > 0,
      'destruction hides but does not rebuild the Presentation-owned Stable ID slots');
    assert.equal(object.ownerKey, '5,0');
  }
  assert.equal(presentation.snapshot().naturalLodVisibleInstanceCount, 0);

  const serialized = await encodeInfiniteWorldSave(activeState.createSaveSnapshot());
  const decoded = await decodeInfiniteWorldSave(serialized, {
    worldSeedHash: CANONICAL_WORLD_SEED_HASH,
  });
  const restored = new InfiniteWorldState({
    worldSeed: 'vegetation-continue',
    worldSeedHash: CANONICAL_WORLD_SEED_HASH,
    playerSpawn: { x: 8, z: 8 },
  });
  restored.restoreSaveSnapshot(decoded);
  activeState = restored;
  for (const input of [
    canonicalSyncInput({ centerChunkX: 0, activeDataKeys: [], renderedKeys: [], chunk }),
    canonicalSyncInput({
      centerChunkX: 4, activeDataKeys: ['5,0'], renderedKeys: ['5,0'], chunk,
    }),
    canonicalSyncInput({ centerChunkX: 0, activeDataKeys: [], renderedKeys: [], chunk }),
  ]) {
    assert.equal(await presentation.sync(input), true);
    assert.equal(activeState.isFeatureDestroyed(tree.candidateId), true);
    assert.equal(coarseTreeDrawable(), false,
      'Save Continue and distance changes must not resubmit the destroyed Tree');
    assert.equal(presentation.snapshot().naturalLodVisibleInstanceCount, 0);
  }
  presentation.dispose();
});

test('Vegetation density 2x, 5x, and 10x keeps Material, Mesh, Geometry, and Draw fixed', async t => {
  const rows = [];
  const baseCount = 8;
  for (const multiplier of [1, 2, 5, 10]) {
    const trees = Object.freeze(Array.from({ length: baseCount * multiplier }, (_, index) => (
      Object.freeze({
        candidateId: `detail-v1:vegetation:density-${multiplier}:${index}`,
        subtype: 'broadleaf-tree', variationSeed: (index % 7) / 7,
        orientationSeed: (index % 11) / 11,
        worldPosition: Object.freeze({
          x: 82 + (index % 12), y: 0.4, z: 1 + (Math.floor(index / 12) % 14),
        }),
        owningChunkCoordinate: Object.freeze({ x: 5, z: 0 }),
        metadata: Object.freeze({ candidateRadiusMeters: 0.32 }),
      })
    )));
    const chunk = canonicalChunk(5, 0, []);
    chunk.vegetationCandidates = trees;
    chunk.presentationLayers.natural.vegetation = trees;
    const scene = new DistantTestGroup();
    const assets = createDistantTestVisualAssets();
    const heapBefore = process.memoryUsage().heapUsed;
    const presentation = await createW8DistantPresentation({
      THREE: DISTANT_TEST_THREE,
      scene,
      worldSeedHash: CANONICAL_WORLD_SEED_HASH,
      visualAssets: assets,
      findSettlementsNear: async () => [],
      resolveTemplate: async () => null,
      getCanonicalChunkData: async () => chunk,
      incrementalStaticTreePages: true,
    });
    const startedAt = performance.now();
    const input = canonicalSyncInput({
      centerChunkX: 3, activeDataKeys: ['5,0'], renderedKeys: [], chunk,
    });
    assert.equal(await presentation.sync(input), true);
    presentation.applyStaticNaturalPlan({
      coverageGeneration: 1,
      planRevision: 1,
      planId: `density-presentation-owner:${multiplier}`,
      destructionRevision: 'none',
      quality: 'high',
      renderDistancePreset: 'current',
      renderOrigin: input.renderOrigin,
      playerLogicalX: input.playerLogicalX,
      playerLogicalZ: input.playerLogicalZ,
      activeDataKeys: input.activeDataKeys,
      renderedKeys: input.renderedKeys,
      retainedOwnerKeys: ['5,0'],
      resourceKindEntries: [['5,0', 'presentation']],
      readyPages: [{
        ownerKey: '5,0', resourceKind: 'presentation', value: chunk,
        readyAtMs: performance.now(), required: true,
      }],
    });
    for (let frame = 0; frame < 100
      && presentation.snapshot().staticTreeCurrentPublishedOwnerCount !== 1; frame += 1) {
      presentation.update(input.playerLogicalX, input.playerLogicalZ, input.renderOrigin);
      await new Promise(resolve => setImmediate(resolve));
    }
    const syncMs = performance.now() - startedAt;
    const updateStartedAt = performance.now();
    for (let frame = 0; frame < 120; frame += 1) {
      presentation.update(8 + frame % 2, 8, { renderOriginChunkX: 0, renderOriginChunkZ: 0 });
    }
    const updateMeanMs = (performance.now() - updateStartedAt) / 120;
    const snapshot = presentation.snapshot();
    const naturalRoot = scene.children.find(child => (
      child.name === 'w8-persistent-static-natural-pages'
    ));
    const naturalMeshes = naturalRoot.children.filter(mesh => (
      mesh.material?.userData?.naturalLod === true
    ));
    const geometries = new Set(naturalMeshes.map(mesh => mesh.geometry));
    const materials = new Set(naturalMeshes.map(mesh => mesh.material));
    rows.push({
      multiplier,
      treeCount: trees.length,
      fpsEquivalent: Math.round(1000 / updateMeanMs),
      draw: snapshot.naturalLodDrawCallEquivalent,
      mesh: snapshot.naturalLodMeshCount,
      material: snapshot.naturalLodMaterialCount,
      geometry: snapshot.naturalLodGeometryCount,
      instance: snapshot.naturalLodVisibleInstanceCount,
      heapDeltaBytes: process.memoryUsage().heapUsed - heapBefore,
      syncMs: Math.round(syncMs * 1000) / 1000,
      sliceMs: Math.round(snapshot.farLastMaximumSliceMs * 1000) / 1000,
      updateMeanMs: Math.round(updateMeanMs * 1e6) / 1e6,
    });
    presentation.dispose();
    assert.equal(scene.children.length, 0);
    assert.equal([...geometries].every(geometry => geometry.disposed === true), true);
    assert.equal([...materials].every(material => material.disposed === true), true);
  }
  const fixed = key => new Set(rows.map(row => row[key])).size === 1;
  for (const key of ['draw', 'mesh', 'material', 'geometry']) assert.equal(fixed(key), true, key);
  assert.deepEqual(rows.map(row => row.instance), [8, 16, 40, 80],
    'the final coarse renderer submits exactly one canonical slot per Tree');
  t.diagnostic(JSON.stringify(rows));
});

test('coarse Tree submits one immutable world-admitted set at every observer distance', async t => {
  const trees = Object.freeze(Array.from({ length: 5 }, (_, index) => Object.freeze({
    candidateId: `detail-v1:vegetation:submitted-density:${index}`,
    subtype: 'broadleaf-tree',
    variationSeed: index / 10,
    orientationSeed: (index + 1) / 11,
    densityRank: index / 10 + 0.05,
    worldPosition: Object.freeze({ x: 82 + index, y: 0.4, z: 8 }),
    owningChunkCoordinate: Object.freeze({ x: 5, z: 0 }),
    metadata: Object.freeze({ candidateRadiusMeters: 0.32 }),
  })));
  const chunk = canonicalChunk(5, 0, []);
  chunk.vegetationCandidates = trees;
  chunk.presentationLayers.natural.vegetation = trees;
  const scene = new DistantTestGroup();
  const presentation = await createW8DistantPresentation({
    THREE: DISTANT_TEST_THREE,
    scene,
    worldSeedHash: CANONICAL_WORLD_SEED_HASH,
    visualAssets: createSilhouetteTestVisualAssets(),
    findSettlementsNear: async () => [],
    resolveTemplate: async () => null,
    getCanonicalChunkData: async () => chunk,
    incrementalStaticTreePages: true,
  });
  t.after(() => presentation.dispose());
  // The first Tree anchors are 307–316 m from this Player position: outside
  // the 300 m visual circle but inside the retained owner-corner coarse domain.
  const farPlayerX = -225;
  const input = canonicalSyncInput({
    centerChunkX: 3,
    activeDataKeys: ['5,0'],
    renderedKeys: [],
    chunk,
    playerLogicalX: farPlayerX,
  });
  assert.equal(await presentation.sync(input), true);
  presentation.applyStaticNaturalPlan({
    coverageGeneration: 1,
    planRevision: 1,
    planId: 'submitted-density-prefix',
    destructionRevision: 'none',
    quality: 'high',
    renderDistancePreset: 'current',
    renderOrigin: input.renderOrigin,
    playerLogicalX: farPlayerX,
    playerLogicalZ: 8,
    activeDataKeys: input.activeDataKeys,
    renderedKeys: input.renderedKeys,
    retainedOwnerKeys: ['5,0'],
    resourceKindEntries: [['5,0', 'presentation']],
    readyPages: [{
      ownerKey: '5,0', resourceKind: 'presentation', value: chunk,
      readyAtMs: performance.now(), required: true,
    }],
  });
  for (let frame = 0; frame < 100
    && presentation.snapshot().staticTreeResidentOwnerCount !== 1; frame += 1) {
    presentation.update(farPlayerX, 8, input.renderOrigin);
    await new Promise(resolve => setImmediate(resolve));
  }
  const root = scene.children.find(child => (
    child.name === 'w8-persistent-static-natural-pages'
  ));
  const mesh = root.children.find(child => (
    child.userData?.canonicalCoarseTreeSubmission === true
      && child.userData?.treePathMode === 'far'
  ));
  const midMesh = root.children.find(child => (
    child.userData?.canonicalCoarseTreeSubmission === true
      && child.userData?.treePathMode === 'forest'
  ));
  assert.ok(mesh);
  assert.ok(midMesh);
  const residentAudit = Object.fromEntries(presentation.canonicalAuditSnapshot().map(value => (
    [value.identity.stableId, value]
  )));
  for (const tree of trees) {
    assert.ok(['mid', 'far'].includes(residentAudit[tree.candidateId].visibleLod),
      'owner-corner safety pages enter persistent coarse visibility at build commit');
    assert.equal(residentAudit[tree.candidateId].presentationTier, 'natural-lod');
  }
  for (let frame = 0; frame < 100
    && presentation.snapshot().staticTreeCurrentPublishedOwnerCount !== 1; frame += 1) {
    presentation.update(farPlayerX, 8, input.renderOrigin);
    await new Promise(resolve => setImmediate(resolve));
  }
  const farSnapshot = presentation.snapshot();
  const trianglesPerTree = mesh.geometry.userData.canonicalFarTreeTriangleCount;
  assert.equal(mesh.count, trees.length);
  assert.equal(midMesh.count, trees.length);
  assert.equal(farSnapshot.canonicalFarTreeInstanceCapacity, trees.length,
    'the world-level admitted Stable-ID set is the renderer capacity');
  assert.equal(farSnapshot.canonicalFarTreeVisibleInstanceCount, trees.length);
  assert.equal(farSnapshot.canonicalFarTreeTriangleCount, trianglesPerTree * trees.length);
  assert.deepEqual(
    mesh.userData.canonicalObjects.slice(0, mesh.count).map(record => record.stableId).sort(),
    trees.map(tree => tree.candidateId).sort(),
  );

  const monotonicSubmittedCounts = [mesh.count];
  const submissionScanCount = farSnapshot.staticTreeSubmissionObjectScanCount;
  for (const playerX of [-44, 0, 56]) {
    for (let frame = 0; frame < 4; frame += 1) {
      presentation.update(playerX, 8, input.renderOrigin);
      await new Promise(resolve => setImmediate(resolve));
    }
    monotonicSubmittedCounts.push(mesh.count);
  }
  assert.deepEqual(monotonicSubmittedCounts, [5, 5, 5, 5],
    'observer distance changes geometry opacity, never Tree existence');
  assert.equal(new Set(mesh.userData.canonicalStableIds.slice(0, mesh.count)).size, 5);
  assert.equal(presentation.snapshot().staticTreeSubmissionObjectScanCount,
    submissionScanCount,
    'player motion does not rescan or rewrite the immutable admitted prefix');
  assert.equal(mesh.geometry.attributes.w8NaturalDensityRank, undefined,
    'renderer-side distance density attributes are removed');

  markCompletedRenderFrame(presentation, scene);
  const firstReceiptSnapshot = presentation.snapshot();
  markCompletedRenderFrame(presentation, scene);
  const secondReceiptSnapshot = presentation.snapshot();
  assert.equal(secondReceiptSnapshot.markFirstDrawCanonicalObjectScanCount,
    firstReceiptSnapshot.markFirstDrawCanonicalObjectScanCount,
    'diagnostics-off completed receipts do not rescan canonical Tree objects');
  assert.equal(secondReceiptSnapshot.markFirstDrawReceiptEarlyOutCount,
    firstReceiptSnapshot.markFirstDrawReceiptEarlyOutCount + 1);

  for (let frame = 0; frame < 4; frame += 1) {
    presentation.update(farPlayerX, 8, input.renderOrigin);
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(mesh.count, trees.length);
  assert.deepEqual(
    mesh.userData.canonicalObjects.slice(0, mesh.count).map(record => record.stableId).sort(),
    trees.map(tree => tree.candidateId).sort(),
    'retreat keeps the same world-admitted Stable-ID set without rebuilding identity',
  );

  const receiptPlayerX = farPlayerX + 7.25;
  assert.equal(presentation.advanceStaticNaturalFrame({
    coverageGeneration: 1,
    planRevision: 1,
    planId: 'submitted-density-prefix',
    destructionRevision: 'none',
    playerLogicalX: receiptPlayerX,
    playerLogicalZ: 8,
    activeDataKeys: input.activeDataKeys,
    renderedKeys: input.renderedKeys,
  }), true);
  for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
    const playerUniform = material.userData?.naturalLodUniforms?.w8NaturalPlayerLocalXZ?.value;
    assert.ok(playerUniform, 'coarse Tree materials expose the renderer distance uniform');
    assert.equal(playerUniform.x, (
      receiptPlayerX - input.renderOrigin.renderOriginChunkX * LEGACY_CHUNK_SIZE_METERS
    ) * (RENDER_CHUNK_SIZE / LEGACY_CHUNK_SIZE_METERS),
      'frame input updates the GPU distance source before bounded Natural work runs');
    assert.equal(playerUniform.y, (
      8 - input.renderOrigin.renderOriginChunkZ * LEGACY_CHUNK_SIZE_METERS
    ) * (RENDER_CHUNK_SIZE / LEGACY_CHUNK_SIZE_METERS));
  }
});

test('direct 64m canonical Tree batch exclusively publishes one identity through Mid Far and Near', async t => {
  const generator = await createW8ParityChunkGenerator({
    worldSeed: 'KaniNingen Infinite Natural World',
  });
  const batch = await generator.generateCanonicalTreeCell(0, 0);
  assert.ok(batch.trees.length > 0, 'real canonical batch fixture must contain Trees');
  const target = batch.trees[0];
  const ownerKey = batch.ownerKeys[0];
  const [ownerX, ownerZ] = ownerKey.split(',').map(Number);
  const presentationOwner = await generator.generatePresentationOwner(ownerX, ownerZ);
  let nearReceiptIds = [];
  let nearPublishedIds = [];
  const destroyed = new Set();
  let targetRequestCount = 0;
  let nonTargetRequestCount = 0;
  const never = new Promise(() => {});
  const scene = new DistantTestGroup();
  const presentation = await createW8DistantPresentation({
    THREE: Object.freeze({
      ...DISTANT_TEST_THREE,
      Uint32BufferAttribute: DistantTestFloat32BufferAttribute,
    }),
    scene,
    worldSeedHash: generator.worldSeedHash,
    visualAssets: createSilhouetteTestVisualAssets(),
    findSettlementsNear: async () => [],
    resolveTemplate: async () => null,
    getCanonicalChunkData: async () => null,
    getNearVisibleStableIds: () => nearReceiptIds,
    getNearPublishedStableIds: () => nearPublishedIds,
    isFeatureDestroyed: stableId => destroyed.has(stableId),
    incrementalStaticTreePages: true,
    enableMacroCoarseWorld: true,
    generateCanonicalTreeCell: async ({ macroX, macroZ }) => {
      if (macroX === 0 && macroZ === 0) {
        targetRequestCount += 1;
        return batch;
      }
      nonTargetRequestCount += 1;
      return never;
    },
  });
  t.after(async () => {
    presentation.dispose();
    await generator.shutdown();
  });
  const renderOrigin = Object.freeze({
    renderOriginChunkX: 0,
    renderOriginChunkZ: 0,
    rebaseCount: 0,
  });
  const apply = (revision, readyPages = [], quality = 'high') => (
    presentation.applyStaticNaturalPlan({
    coverageGeneration: revision,
    planRevision: revision,
    planId: `direct-tree:${revision}`,
    destructionRevision: [...destroyed].sort().join('\n') || 'none',
    quality,
    renderDistancePreset: 'current',
    renderOrigin,
    playerLogicalX: 8,
    playerLogicalZ: 8,
    activeDataKeys: batch.ownerKeys,
    renderedKeys: [],
    retainedOwnerKeys: batch.ownerKeys,
    resourceKindEntries: batch.ownerKeys.map(ownerKey => [ownerKey, 'presentation']),
    readyPages,
    })
  );
  const presentationPage = {
    ownerKey,
    resourceKind: 'presentation',
    value: presentationOwner.resource,
    readyAtMs: performance.now(),
    required: true,
  };
  assert.equal(apply(1, [presentationPage]), true,
    'PresentationOwner may complete first without becoming Tree authority');
  for (let frame = 0; frame < 240; frame += 1) {
    presentation.update(8, 8, renderOrigin);
    await new Promise(resolve => setImmediate(resolve));
    const snapshot = presentation.snapshot();
    if (snapshot.macroCoarseWorld.canonicalTreeResidentCellCount === 1
      && snapshot.staticTreeCurrentPublishedOwnerCount === 16) break;
  }
  let snapshot = presentation.snapshot();
  assert.equal(targetRequestCount, 1, 'one Macro cell is one logical Tree-only request');
  assert.ok(nonTargetRequestCount <= 2,
    'bounded in-flight work cannot fan out into per-owner requests');
  assert.equal(snapshot.macroCoarseWorld.canonicalTreePreparedCellCount, 1);
  assert.equal(snapshot.macroCoarseWorld.canonicalTreeResidentCellCount, 1);
  assert.equal(snapshot.staticTreeCurrentPublishedOwnerCount, 16);
  assert.equal(presentation.presenterAuditSnapshot().duplicatePresenterCount, 0);

  let audit = Object.fromEntries(presentation.canonicalAuditSnapshot().map(value => (
    [value.identity.stableId, value]
  )));
  assert.equal(Object.keys(audit).length, batch.trees.length);
  assert.deepEqual(audit[target.stableId].identity.worldPosition, {
    x: target.position[0], y: target.position[1], z: target.position[2],
  });
  assert.equal(audit[target.stableId].instanceCount, 2);
  assert.deepEqual([
    audit[target.stableId].naturalLod.forestInstanceCount,
    audit[target.stableId].naturalLod.farInstanceCount,
  ], [1, 1]);
  const persistentRoot = scene.children.find(child => (
    child.name === 'w8-persistent-static-natural-pages'
  ));
  const tierMeshes = persistentRoot.children.filter(child => (
    child.userData?.canonicalCoarseTreeSubmission === true
  ));
  assert.ok(tierMeshes.some(mesh => mesh.userData.treePathMode === 'forest'
    && mesh.geometry.userData.canonicalFarTreePartCount === 2));
  assert.ok(tierMeshes.some(mesh => mesh.userData.treePathMode === 'far'
    && mesh.geometry.userData.canonicalFarTreePartCount === 1));

  const rebuildsBeforeRace = snapshot.staticTreeOwnerRebuildCount;
  assert.equal(apply(2, [{ ...presentationPage, readyAtMs: performance.now() }]), true);
  presentation.update(8, 8, renderOrigin);
  snapshot = presentation.snapshot();
  assert.equal(snapshot.staticTreeOwnerRebuildCount, rebuildsBeforeRace,
    'later PresentationOwner completion cannot rebuild the direct Tree authority');
  assert.equal(presentation.presenterAuditSnapshot().duplicatePresenterCount, 0);

  nearPublishedIds = [target.stableId];
  presentation.update(8, 8, renderOrigin);
  audit = Object.fromEntries(presentation.canonicalAuditSnapshot().map(value => (
    [value.identity.stableId, value]
  )));
  assert.notEqual(audit[target.stableId].visibleLod, 'near',
    'Near publication without a completed receipt cannot release coarse coverage');
  nearReceiptIds = [target.stableId];
  presentation.update(8, 8, renderOrigin);
  audit = Object.fromEntries(presentation.canonicalAuditSnapshot().map(value => (
    [value.identity.stableId, value]
  )));
  assert.equal(audit[target.stableId].visibleLod, 'near');
  assert.deepEqual([
    audit[target.stableId].naturalLod.forestInstanceCount,
    audit[target.stableId].naturalLod.farInstanceCount,
  ], [0, 0]);
  nearPublishedIds = [];
  nearReceiptIds = [];
  presentation.update(8, 8, renderOrigin);
  audit = Object.fromEntries(presentation.canonicalAuditSnapshot().map(value => (
    [value.identity.stableId, value]
  )));
  assert.deepEqual([
    audit[target.stableId].naturalLod.forestInstanceCount,
    audit[target.stableId].naturalLod.farInstanceCount,
  ], [1, 1], 'Near departure restores the same canonical identity in both LOD tiers');

  destroyed.add(target.stableId);
  presentation.advanceStaticNaturalFrame({
    coverageGeneration: 2,
    planRevision: 2,
    planId: 'direct-tree:2',
    destructionRevision: target.stableId,
    playerLogicalX: 8,
    playerLogicalZ: 8,
    activeDataKeys: batch.ownerKeys,
    renderedKeys: [],
  });
  for (let frame = 0; frame < 32; frame += 1) {
    presentation.update(8, 8, renderOrigin);
    await new Promise(resolve => setImmediate(resolve));
    audit = Object.fromEntries(presentation.canonicalAuditSnapshot().map(value => (
      [value.identity.stableId, value]
    )));
    if (audit[target.stableId].visibleLod === 'destroyed') break;
  }
  assert.equal(audit[target.stableId].visibleLod, 'destroyed');
  assert.deepEqual([
    audit[target.stableId].naturalLod.forestInstanceCount,
    audit[target.stableId].naturalLod.farInstanceCount,
  ], [0, 0]);

  assert.equal(apply(3, [{ ...presentationPage, readyAtMs: performance.now() }], 'low'), true);
  for (let frame = 0; frame < 240; frame += 1) {
    presentation.update(8, 8, renderOrigin);
    await new Promise(resolve => setImmediate(resolve));
    snapshot = presentation.snapshot();
    if (snapshot.staticTreeCurrentPublishedOwnerCount === 16
      && snapshot.naturalVisibilityRetainedGenerationPending === false) break;
  }
  audit = Object.fromEntries(presentation.canonicalAuditSnapshot().map(value => (
    [value.identity.stableId, value]
  )));
  assert.equal(audit[target.stableId].visibleLod, 'destroyed',
    'direct batch replay after a generation reset cannot resurrect destroyed identity');
  assert.equal(scene.children.filter(child => (
    child.name === 'w8-persistent-static-natural-pages'
  )).length, 1, 'old-until-new replacement keeps one attached canonical Tree root');
});

test('canonical settlement identity hands off exclusively and destruction survives distance and save/load', async () => {
  const scene = new DistantTestGroup();
  let activeState = new InfiniteWorldState({
    worldSeed: 'gate-a-canonical',
    worldSeedHash: CANONICAL_WORLD_SEED_HASH,
    playerSpawn: { x: 8, z: 8 },
  });
  let holdNextQuery = false;
  let releaseHeldQuery = null;
  let nearVisibleStableIds = [];
  const presentation = await createW8DistantPresentation({
    THREE: DISTANT_TEST_THREE,
    scene,
    worldSeedHash: CANONICAL_WORLD_SEED_HASH,
    visualAssets: createDistantTestVisualAssets(),
    findSettlementsNear: async () => {
      if (!holdNextQuery) return [CANONICAL_CANDIDATE];
      return new Promise(resolve => {
        releaseHeldQuery = () => resolve([CANONICAL_CANDIDATE]);
      });
    },
    resolveTemplate: async () => CANONICAL_TEMPLATE,
    getCanonicalChunkData: async (chunkX, chunkZ) =>
      chunkX === 5 && chunkZ === 0 ? canonicalChunk() : null,
    isFeatureDestroyed: stableId => activeState.isFeatureDestroyed(stableId),
    getNearVisibleStableIds: () => nearVisibleStableIds,
  });
  const expectedIdentity = {
    stableId: CANONICAL_BUILDING_ID,
    settlementId: CANONICAL_SETTLEMENT_ID,
    buildingType: 'house',
    landmarkType: null,
    featureType: 'settlement-building',
    worldPosition: { x: 88, y: 0.4, z: 8 },
    rotationY: 0.375,
    dimensions: { widthMeters: 6, heightMeters: 4, depthMeters: 5 },
    visual: { paletteIndex: 2, roofVariant: 'gable' },
    parts: [{
      geometry: 'box',
      material: 'houseWall',
      position: [0, 0.5, 0],
      scale: [1, 1, 1],
      rotation: [0, 0, 0],
      materialRole: 'wall',
    }],
    owningChunkCoordinate: { x: 5, z: 0 },
    chunkId: 'w8-parity-chunk:5,0',
    canonicalSourceRevision: `${CANONICAL_WORLD_SEED_HASH}:800`,
    sourceW5ContentHash: `sha256:${'2'.repeat(64)}`,
  };
  const states = [
    {
      lod: 'far',
      input: canonicalSyncInput({
        centerChunkX: 0,
        activeDataKeys: [],
        renderedKeys: [],
      }),
    },
    {
      lod: 'mid',
      input: canonicalSyncInput({
        centerChunkX: 3,
        activeDataKeys: ['5,0'],
        renderedKeys: [],
      }),
    },
    {
      lod: 'near',
      input: canonicalSyncInput({
        centerChunkX: 4,
        activeDataKeys: ['5,0'],
        renderedKeys: ['5,0'],
      }),
    },
    {
      lod: 'mid',
      input: canonicalSyncInput({
        centerChunkX: 3,
        activeDataKeys: ['5,0'],
        renderedKeys: [],
      }),
    },
    {
      lod: 'far',
      input: canonicalSyncInput({
        centerChunkX: 0,
        activeDataKeys: [],
        renderedKeys: [],
      }),
    },
  ];

  for (const state of states) {
    nearVisibleStableIds = state.lod === 'near' ? [CANONICAL_BUILDING_ID] : [];
    assert.equal(await presentation.sync(state.input), true);
    const [object] = presentation.canonicalAuditSnapshot();
    assert.deepEqual(object.identity, expectedIdentity);
    assert.equal(object.visibleLod, state.lod);
    assert.equal(object.instanceCount, 2);
    assert.equal(object.composedInstanceCount, state.lod === 'near' ? 0 : 1);
    assert.equal(object.ownerKey, '5,0');
    assert.equal(object.ownerActive, state.lod !== 'far');
    assert.equal(object.ownerRendered, state.lod === 'near');
    assert.equal(object.meshVisible, true);
    assert.ok(object.distanceMeters >= 0);
    const snapshot = presentation.snapshot();
    const nearOwnerCount = state.lod === 'near' ? 1 : 0;
    assert.equal(snapshot.visibleCanonicalObjectCount + nearOwnerCount, 1);
    assert.equal(snapshot.canonicalNearObjectCount, nearOwnerCount);
    assert.equal(snapshot.canonicalBuildingRecordCount, 1);
    assert.equal(snapshot.canonicalLandmarkRecordCount, 0);
    assert.equal(snapshot.canonicalRoadRecordCount, 0);
    assert.equal(snapshot.canonicalMeshCount, 2);
    assert.equal(snapshot.canonicalVisibleMeshCount, 2);
    assert.equal(snapshot.queryCandidateCount, 1);
    assert.equal(snapshot.queryTemplateSuccessCount, 1);
    assert.equal(snapshot.queryNaturalOwnerChunkCount, 0);
    assert.equal(snapshot.queryNaturalCandidateCount, 0);
    assert.equal(snapshot.queryOwnerChunkKeys.length, snapshot.queryOwnerChunkCount);
    assert.equal(new Set(snapshot.queryOwnerChunkKeys).size, snapshot.queryOwnerChunkCount);
    assert.equal(snapshot.queryCanonicalChunkSuccessCount, state.lod === 'far' ? 1 : 0);
    assert.equal(snapshot.querySettlementFeatureCount, state.lod === 'far' ? 1 : 0);
    assert.equal(snapshot.queryLandmarkCount, 0);
    assert.equal(snapshot.rootAttached, true);
    assert.equal(snapshot.duplicateVisibleStableIdCount, 0);
    assert.equal(scene.children[0].children.length, 1);
  }

  presentation.update(1_000, 1_000, {
    renderOriginChunkX: 0,
    renderOriginChunkZ: 0,
  });
  assert.equal(presentation.canonicalAuditSnapshot()[0].visibleLod, 'hidden');
  presentation.update(8, 8, {
    renderOriginChunkX: 0,
    renderOriginChunkZ: 0,
  });
  assert.equal(presentation.canonicalAuditSnapshot()[0].visibleLod, 'far');
  assert.equal(presentation.snapshot().visibilityMeters, W8_CANONICAL_VISIBILITY_METERS.current);

  holdNextQuery = true;
  const staleSync = presentation.sync(canonicalSyncInput({
    centerChunkX: 0,
    activeDataKeys: [],
    renderedKeys: [],
  }));
  while (!releaseHeldQuery) await new Promise(resolve => setImmediate(resolve));
  assert.equal(scene.children[0].children.length, 1);
  holdNextQuery = false;
  assert.equal(await presentation.sync(canonicalSyncInput({
    centerChunkX: 3,
    activeDataKeys: ['5,0'],
    renderedKeys: [],
  })), true);
  const committedBeforeRelease = presentation.snapshot().committedEpoch;
  releaseHeldQuery();
  assert.equal(await staleSync, false);
  const afterStale = presentation.snapshot();
  assert.equal(afterStale.committedEpoch, committedBeforeRelease);
  assert.ok(afterStale.staleEpochDiscardCount >= 1);
  assert.equal(scene.children[0].children.length, 1);
  assert.equal(
    scene.children[0].children[0].userData.epoch,
    afterStale.committedEpoch,
  );

  const conflictingBuilding = {
    ...CANONICAL_BUILDING,
    rotationY: CANONICAL_BUILDING.rotationY + 0.25,
  };
  const rootBeforeConflict = scene.children[0].children[0];
  await assert.rejects(
    presentation.sync(canonicalSyncInput({
      centerChunkX: 3,
      activeDataKeys: ['5,0'],
      renderedKeys: [],
      chunk: canonicalChunk(5, 0, [CANONICAL_BUILDING, conflictingBuilding]),
    })),
    /canonical LOD identity mismatch/,
  );
  assert.equal(scene.children[0].children.length, 1);
  assert.equal(scene.children[0].children[0], rootBeforeConflict);

  activeState.damageFeature(
    { stableId: CANONICAL_BUILDING_ID, maxHp: W6_STATIC_TARGET_CONTRACTS.house.maxHp },
    W6_STATIC_TARGET_CONTRACTS.house.maxHp,
  );
  presentation.update(8, 8, {
    renderOriginChunkX: 0,
    renderOriginChunkZ: 0,
  });
  assert.equal(presentation.canonicalAuditSnapshot()[0].visibleLod, 'destroyed');
  assert.equal(presentation.snapshot().visibleCanonicalObjectCount, 0);
  assert.equal(await presentation.sync(canonicalSyncInput({
    centerChunkX: 4,
    activeDataKeys: ['5,0'],
    renderedKeys: ['5,0'],
  })), true);
  assert.equal(presentation.canonicalAuditSnapshot()[0].visibleLod, 'destroyed');
  assert.equal(await presentation.sync(canonicalSyncInput({
    centerChunkX: 0,
    activeDataKeys: [],
    renderedKeys: [],
  })), true);
  assert.equal(presentation.canonicalAuditSnapshot()[0].visibleLod, 'destroyed');

  const serialized = await encodeInfiniteWorldSave(activeState.createSaveSnapshot());
  const decoded = await decodeInfiniteWorldSave(serialized, {
    worldSeedHash: CANONICAL_WORLD_SEED_HASH,
  });
  const restoredState = new InfiniteWorldState({
    worldSeed: 'gate-a-canonical',
    worldSeedHash: CANONICAL_WORLD_SEED_HASH,
    playerSpawn: { x: 8, z: 8 },
  });
  restoredState.restoreSaveSnapshot(decoded);
  activeState = restoredState;
  presentation.update(8, 8, {
    renderOriginChunkX: 0,
    renderOriginChunkZ: 0,
  });
  assert.equal(activeState.isFeatureDestroyed(CANONICAL_BUILDING_ID), true);
  assert.equal(presentation.canonicalAuditSnapshot()[0].visibleLod, 'destroyed');
  assert.equal(presentation.snapshot().visibleCanonicalObjectCount, 0);
  presentation.dispose();
});

test('canonical query caches are strict LRU bounds and never exceed four concurrent loads', async () => {
  const ownerPoints = [];
  for (let chunkZ = -4; chunkZ < 4; chunkZ += 1) {
    for (let chunkX = -5; chunkX < 5; chunkX += 1) {
      ownerPoints.push({ x: chunkX * 16 + 8, z: chunkZ * 16 + 8 });
    }
  }
  assert.equal(ownerPoints.length, 80);
  const candidates = Array.from({ length: 8 }, (_, index) => ({
    settlementId: `settlement-v1:cache-${index}`,
    settlementType: index === 0 ? 'RURAL' : index % 2 ? 'TOWN' : 'CITY',
    townType: index === 0 ? 'suburb' : index % 2 ? 'church_town' : 'capital',
    center: index === 0
      ? Object.freeze({ x: 8, z: 8 })
      : Object.freeze({ x: 260 + index * 70, z: 8 }),
  }));
  let providerConcurrency = 0;
  let maximumProviderConcurrency = 0;
  const presentation = await createW8DistantPresentation({
    THREE: DISTANT_TEST_THREE,
    scene: new DistantTestGroup(),
    worldSeedHash: CANONICAL_WORLD_SEED_HASH,
    visualAssets: createDistantTestVisualAssets(),
    findSettlementsNear: async () => candidates,
    resolveTemplate: async ({ candidate }) => {
      await new Promise(resolve => setImmediate(resolve));
      const index = Number(candidate.settlementId.split('-').at(-1));
      return {
        settlementId: candidate.settlementId,
        settlementType: candidate.settlementType,
        townType: candidate.townType,
        center: candidate.center,
        buildings: ownerPoints.slice(index * 10, index * 10 + 10).map((point, buildingIndex) => ({
          stableId: `${candidate.settlementId}:building:${buildingIndex}`,
          settlementId: candidate.settlementId,
          buildingType: 'house',
          x: index === 0 ? point.x : candidate.center.x + (buildingIndex - 5) * 2,
          z: candidate.center.z + (buildingIndex % 3) * 2,
          widthMeters: 6, heightMeters: 4, depthMeters: 5, rotationY: 0,
        })),
        roads: [],
      };
    },
    getCanonicalChunkData: async (chunkX, chunkZ) => {
      providerConcurrency += 1;
      maximumProviderConcurrency = Math.max(maximumProviderConcurrency, providerConcurrency);
      await new Promise(resolve => setImmediate(resolve));
      providerConcurrency -= 1;
      return canonicalChunk(chunkX, chunkZ, []);
    },
  });
  assert.equal(await presentation.sync({
    activeDataKeys: [],
    renderedKeys: [],
    getChunkData: () => null,
    renderOrigin: { renderOriginChunkX: 0, renderOriginChunkZ: 0 },
    centerChunkX: 0,
    centerChunkZ: 0,
    quality: 'high',
    playerLogicalX: 8,
    playerLogicalZ: 8,
  }), true);
  const snapshot = presentation.snapshot();
  assert.equal(snapshot.queryCandidateCount, 8);
  assert.equal(snapshot.queryTemplateSuccessCount, 5);
  assert.equal(snapshot.queryRemoteSelectedCount, 4);
  assert.ok(snapshot.queryOwnerChunkCount > 4);
  assert.equal(snapshot.queryNaturalOwnerChunkCount, 0);
  assert.equal(snapshot.queryNaturalCandidateCount, 0);
  assert.equal(snapshot.queryOwnerChunkKeys.length, snapshot.queryOwnerChunkCount);
  assert.equal(snapshot.queryCanonicalChunkSuccessCount, snapshot.queryOwnerChunkCount);
  assert.equal(snapshot.templateCacheCapacity, 5);
  assert.equal(snapshot.templateCacheSize, 5);
  assert.equal(snapshot.farOwnerChunkCacheCapacity, 128);
  assert.equal(
    snapshot.farOwnerChunkCacheSize,
    Math.min(
      snapshot.queryOwnerChunkCount,
      snapshot.farOwnerChunkCacheCapacity,
    ),
  );
  assert.equal(snapshot.ultraOwnerChunkCacheCapacity, 0);
  assert.equal(snapshot.ultraOwnerChunkCacheSize, 0);
  assert.equal(snapshot.queryConcurrencyLimit, 4);
  assert.equal(snapshot.maximumObservedQueryConcurrency, 4);
  assert.equal(maximumProviderConcurrency, 4);
  presentation.dispose();
});

test('the absolute hitch ceiling and crossing regression remain explicit five-run gates', () => {
  const report = (p95, p99, hitchRatio) => ({
    frame: { p95, p99, max: p99 }, hitchRatio, longTasks: [], hitches: [],
  });
  const finiteReports = new Array(5).fill(null).map(() => report(22, 35, 0.008));
  const beforeW8Reports = new Array(5).fill(null).map(() => report(24, 38, 0.0048));
  const overAbsoluteLimit = new Array(5).fill(null).map(() => report(24, 38, 0.0051));
  const rejectedHitches = evaluateW8PerformanceRuns({
    scenario: 'normal', finiteReports, beforeW8Reports, w8Reports: overAbsoluteLimit,
  });
  assert.equal(rejectedHitches.pass, false);
  assert.equal(rejectedHitches.criteria.absoluteOver50Ratio, false);
  assert.equal(rejectedHitches.criteria.finiteRelativeOver50Ratio, false);
  assert.equal(rejectedHitches.limits.finiteRelativeOver50Ratio, 0.005);

  const allowed = new Array(5).fill(null).map(() => report(24, 38, 0.0049));
  const accepted = evaluateW8PerformanceRuns({
    scenario: 'normal', finiteReports, beforeW8Reports, w8Reports: allowed,
  });
  assert.equal(accepted.pass, true);
  assert.equal(accepted.limits.finiteRelativeOver50Ratio, 0.005);
  assert.equal(accepted.limits.beforeW8Over50Ratio, null);

  const regressed = new Array(5).fill(null).map(() => report(24.1, 38.1, 0.0049));
  const rejected = evaluateW8PerformanceRuns({
    scenario: 'crossing', finiteReports, beforeW8Reports, w8Reports: regressed,
  });
  assert.equal(rejected.pass, false);
  assert.equal(rejected.criteria.beforeW8P95, false);
  assert.equal(rejected.criteria.beforeW8P99, false);
  assert.equal(rejected.criteria.beforeW8Over50Ratio, false);
});
