import test from 'node:test';
import assert from 'node:assert/strict';
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
  createW8DistantPresentation,
  createW8ClipmapTopology,
  isW8DistantNaturalProxyInRange,
  isW8NaturalCandidateVisible,
  resolveW8CanonicalCandidateSet,
  resolveW8NaturalCandidateVisual,
  resolveW8PersistentNaturalBucketCapacity,
  sampleW8DistantTerrainAt,
  w8TerrainColorFromWeights,
} from '../src/infinite-world/render/w8-distant-presentation.js';
import { W6_STATIC_TARGET_CONTRACTS } from '../src/infinite-world/gameplay-contract.js';
import { RENDER_CHUNK_SIZE } from '../src/infinite-world/chunk-coordinates.js';
import { createCanonicalRiverProjection } from '../src/infinite-world/canonical-river-realization.js';
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
  isW8ForestHorizonOwner,
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
import {
  NATURAL_OWNER_BUILD_QUEUE_MAXIMUM,
  resolveNaturalOwnerBuildQueueTarget,
} from '../src/infinite-world/streaming-capacity-budget.js';

const LEGACY_CHUNK_SIZE_METERS = 16;
const LEGACY_FIVE_BY_FIVE_HALF_EXTENT_METERS = LEGACY_CHUNK_SIZE_METERS * 2.5;
const CANONICAL_WORLD_SEED_HASH = `sha256:${'0'.repeat(64)}`;

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
  constructor(value = {}) { this.value = structuredClone(value); }
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
  constructor() { this.attributes = {}; }
  clone() { return new this.constructor(); }
  setAttribute(name, attribute) { this.attributes[name] = attribute; }
  setIndex(index) { this.index = index; }
  computeVertexNormals() {}
  dispose() { this.disposed = true; }
}
class DistantTestBufferGeometry extends DistantTestGeometry {}
class DistantTestPlaneGeometry extends DistantTestGeometry {}
class DistantTestFloat32BufferAttribute {
  constructor(values, itemSize) { this.values = values; this.itemSize = itemSize; }
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
    this.instanceMatrix = { updateCount: 0 };
    Object.defineProperty(this.instanceMatrix, 'needsUpdate', {
      set(value) {
        if (value === true) this.updateCount += 1;
      },
    });
  }
  setMatrixAt(index, matrix) { this.matrices[index] = matrix.clone?.() ?? structuredClone(matrix); }
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
  geometry: 'sphere', material: 'treeLeaves', position: Object.freeze([0, 0.64, 0]),
  scale: Object.freeze([0.82, 0.72, 0.82]), rotation: Object.freeze([0, 0, 0]),
});
const SILHOUETTE_BROADLEAF_SECONDARY_PART = Object.freeze({
  geometry: 'sphere', material: 'treeLeaves', position: Object.freeze([0.22, 0.78, -0.12]),
  scale: Object.freeze([0.48, 0.45, 0.48]), rotation: Object.freeze([0, 0, 0]),
});
const SILHOUETTE_WETLAND_PRIMARY_PART = Object.freeze({
  geometry: 'sphere', material: 'wetlandLeaves', position: Object.freeze([0, 0.61, 0]),
  scale: Object.freeze([0.78, 0.68, 0.78]), rotation: Object.freeze([0, 0, 0]),
});
const SILHOUETTE_WETLAND_SECONDARY_PART = Object.freeze({
  geometry: 'sphere', material: 'wetlandLeaves', position: Object.freeze([-0.18, 0.76, 0.1]),
  scale: Object.freeze([0.44, 0.42, 0.44]), rotation: Object.freeze([0, 0, 0]),
});
const SILHOUETTE_CONIFER_PART = Object.freeze({
  geometry: 'cone', material: 'treeLeaves', position: Object.freeze([0, 0.65, 0]),
  scale: Object.freeze([0.76, 0.78, 0.76]), rotation: Object.freeze([0, 0, 0]),
});

function createSilhouetteTestVisualAssets() {
  const geometry = new DistantTestGeometry();
  const material = color => new DistantTestMaterial(
    Number.isFinite(color) ? { color } : {},
  );
  return {
    geometries: { box: geometry, sphere: geometry, cone: geometry },
    materials: {
      houseWall: material(), road: material(), lotResidential: material(), lotCivic: material(),
      water: material(), bush: material(), treeTrunk: material(), treeLeaves: material(0x2e7d32),
      treeLeavesForest: material(0x1b5e20), treeLeavesMeadow: material(0x7cb342),
      wetlandLeaves: material(),
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
      shrub: [SHRUB_PART], rock: [],
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
  return createW8DistantPresentation({
    THREE: DISTANT_TEST_THREE,
    scene,
    worldSeedHash: CANONICAL_WORLD_SEED_HASH,
    visualAssets: createDistantTestVisualAssets(),
    findSettlementsNear: async () => [],
    resolveTemplate: async () => null,
    getCanonicalChunkData: async (chunkX, chunkZ) => canonicalChunk(chunkX, chunkZ, []),
    ...overrides,
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

test('shrub visuals remain aligned across mid and near LOD', async () => {
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

  const scene = new DistantTestGroup();
  const chunk = canonicalChunk(5, 0, []);
  chunk.vegetationCandidates = [candidate];
  chunk.presentationLayers.natural.vegetation = [candidate];
  const presentation = await createW8DistantPresentation({
    THREE: DISTANT_TEST_THREE,
    scene,
    worldSeedHash: CANONICAL_WORLD_SEED_HASH,
    visualAssets: createDistantTestVisualAssets(),
    findSettlementsNear: async () => [],
    resolveTemplate: async () => null,
    getCanonicalChunkData: async () => null,
  });
  assert.equal(await presentation.sync(canonicalSyncInput({
    centerChunkX: 3,
    activeDataKeys: ['5,0'],
    renderedKeys: [],
    chunk,
  })), true);
  const generationRoot = scene.children[0].children[0];
  const shrubMesh = generationRoot.children.find(child => (
    child.name === 'w8-canonical-lod-natural-full-bush-box-bush'
  ));
  assert.ok(shrubMesh);
  assert.equal(shrubMesh.count, 1);
  assert.deepEqual(shrubMesh.matrices[0].value.scale, {
    x: visual.widthMeters * 256,
    y: visual.heightMeters * 256,
    z: visual.depthMeters * 256,
  });
  assert.equal(presentation.canonicalAuditSnapshot().find(
    object => object.identity.stableId === candidate.candidateId,
  )?.visibleLod, 'mid');
  presentation.dispose();
});

test('canonical vegetation keeps one Stable ID and owner across far, mid, and near LOD', async () => {
  const candidate = Object.freeze({
    candidateId: 'detail-v1:vegetation:canonical-lod-tree',
    subtype: 'broadleaf-tree',
    variationSeed: 1,
    orientationSeed: 0.25,
    worldPosition: Object.freeze({ x: 88, y: 0.4, z: 8 }),
    owningChunkCoordinate: Object.freeze({ x: 5, z: 0 }),
    metadata: Object.freeze({ candidateRadiusMeters: 0.32 }),
  });
  const chunk = canonicalChunk(5, 0, []);
  chunk.vegetationCandidates = [candidate];
  chunk.presentationLayers.natural.vegetation = [candidate];
  let holdQuery = false;
  let releaseQuery = null;
  const presentation = await createW8DistantPresentation({
    THREE: DISTANT_TEST_THREE,
    scene: new DistantTestGroup(),
    worldSeedHash: CANONICAL_WORLD_SEED_HASH,
    visualAssets: createDistantTestVisualAssets(),
    findSettlementsNear: async () => {
      if (!holdQuery) return [];
      return new Promise(resolve => { releaseQuery = () => resolve([]); });
    },
    resolveTemplate: async () => null,
    getCanonicalChunkData: async (chunkX, chunkZ) => (
      chunkX === 5 && chunkZ === 0 ? chunk : null
    ),
  });
  const states = [
    { lod: 'far', centerChunkX: 2, activeDataKeys: [], renderedKeys: [] },
    { lod: 'mid', centerChunkX: 3, activeDataKeys: ['5,0'], renderedKeys: [] },
    { lod: 'near', centerChunkX: 4, activeDataKeys: ['5,0'], renderedKeys: ['5,0'] },
    { lod: 'mid', centerChunkX: 3, activeDataKeys: ['5,0'], renderedKeys: [] },
    { lod: 'far', centerChunkX: 2, activeDataKeys: [], renderedKeys: [] },
  ];
  let identity = null;
  for (const state of states) {
    assert.equal(await presentation.sync(canonicalSyncInput({
      ...state,
      chunk,
    })), true);
    const object = presentation.canonicalAuditSnapshot().find(
      value => value.identity.stableId === candidate.candidateId,
    );
    assert.ok(object);
    identity ??= object.identity;
    assert.deepEqual(object.identity, identity);
    assert.equal(object.visibleLod, state.lod);
    assert.equal(object.ownerKey, '5,0');
    assert.equal(object.instanceCount, 3);
    assert.equal(object.naturalLod.kind, 'tree');
    assert.equal(object.naturalLod.owner, object.ownerKey);
    assert.equal(object.naturalLod.distanceSource, 'logical-object-position');
    const snapshot = presentation.snapshot();
    assert.equal(snapshot.canonicalVegetationRecordCount, 1);
    assert.equal(snapshot.distantTreeProxyCount, 0);
    assert.equal(snapshot.distantRockProxyCount, snapshot.distantNaturalProxyCount);
  }
  assert.deepEqual(identity.owningChunkCoordinate, { x: 5, z: 0 });
  assert.equal(identity.featureType, 'natural-vegetation');
  assert.equal(identity.candidateId, candidate.candidateId);
  assert.equal(await presentation.sync(canonicalSyncInput({
    centerChunkX: 3,
    activeDataKeys: ['5,0'],
    renderedKeys: [],
    chunk,
  })), true);
  holdQuery = true;
  const pendingFarSync = presentation.sync(canonicalSyncInput({
    centerChunkX: 2,
    activeDataKeys: [],
    renderedKeys: [],
    chunk,
  }));
  assert.equal(presentation.canonicalAuditSnapshot().find(
    value => value.identity.stableId === candidate.candidateId,
  )?.visibleLod, 'far', 'the committed generation must not hide a tree while its replacement builds');
  await new Promise(resolve => setImmediate(resolve));
  releaseQuery();
  assert.equal(await pendingFarSync, true);
  presentation.dispose();
});

test('Near, Outer, and Far use one canonical natural candidate set', async () => {
  const tree = Object.freeze({
    candidateId: 'detail-v1:vegetation:stage-3a-tree',
    subtype: 'broadleaf-tree',
    variationSeed: 1,
    orientationSeed: 0.25,
    worldPosition: Object.freeze({ x: 88, y: 0.4, z: 8 }),
    owningChunkCoordinate: Object.freeze({ x: 5, z: 0 }),
    metadata: Object.freeze({ candidateRadiusMeters: 0.32 }),
  });
  const rock = Object.freeze({
    candidateId: 'detail-v1:rock:stage-3a-rock',
    variationSeed: 0.25,
    orientationSeed: 0.5,
    worldPosition: Object.freeze({ x: 88, y: 0.4, z: 8 }),
    owningChunkCoordinate: Object.freeze({ x: 5, z: 0 }),
    metadata: Object.freeze({ candidateRadiusMeters: 0.45 }),
  });
  const chunk = canonicalChunk(5, 0, []);
  chunk.generatorVersion = { major: 800, minor: 0, patch: 0 };
  chunk.vegetationCandidates = [tree];
  chunk.rockCandidates = [rock];
  chunk.presentationLayers.natural = { vegetation: [tree], rocks: [rock] };

  const sourceSet = resolveW8CanonicalCandidateSet(chunk);
  assert.deepEqual(sourceSet.vegetation.map(value => value.candidateId), [tree.candidateId]);
  assert.deepEqual(sourceSet.rocks.map(value => value.candidateId), [rock.candidateId]);

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
  const expectedStableIds = [tree.candidateId, rock.candidateId].sort();
  for (const state of [
    { lod: 'far', centerChunkX: 2, activeDataKeys: [], renderedKeys: [] },
    { lod: 'mid', centerChunkX: 3, activeDataKeys: ['5,0'], renderedKeys: [] },
    { lod: 'near', centerChunkX: 4, activeDataKeys: ['5,0'], renderedKeys: ['5,0'] },
  ]) {
    assert.equal(await presentation.sync(canonicalSyncInput({ ...state, chunk })), true);
    const audit = presentation.canonicalAuditSnapshot();
    assert.deepEqual(audit.map(value => value.identity.stableId).sort(), expectedStableIds);
    assert.equal(audit.every(value => value.visibleLod === state.lod), true);
    assert.equal(new Set(audit.map(value => value.ownerKey)).size, 1);
    const snapshot = presentation.snapshot();
    assert.equal(snapshot.canonicalVegetationRecordCount, 1);
    assert.equal(snapshot.canonicalRockRecordCount, 1);
    assert.equal(snapshot.distantRockProxyCount, 0);
    assert.equal(snapshot.distantNaturalProxyCount, 0);
  }
  presentation.dispose();
});

test('natural streaming preserves existing Outer Stable IDs and reveals only new Far instances', async () => {
  const tree = (candidateId, chunkX, x) => Object.freeze({
    candidateId,
    subtype: 'broadleaf-tree',
    variationSeed: 1,
    orientationSeed: 0.25,
    worldPosition: Object.freeze({ x, y: 0.4, z: 8 }),
    owningChunkCoordinate: Object.freeze({ x: chunkX, z: 0 }),
    metadata: Object.freeze({ candidateRadiusMeters: 0.32 }),
  });
  const existingTree = tree('detail-v1:vegetation:stream-existing', 2, 40);
  const newFarTree = tree('detail-v1:vegetation:stream-new-far', 4, 72);
  const chunkWith = candidate => {
    const chunk = canonicalChunk(candidate.owningChunkCoordinate.x, 0, []);
    chunk.vegetationCandidates = [candidate];
    chunk.presentationLayers.natural = { vegetation: [candidate], rocks: [] };
    return chunk;
  };
  const activeChunk = chunkWith(existingTree);
  const farChunk = chunkWith(newFarTree);
  const scene = new DistantTestGroup();
  const presentation = await createW8DistantPresentation({
    THREE: DISTANT_TEST_THREE,
    scene,
    worldSeedHash: CANONICAL_WORLD_SEED_HASH,
    visualAssets: createSilhouetteTestVisualAssets(),
    findSettlementsNear: async () => [],
    resolveTemplate: async () => null,
    getCanonicalChunkData: async (chunkX, chunkZ) => (
      chunkX === 4 && chunkZ === 0 ? farChunk : null
    ),
  });
  const input = canonicalSyncInput({
    centerChunkX: 0,
    activeDataKeys: ['2,0'],
    renderedKeys: [],
    chunk: activeChunk,
    playerLogicalX: 8,
    quality: 'high',
  });
  assert.equal(await presentation.sync({
    ...input,
    includeFarNatural: false,
  }), true);
  assert.equal(presentation.snapshot().naturalLodReveal, 1);
  assert.equal(presentation.canonicalAuditSnapshot().find(value => (
    value.identity.stableId === existingTree.candidateId
  ))?.visibleLod, 'mid');

  assert.equal(await presentation.sync({
    ...input,
    includeFarNatural: true,
    includeUltraNatural: false,
    revealNatural: true,
    naturalRevealInnerMeters: 0,
  }), true);
  const generationRoot = scene.children[0].children[0];
  const revealValuesFor = stableId => generationRoot.children.flatMap(mesh => {
    const index = mesh.userData?.canonicalStableIds?.indexOf(stableId) ?? -1;
    if (index < 0) return [];
    const attribute = mesh.geometry?.attributes?.w8NaturalInitialReveal;
    const values = attribute?.array ?? attribute?.values;
    return values ? [values[index]] : [];
  });
  assert.deepEqual([...new Set(revealValuesFor(existingTree.candidateId))], [1]);
  assert.deepEqual([...new Set(revealValuesFor(newFarTree.candidateId))], [0]);
  const snapshot = presentation.snapshot();
  assert.equal(snapshot.naturalLodReveal, 0);
  assert.equal(snapshot.naturalLodRevealPreservedStableIdCount >= 1, true);
  const material = generationRoot.children.find(mesh => (
    mesh.material?.userData?.naturalLod === true
  )).material;
  assert.equal(material.userData.naturalLodUniforms.w8NaturalReveal.value, 0);
  const shader = {
    uniforms: {},
    vertexShader: '#include <begin_vertex>',
    fragmentShader: '#include <color_fragment>',
  };
  material.onBeforeCompile(shader);
  assert.match(shader.vertexShader, /attribute float w8NaturalInitialReveal/);
  assert.match(shader.fragmentShader, /max\(vW8NaturalInitialReveal, w8NaturalReveal\)/);
  assert.doesNotMatch(shader.fragmentShader, /w8NaturalRevealInner/);
  presentation.dispose();
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
    centerChunkX: 3, activeDataKeys: ['5,0'], renderedKeys: [], chunk,
  })), true);
  assert.equal(presentation.canonicalAuditSnapshot()[0].visibleLod, 'mid');
  const generationRoot = scene.children[0].children[0];
  const buildLocalX = generationRoot.position.x;

  assert.equal(presentation.commitRuntimeState({
    activeDataKeys: ['5,0'], renderedKeys: ['5,0'],
    renderOrigin: { renderOriginChunkX: 4, renderOriginChunkZ: 0, rebaseCount: 4 },
    quality: 'medium', playerLogicalX: 72, playerLogicalZ: 8,
  }), true);
  assert.equal(presentation.canonicalAuditSnapshot()[0].visibleLod, 'near');
  assert.equal(scene.children[0].children[0], generationRoot,
    'owner handoff reuses the complete generation instead of flashing a replacement root');
  assert.equal(generationRoot.position.x, buildLocalX - RENDER_CHUNK_SIZE,
    'the generation root applies exactly one Chunk of origin delta');
  const currentOrigin = presentation.snapshot().currentOrigin;
  const originAudit = presentation.originTransformAuditSnapshot();
  const distantRoot = originAudit.roots.find(root => root.role === 'distant-building-and-legacy');
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

test('Tree full, Forest, and Atmospheric tiers cross-fade by exact logical distance', async () => {
  const forestHorizonSeed = `sha256:${'0'.repeat(63)}3`;
  assert.equal(isW8ForestHorizonOwner({
    worldSeedHash: forestHorizonSeed,
    chunkX: 5,
    chunkZ: 0,
  }), true);
  const candidate = (candidateId, subtype, x) => Object.freeze({
    candidateId,
    subtype,
    variationSeed: 1,
    orientationSeed: 0.25,
    worldPosition: Object.freeze({ x, y: 0.4, z: 8 }),
    owningChunkCoordinate: Object.freeze({ x: 5, z: 0 }),
    metadata: Object.freeze({ candidateRadiusMeters: 0.32 }),
  });
  const candidates = Object.freeze([
    candidate('detail-v1:vegetation:full-broadleaf', 'broadleaf-tree', 56),
    candidate('detail-v1:vegetation:silhouette-broadleaf', 'broadleaf-tree', 80),
    candidate('detail-v1:vegetation:silhouette-wetland', 'wetland-tree', 80),
    candidate('detail-v1:vegetation:silhouette-conifer', 'conifer-tree', 80),
    candidate('detail-v1:vegetation:ultra-tree', 'broadleaf-tree', 92),
    candidate('detail-v1:vegetation:hidden-tree', 'broadleaf-tree', 200),
  ]);
  const makeChunk = vegetation => {
    const chunk = canonicalChunk(5, 0, []);
    chunk.vegetationCandidates = vegetation;
    chunk.presentationLayers.natural.vegetation = vegetation;
    return chunk;
  };
  const run = async vegetation => {
    const scene = new DistantTestGroup();
    const chunk = makeChunk(vegetation);
    const presentation = await createW8DistantPresentation({
      THREE: DISTANT_TEST_THREE,
      scene,
      worldSeedHash: forestHorizonSeed,
      visualAssets: createSilhouetteTestVisualAssets(),
      findSettlementsNear: async () => [],
      resolveTemplate: async () => null,
      getCanonicalChunkData: async (chunkX, chunkZ) => (
        chunkX === 5 && chunkZ === 0 ? chunk : null
      ),
    });
    assert.equal(await presentation.sync(canonicalSyncInput({
      centerChunkX: 0,
      activeDataKeys: ['5,0'],
      renderedKeys: [],
      chunk,
      playerLogicalX: 8,
      quality: 'high',
    })), true);
    const meshes = scene.children[0].children[0].children.filter(
      child => child.name.startsWith('w8-canonical-lod-'),
    );
    const occurrences = stableId => meshes.reduce((count, mesh) => (
      count + mesh.userData.canonicalStableIds.filter(value => value === stableId).length
    ), 0);
    const result = {
      audit: presentation.canonicalAuditSnapshot(),
      snapshot: presentation.snapshot(),
      occurrences: Object.fromEntries(candidates.map(value => [
        value.candidateId, occurrences(value.candidateId),
      ])),
      meshes,
      presentation,
    };
    return result;
  };
  const [normal, reverse, parallel] = await Promise.all([
    run(candidates),
    run(Object.freeze([...candidates].reverse())),
    run(candidates),
  ]);
  const auditById = result => Object.fromEntries(result.audit.map(value => [
    value.identity.stableId,
    {
      ownerKey: value.ownerKey,
      owner: value.identity.owningChunkCoordinate,
      position: value.identity.worldPosition,
      rotationY: value.identity.rotationY,
      visibleLod: value.visibleLod,
      naturalLod: value.naturalLod,
      instances: value.instanceCount,
      occurrences: result.occurrences[value.identity.stableId],
    },
  ]));
  assert.deepEqual(auditById(normal), auditById(reverse));
  assert.deepEqual(auditById(normal), auditById(parallel));
  assert.deepEqual(normal.occurrences, {
    'detail-v1:vegetation:full-broadleaf': 6,
    'detail-v1:vegetation:silhouette-broadleaf': 6,
    'detail-v1:vegetation:silhouette-wetland': 6,
    'detail-v1:vegetation:silhouette-conifer': 5,
    'detail-v1:vegetation:ultra-tree': 6,
    'detail-v1:vegetation:hidden-tree': 6,
  });
  assert.equal(normal.snapshot.visibleCanonicalTreeCount, 6);
  assert.equal(normal.snapshot.visibleCanonicalFullTreeCount, 1);
  assert.equal(normal.snapshot.visibleCanonicalSilhouetteTreeCount, 3);
  assert.equal(normal.snapshot.visibleCanonicalUltraTreeCount, 2);
  assert.equal(normal.snapshot.visibleCanonicalTreePartInstanceCount, 35);
  assert.equal(normal.snapshot.distantTreeProxyCount, 0);
  assert.equal(normal.snapshot.naturalLodShaderEnabled, true);
  assert.equal(normal.snapshot.naturalLodMaterialCount, 6);
  assert.equal(normal.snapshot.naturalLodMeshCount, 10);
  assert.equal(normal.snapshot.naturalLodGeometryCount, 10);
  assert.equal(normal.snapshot.naturalLodDrawCallEquivalent, 10);
  assert.equal(normal.snapshot.forestHorizonMaterialCount, 1);
  assert.equal(normal.snapshot.forestHorizonMeshCount, 2);
  const treeMaterials = normal.presentation.treeMaterialAuditSnapshot();
  assert.equal(treeMaterials.source.find(material => (
    material.path === 'exact:treeLeaves'
  )).baseColorHex, 0x2e7d32);
  assert.equal(treeMaterials.source.find(material => (
    material.path === 'exact:treeLeavesForest'
  )).baseColorHex, 0x1b5e20);
  assert.equal(treeMaterials.source.find(material => (
    material.path === 'exact:treeLeavesMeadow'
  )).baseColorHex, 0x7cb342);
  const forestMaterial = treeMaterials.generated.find(material => (
    material.path === 'legacy-distant:forest'
  ));
  const atmosphericMaterial = treeMaterials.generated.find(material => (
    material.path === 'legacy-distant:atmospheric'
  ));
  const horizonMaterial = treeMaterials.generated.find(material => (
    material.path === 'legacy-distant:horizon'
  ));
  assert.deepEqual({
    color: forestMaterial.baseColorHex,
    flatShading: forestMaterial.flatShading,
    shininess: forestMaterial.shininess,
    fog: forestMaterial.fog,
  }, { color: 0x28512f, flatShading: true, shininess: 0, fog: true });
  assert.deepEqual({
    color: atmosphericMaterial.baseColorHex,
    fog: atmosphericMaterial.fog,
    customAtmosphericFogBlend: atmosphericMaterial.customAtmosphericFogBlend,
  }, { color: 0x49674f, fog: false, customAtmosphericFogBlend: true });
  assert.deepEqual({
    color: horizonMaterial.baseColorHex,
    fog: horizonMaterial.fog,
    customAtmosphericFogBlend: horizonMaterial.customAtmosphericFogBlend,
  }, { color: 0x49674f, fog: false, customAtmosphericFogBlend: true });
  const broadleafSilhouette = candidates[1];
  const broadleafAudit = normal.audit.find(value => (
    value.identity.stableId === broadleafSilhouette.candidateId
  ));
  assert.equal(broadleafAudit.visibleLod, 'mid');
  assert.deepEqual(broadleafAudit.identity.worldPosition, broadleafSilhouette.worldPosition);
  assert.deepEqual(broadleafAudit.identity.owningChunkCoordinate, { x: 5, z: 0 });
  assert.equal(broadleafAudit.identity.rotationY, Math.PI / 2);
  const broadleafMesh = normal.meshes.find(mesh => (
    mesh.name === 'w8-canonical-lod-natural-forest-tree-sphere-__natural-silhouette__'
  ));
  assert.ok(broadleafMesh);
  const broadleafMatrix = broadleafMesh.matrices[broadleafMesh.userData.canonicalStableIds.indexOf(
    broadleafSilhouette.candidateId,
  )].value;
  const visual = resolveW8NaturalCandidateVisual(broadleafSilhouette);
  const forestScale = {
    x: visual.widthMeters * 256 * 0.82 * 1.28,
    y: visual.heightMeters * 256 * 0.72 * (0.94 + (1.28 - 1) * 0.35),
    z: visual.depthMeters * 256 * 0.82 * 1.28,
  };
  const canonicalBroadleafMatrix = {
    position: {
      x: broadleafSilhouette.worldPosition.x * 256,
      y: broadleafSilhouette.worldPosition.y * 256 + visual.heightMeters * 256 * 0.64,
      z: broadleafSilhouette.worldPosition.z * 256,
    },
    rotation: { x: 0, y: Math.PI / 2, z: 0 },
    scale: forestScale,
  };
  assert.deepEqual(broadleafMatrix, canonicalBroadleafMatrix);
  const canonicalTreeMatrix = (tree, part) => {
    const treeVisual = resolveW8NaturalCandidateVisual(tree);
    return {
      position: {
        x: tree.worldPosition.x * 256 + part.position[0] * treeVisual.widthMeters * 256,
        y: tree.worldPosition.y * 256 + part.position[1] * treeVisual.heightMeters * 256,
        z: tree.worldPosition.z * 256 + part.position[2] * treeVisual.depthMeters * 256,
      },
      rotation: { x: part.rotation[0], y: Math.PI / 2 + part.rotation[1], z: part.rotation[2] },
      scale: {
        x: treeVisual.widthMeters * 256 * part.scale[0],
        y: treeVisual.heightMeters * 256 * part.scale[1],
        z: treeVisual.depthMeters * 256 * part.scale[2],
      },
    };
  };
  const matrixFor = (mesh, stableId) => mesh.matrices[mesh.userData.canonicalStableIds.indexOf(
    stableId,
  )].value;
  const wetlandMesh = broadleafMesh;
  const coniferMesh = normal.meshes.find(mesh => (
    mesh.name === 'w8-canonical-lod-natural-forest-tree-cone-__natural-silhouette__'
  ));
  assert.ok(wetlandMesh);
  assert.ok(coniferMesh);
  assert.deepEqual(
    matrixFor(wetlandMesh, candidates[2].candidateId),
    canonicalTreeMatrix(candidates[2], {
      ...SILHOUETTE_WETLAND_PRIMARY_PART,
      scale: [0.78 * 1.28, 0.68 * (0.94 + (1.28 - 1) * 0.35), 0.78 * 1.28],
    }),
  );
  assert.deepEqual(
    matrixFor(coniferMesh, candidates[3].candidateId),
    canonicalTreeMatrix(candidates[3], {
      ...SILHOUETTE_CONIFER_PART,
      scale: [0.76 * 1.28, 0.78 * (0.94 + (1.28 - 1) * 0.35), 0.76 * 1.28],
    }),
  );
  assert.equal(broadleafMesh.material.flatShading, true);
  assert.equal(broadleafMesh.material.shininess, 0);
  assert.equal(broadleafMesh.material.transparent, false);
  assert.equal(broadleafMesh.material.alphaHash, true);
  assert.equal(broadleafMesh.material.userData.naturalLodDistanceSource, 'instance-anchor');
  const atmosphericMesh = normal.meshes.find(mesh => (
    mesh.name === 'w8-canonical-lod-natural-atmospheric-tree-sphere-__natural-silhouette__'
  ));
  assert.ok(atmosphericMesh);
  assert.notEqual(atmosphericMesh.material, broadleafMesh.material);
  assert.equal(new Set(normal.meshes.filter(mesh => (
    mesh.name.includes('natural-forest-tree')
  )).map(mesh => mesh.material)).size, 1);
  assert.equal(new Set(normal.meshes.filter(mesh => (
    mesh.name.includes('natural-atmospheric-tree')
  )).map(mesh => mesh.material)).size, 1);
  const horizonMesh = normal.meshes.find(mesh => (
    mesh.name === 'w8-canonical-lod-natural-horizon-tree-sphere-__natural-silhouette__'
  ));
  assert.ok(horizonMesh);
  assert.notEqual(horizonMesh.material, atmosphericMesh.material);
  assert.equal(horizonMesh.material.userData.naturalLodMode, 'horizon');
  assert.equal(new Set(normal.meshes.filter(mesh => (
    mesh.name.includes('natural-horizon-tree')
  )).map(mesh => mesh.material)).size, 1);
  const horizonTree = candidates[5];
  const horizonMatrix = matrixFor(horizonMesh, horizonTree.candidateId);
  const horizonVisual = resolveW8NaturalCandidateVisual(horizonTree);
  assert.equal(horizonMatrix.scale.x, horizonVisual.widthMeters * 256 * 0.82 * 2.84);
  assert.equal(horizonMatrix.scale.z, horizonVisual.depthMeters * 256 * 0.82 * 2.84);
  const horizonAudit = normal.audit.find(value => (
    value.identity.stableId === horizonTree.candidateId
  ));
  assert.equal(horizonAudit.naturalLod.horizonOpacity, 1);
  assert.equal(horizonAudit.naturalLod.horizonInstanceCount, 1);
  assert.equal(horizonAudit.naturalLod.distanceSource, 'logical-object-position');
  const ultraTree = candidates[4];
  const ultraMatrix = atmosphericMesh.matrices[atmosphericMesh.userData.canonicalStableIds.indexOf(
    ultraTree.candidateId,
  )].value;
  const ultraVisual = resolveW8NaturalCandidateVisual(ultraTree);
  const expectedUltraMatrix = {
    position: {
      x: ultraTree.worldPosition.x * 256,
      y: ultraTree.worldPosition.y * 256 + ultraVisual.heightMeters * 256 * 0.64,
      z: ultraTree.worldPosition.z * 256,
    },
    rotation: { x: 0, y: Math.PI / 2, z: 0 },
    scale: {
      x: ultraVisual.widthMeters * 256 * 0.82 * 1.42,
      y: ultraVisual.heightMeters * 256 * 0.72 * (0.94 + (1.42 - 1) * 0.35),
      z: ultraVisual.depthMeters * 256 * 0.82 * 1.42,
    },
  };
  assert.deepEqual(ultraMatrix.position, expectedUltraMatrix.position);
  assert.deepEqual(ultraMatrix.rotation, expectedUltraMatrix.rotation);
  assert.equal(ultraMatrix.scale.x, expectedUltraMatrix.scale.x);
  assert.ok(Math.abs(ultraMatrix.scale.y - expectedUltraMatrix.scale.y) < 1e-9);
  assert.equal(ultraMatrix.scale.z, expectedUltraMatrix.scale.z);
  const anchorIndex = broadleafMesh.userData.canonicalStableIds.indexOf(
    broadleafSilhouette.candidateId,
  );
  assert.deepEqual(
    [...broadleafMesh.geometry.attributes.w8NaturalAnchorXZ.values]
      .slice(anchorIndex * 2, anchorIndex * 2 + 2),
    [broadleafSilhouette.worldPosition.x * 256, broadleafSilhouette.worldPosition.z * 256],
  );
  const composeBeforeGpuFade = normal.presentation.snapshot().canonicalComposeCount;
  normal.presentation.update(0, 8, { renderOriginChunkX: 0, renderOriginChunkZ: 0 });
  const transitioned = normal.presentation.canonicalAuditSnapshot();
  const fullForestBlend = transitioned.find(value => (
    value.identity.stableId === candidates[0].candidateId
  )).naturalLod;
  const forestAtmosphericBlend = transitioned.find(value => (
    value.identity.stableId === broadleafSilhouette.candidateId
  )).naturalLod;
  assert.deepEqual(
    [fullForestBlend.fullOpacity, fullForestBlend.forestOpacity,
      fullForestBlend.atmosphericOpacity, fullForestBlend.totalOpacity],
    [0.5, 0.5, 0, 1],
  );
  assert.deepEqual(
    [forestAtmosphericBlend.fullOpacity, forestAtmosphericBlend.forestOpacity,
      forestAtmosphericBlend.atmosphericOpacity, forestAtmosphericBlend.totalOpacity],
    [0, 0.5, 0.5, 1],
  );
  assert.equal(normal.presentation.snapshot().canonicalComposeCount, composeBeforeGpuFade,
    'distance-only cross-fade updates uniforms without CPU instance compaction');
  assert.deepEqual(normal.presentation.snapshot().naturalLodPlayerLocalXZ, { x: 0, y: 2048 });
  const blendBeforeRebase = forestAtmosphericBlend;
  normal.presentation.update(0, 8, { renderOriginChunkX: 1, renderOriginChunkZ: 0 });
  assert.deepEqual(normal.presentation.canonicalAuditSnapshot().find(value => (
    value.identity.stableId === broadleafSilhouette.candidateId
  )).naturalLod, blendBeforeRebase, 'Floating Origin cannot change logical-object distance');
  normal.presentation.dispose();
  reverse.presentation.dispose();
  parallel.presentation.dispose();
});

test('Local terrain publishes only complete 25-Chunk coverage and swaps roots atomically', async () => {
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
  assert.notEqual(distantRoot.children[0], firstRoot);
  assert.ok(firstGeometries.every(geometry => geometry.disposed === true));
  const secondRoot = distantRoot.children[0];

  const stale = presentation.syncLocalTerrain({ coverageEpoch: 2, ...initial });
  assert.equal(stale.committed, false);
  assert.equal(stale.reason, 'stale-epoch');
  assert.equal(distantRoot.children[0], secondRoot);
  presentation.dispose();
});

test('normal Chunk-boundary Local Terrain compose is sliced and swaps only after completion', async () => {
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
  assert.notEqual(distantRoot.children[0], oldRoot);
  assert.ok(oldGeometries.every(geometry => geometry.disposed === true));
  const snapshot = presentation.snapshot();
  assert.equal(snapshot.committedLocalTerrainEpoch, 2);
  assert.equal(snapshot.localTerrainLastSliceCount > 0, true);
  assert.equal(snapshot.presentationSliceBudgetMs, 8);
  assert.equal(snapshot.localTerrainLastMaximumSliceMs >= 0, true);
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
  const naturalChunk = canonicalChunk(5, 0, []);
  naturalChunk.vegetationCandidates = Object.freeze([...trees, ...bushes]);
  naturalChunk.rockCandidates = rocks;
  naturalChunk.ambientDetails = grass;
  naturalChunk.presentationLayers.natural = {
    vegetation: naturalChunk.vegetationCandidates,
    rocks,
  };
  naturalChunk.presentationLayers.ambientDetails = grass;
  const scene = new DistantTestGroup();
  const presentation = await createLocalTerrainTestPresentation(scene, {
    incrementalStaticTreePages: true,
    yieldToMainThread: () => new Promise(resolve => setImmediate(resolve)),
  });
  const initial = localTerrainCoverageFixture(4, 0);
  initial.chunks.set('5,0', naturalChunk);
  assert.equal(presentation.syncLocalTerrain({ coverageEpoch: 1, ...initial }).committed, true);
  assert.equal(await presentation.sync({
    ...initial,
    quality: 'high',
    renderDistancePreset: 'current',
    playerLogicalX: 72,
    playerLogicalZ: 8,
  }), true);
  for (let frame = 0; frame < 64
    && presentation.snapshot().runtimePresentationHandoffPending; frame += 1) {
    presentation.update(72, 8, initial.renderOrigin);
  }
  presentation.markFirstDraw();
  const baseline = presentation.snapshot();
  assert.equal(baseline.runtimePresentationHandoffPending, false);
  assert.ok(baseline.canonicalShrubRecordCount >= bushes.length);
  assert.ok(baseline.canonicalGrassRecordCount >= grass.length);
  assert.ok(baseline.canonicalRockRecordCount >= rocks.length);

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
    presentation.markFirstDraw();
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
  assert.notEqual(distantRoot.children[0], committedRoot);
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

test('Local Terrain diagnostics prove replacement attachment precedes old-root release', async () => {
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
  assert.equal(attached.oldRootAttached, true);
  assert.equal(released.newRootAttached, true);
  assert.equal(released.oldRootAttached, false);
  const roots = presentation.visibleRootRevisionSnapshot();
  assert.equal(roots.find(root => root.role === 'local-terrain').coverageEpoch, 2);
  assert.equal(roots.find(root => root.role === 'local-terrain').attached, true);
  presentation.dispose();
});

test('Render Distance swaps complete Terrain roots without changing Local coverage', async () => {
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
  assert.notEqual(distantRoot.children[0], currentRoot);
  const switchedGeometries = distantRoot.children[0].children
    .map(child => child.geometry).filter(Boolean);
  assert.equal(currentGeometries.filter(geometry => switchedGeometries.includes(geometry)).length, 1,
    'the preset-only swap reuses the unchanged 16-Chunk midground geometry');
  assert.ok(currentGeometries.filter(geometry => !switchedGeometries.includes(geometry))
    .every(geometry => geometry.disposed === true));
  assert.equal(presentation.snapshot().clipmapExtentMeters, 192);
  assert.equal(presentation.snapshot().renderDistancePreset, 'short');
  assert.equal(presentation.snapshot().localTerrainActiveKeyCount, 25);
  assert.equal(presentation.snapshot().localTerrainRenderedKeyCount, 9);
  assert.equal(presentation.snapshot().localTerrainMidgroundOwnerCount, 16);
  presentation.dispose();
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
  });
  const input = canonicalSyncInput({
    centerChunkX: 0, activeDataKeys: ['5,0'], renderedKeys: [], chunk,
    playerLogicalX: 8, quality: 'high',
  });
  assert.equal(await presentation.sync(input), true);
  const baseline = presentation.snapshot();
  presentation.update(8, 8, input.renderOrigin);
  const unchanged = presentation.snapshot();
  assert.equal(unchanged.canonicalComposeCount, baseline.canonicalComposeCount);
  assert.equal(unchanged.canonicalMatrixUpdateCount, baseline.canonicalMatrixUpdateCount);
  assert.equal(unchanged.canonicalNeedsUpdateCount, baseline.canonicalNeedsUpdateCount);
  const reused = unchanged;
  presentation.update(32, 8, input.renderOrigin);
  const changed = presentation.snapshot();
  assert.equal(changed.canonicalComposeCount, reused.canonicalComposeCount);
  assert.equal(changed.canonicalMatrixUpdateCount, reused.canonicalMatrixUpdateCount);
  assert.equal(changed.canonicalNeedsUpdateCount, reused.canonicalNeedsUpdateCount);
  assert.equal(changed.canonicalDirtyBucketCount, reused.canonicalDirtyBucketCount);
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
    getCanonicalChunkData: async () => null,
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

test('every visible Far water instance retains canonical identity and owner coverage', async () => {
  const scene = new DistantTestGroup();
  const presentation = await createLocalTerrainTestPresentation(scene);
  const input = canonicalSyncInput({
    centerChunkX: 0,
    activeDataKeys: [],
    renderedKeys: [],
    chunk: canonicalChunk(0, 0, []),
    quality: 'high',
  });
  assert.equal(await presentation.sync(input), true);
  const generationRoot = scene.children[0].children[0];
  const water = generationRoot.children.filter(child => child.material?.name === 'water'
    || child.name?.includes('water'));
  assert.ok(water.length > 0, 'the fixture must materialize Far water presentation');
  assert.deepEqual(water.map(mesh => ({
    name: mesh.name,
    count: mesh.count,
    canonicalStableIdCount: mesh.userData?.canonicalStableIds?.length ?? 0,
    ownerKeyCount: mesh.userData?.ownerKeys?.length ?? 0,
  })), water.map(mesh => ({
    name: mesh.name,
    count: mesh.count,
    canonicalStableIdCount: mesh.count,
    ownerKeyCount: mesh.count,
  })), 'presentation-only water must still identify canonical water coverage and its owner');
  const proxy = water.find(mesh => mesh.name === 'w8-distant-water-proxy-__road__-water');
  assert.equal(proxy.userData.logicalBounds.length, proxy.count);
  assert.equal(new Set(proxy.userData.canonicalStableIds).size, proxy.count,
    'anchored Water cells must retain unique deterministic identities');
  proxy.userData.logicalBounds.forEach(bounds => {
    assert.ok(Number.isFinite(bounds.minimumX) && Number.isFinite(bounds.maximumX)
      && Number.isFinite(bounds.minimumZ) && Number.isFinite(bounds.maximumZ));
    assert.ok(bounds.minimumX < bounds.maximumX && bounds.minimumZ < bounds.maximumZ);
  });
  presentation.dispose();
});

test('an old Far water instance cannot remain visible after its bounds enter the active ring', async () => {
  const scene = new DistantTestGroup();
  const presentation = await createLocalTerrainTestPresentation(scene);
  const input = canonicalSyncInput({
    centerChunkX: 0,
    activeDataKeys: [],
    renderedKeys: [],
    chunk: canonicalChunk(0, 0, []),
    quality: 'high',
  });
  input.renderOrigin.rebaseCount = 1;
  assert.equal(await presentation.sync(input), true);
  const generationRoot = scene.children[0].children[0];
  const waterProxy = generationRoot.children.find(child => (
    child.name === 'w8-distant-water-proxy-__road__-water'
  ));
  assert.ok(waterProxy?.count > 0, 'the fixture must materialize a distant Water proxy');
  const firstProxy = structuredClone(waterProxy.matrices[0].value);
  const unitsPerMeter = RENDER_CHUNK_SIZE / LEGACY_CHUNK_SIZE_METERS;
  const proxyWorldX = firstProxy.position.x / unitsPerMeter;
  const proxyWorldZ = firstProxy.position.z / unitsPerMeter;
  const targetChunkX = Math.floor(proxyWorldX / LEGACY_CHUNK_SIZE_METERS);
  const targetChunkZ = Math.floor(proxyWorldZ / LEGACY_CHUNK_SIZE_METERS);
  const activeDataKeys = [];
  const renderedKeys = [];
  for (let chunkZ = targetChunkZ - 2; chunkZ <= targetChunkZ + 2; chunkZ += 1) {
    for (let chunkX = targetChunkX - 2; chunkX <= targetChunkX + 2; chunkX += 1) {
      const key = `${chunkX},${chunkZ}`;
      activeDataKeys.push(key);
      if (Math.abs(chunkX - targetChunkX) <= 1 && Math.abs(chunkZ - targetChunkZ) <= 1) {
        renderedKeys.push(key);
      }
    }
  }
  assert.equal(presentation.commitRuntimeState({
    activeDataKeys,
    renderedKeys,
    renderOrigin: {
      renderOriginChunkX: targetChunkX,
      renderOriginChunkZ: targetChunkZ,
      rebaseCount: 2,
    },
    quality: 'high',
    playerLogicalX: proxyWorldX,
    playerLogicalZ: proxyWorldZ,
  }), true);
  const proxyRenderX = firstProxy.position.x + generationRoot.position.x;
  const proxyRenderZ = firstProxy.position.z + generationRoot.position.z;
  const playerRenderX = (proxyWorldX - targetChunkX * LEGACY_CHUNK_SIZE_METERS)
    * unitsPerMeter;
  const playerRenderZ = (proxyWorldZ - targetChunkZ * LEGACY_CHUNK_SIZE_METERS)
    * unitsPerMeter;
  assert.ok(Math.abs(proxyRenderX - playerRenderX) < 1e-9
    && Math.abs(proxyRenderZ - playerRenderZ) < 1e-9,
  'the old proxy must now overlap the Player in render coordinates');
  const movedSnapshot = presentation.snapshot();
  const handedOffProxy = waterProxy.matrices[0].value;
  assert.equal(
    handedOffProxy.scale.x === 0
      && handedOffProxy.scale.y === 0
      && handedOffProxy.scale.z === 0,
    true,
    `a presentation-only Far water proxy must be hidden when it enters active coverage: ${
      JSON.stringify({
        proxyWorldX,
        proxyWorldZ,
        targetChunkX,
        targetChunkZ,
        proxyRenderX,
        proxyRenderZ,
        playerRenderX,
        playerRenderZ,
        scale: handedOffProxy.scale,
        meshName: waterProxy.name,
        userData: waterProxy.userData,
        far: {
          committedEpoch: movedSnapshot.committedEpoch,
          syncEpoch: movedSnapshot.syncEpoch,
          buildOrigin: movedSnapshot.buildOrigin,
          currentOrigin: movedSnapshot.currentOrigin,
          rootAttached: movedSnapshot.rootAttached,
        },
      })}`,
  );
  assert.equal(presentation.commitRuntimeState({
    activeDataKeys: [],
    renderedKeys: [],
    renderOrigin: {
      renderOriginChunkX: 0,
      renderOriginChunkZ: 0,
      rebaseCount: 3,
    },
    quality: 'high',
    playerLogicalX: 0,
    playerLogicalZ: 0,
  }), true);
  assert.deepEqual(waterProxy.matrices[0].value, firstProxy,
    'the same Far coverage must return without regeneration after active ownership leaves');
  presentation.dispose();
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
    findSettlementsNear: async () => [],
    resolveTemplate: async () => null,
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
  assert.equal(ownerCalls, callsBeforeCacheReuse,
    'a successful replacement request remains reusable after the cancelled null');
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
  const remoteMaterial = remoteMeshes[0].material;
  const remoteUniforms = remoteMaterial.userData.remoteAtmosphereUniforms;
  assert.equal(remoteUniforms.w8RemoteSilhouetteColor.value.isColor, true);
  assert.equal(remoteUniforms.w8RemoteFogColor.value.isColor, true);
  assert.ok(remoteUniforms.w8RemoteSilhouetteColor.value.r < (0x3a / 0xff));
  assert.ok(remoteUniforms.w8RemoteFogColor.value.r < (0x5d / 0xff));
  const compiledShader = {
    uniforms: {},
    vertexShader: 'void main() {\n#include <begin_vertex>\n}',
    fragmentShader: 'void main() {\n#include <color_fragment>\n}',
  };
  remoteMaterial.onBeforeCompile(compiledShader);
  assert.match(compiledShader.vertexShader, /attribute vec2 w8RemoteAnchorXZ/);
  assert.match(compiledShader.vertexShader, /vW8RemoteDistanceMeters = length/);
  assert.match(compiledShader.fragmentShader, /diffuseColor\.a \*= w8RemoteOpacity/);
  assert.equal(remoteMaterial.customProgramCacheKey(), 'w8-remote-building-atmosphere-v1');
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
    assert.equal(result.snapshot.naturalVisibilityMeters, 140);
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

test('Tree LOD diagnostics are opt-in and mirror full, Forest, and Atmospheric tiers', async () => {
  const candidates = Object.freeze([
    Object.freeze({
      candidateId: 'detail-v1:debug-full-tree', subtype: 'broadleaf-tree', variationSeed: 1,
      orientationSeed: 0.25, worldPosition: Object.freeze({ x: 56, y: 0.4, z: 8 }),
      owningChunkCoordinate: Object.freeze({ x: 5, z: 0 }),
      metadata: Object.freeze({ candidateRadiusMeters: 0.32 }),
    }),
    Object.freeze({
      candidateId: 'detail-v1:debug-silhouette-tree', subtype: 'conifer-tree', variationSeed: 1,
      orientationSeed: 0.25, worldPosition: Object.freeze({ x: 80, y: 0.4, z: 8 }),
      owningChunkCoordinate: Object.freeze({ x: 5, z: 0 }),
      metadata: Object.freeze({ candidateRadiusMeters: 0.32 }),
    }),
    Object.freeze({
      candidateId: 'detail-v1:debug-ultra-tree', subtype: 'broadleaf-tree', variationSeed: 1,
      orientationSeed: 0.25, worldPosition: Object.freeze({ x: 92, y: 0.4, z: 8 }),
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
  });
  assert.equal(await presentation.sync(canonicalSyncInput({
    centerChunkX: 0, activeDataKeys: ['5,0'], renderedKeys: [], chunk,
    playerLogicalX: 8, quality: 'high',
  })), true);
  const before = presentation.snapshot();
  const generationRoot = scene.children[0].children[0];
  assert.equal(generationRoot.children.some(child => child.name === 'w8-tree-lod-diagnostics'), false);
  assert.equal(presentation.setTreeLodDiagnosticsEnabled(true), true);
  const diagnostic = generationRoot.children.find(child => child.name === 'w8-tree-lod-diagnostics');
  assert.ok(diagnostic);
  assert.equal(diagnostic.visible, true);
  const overlays = diagnostic.children.filter(child => child.userData?.treeLodTier);
  assert.equal(overlays.filter(child => child.userData.treeLodTier === 'full')
    .reduce((sum, child) => sum + child.count, 0), before.visibleCanonicalFullTreeCount);
  assert.equal(overlays.filter(child => child.userData.treeLodTier === 'forest')
    .reduce((sum, child) => sum + child.count, 0), before.visibleCanonicalSilhouetteTreeCount);
  assert.equal(overlays.filter(child => child.userData.treeLodTier === 'atmospheric')
    .reduce((sum, child) => sum + child.count, 0), before.visibleCanonicalUltraTreeCount);
  assert.equal(overlays.every(child => child.material.depthTest === false
    && child.material.depthWrite === false && child.renderOrder >= 10_000), true);
  const ring = diagnostic.children.find(child => (
    child.name === 'w8-tree-lod-debug-atmospheric-fade-ring'
  ));
  assert.ok(ring);
  assert.equal(ring.userData.radiusMeters, 140);
  assert.equal(ring.material.depthTest, false);
  assert.equal(ring.renderOrder, 10_003);
  assert.equal(presentation.setTreeLodDiagnosticsEnabled(false), false);
  assert.equal(generationRoot.children.some(child => child.name === 'w8-tree-lod-diagnostics'), false);
  assert.deepEqual(presentation.snapshot().visibleCanonicalTreeCount, before.visibleCanonicalTreeCount);
  assert.equal(presentation.snapshot().distantTreeProxyCount, 0);
  presentation.dispose();
});

test('Tree path audit isolates legacy-only, static-only, and dual-root rendering', async t => {
  const candidate = (ownerX, suffix, x) => Object.freeze({
    candidateId: `detail-v1:path-audit:${ownerX}:${suffix}`,
    subtype: 'broadleaf-tree',
    variationSeed: 0.75,
    orientationSeed: 0.25,
    worldPosition: Object.freeze({ x, y: 0.4, z: 8 }),
    owningChunkCoordinate: Object.freeze({ x: ownerX, z: 0 }),
    metadata: Object.freeze({ candidateRadiusMeters: 0.32 }),
  });
  const createTreeChunk = (ownerX, trees) => {
    const chunk = canonicalChunk(ownerX, 0, []);
    chunk.vegetationCandidates = Object.freeze(trees);
    chunk.presentationLayers.natural = { vegetation: chunk.vegetationCandidates, rocks: [] };
    return chunk;
  };
  const firstChunk = createTreeChunk(5, [
    candidate(5, 'full', 56),
    candidate(5, 'forest', 80),
    candidate(5, 'ultra', 92),
  ]);
  const secondChunk = createTreeChunk(6, [candidate(6, 'replacement', 104)]);
  const chunks = new Map([['5,0', firstChunk], ['6,0', secondChunk]]);
  const scene = new DistantTestGroup();
  const createPresentation = incrementalStaticTreePages => createW8DistantPresentation({
    THREE: DISTANT_TEST_THREE,
    scene,
    worldSeedHash: CANONICAL_WORLD_SEED_HASH,
    visualAssets: createSilhouetteTestVisualAssets(),
    findSettlementsNear: async () => [],
    resolveTemplate: async () => null,
    getCanonicalChunkData: async (chunkX, chunkZ) => (
      chunks.get(`${chunkX},${chunkZ}`) ?? canonicalChunk(chunkX, chunkZ, [])
    ),
    incrementalStaticTreePages,
  });
  const syncInput = canonicalSyncInput({
    centerChunkX: 0,
    activeDataKeys: ['5,0'],
    renderedKeys: [],
    chunk: firstChunk,
    playerLogicalX: 8,
    quality: 'high',
  });
  const legacy = await createPresentation(false);
  assert.equal(await legacy.sync(syncInput), true);
  legacy.markFirstDraw();
  const legacyAudit = Object.fromEntries(legacy.treePathAuditSnapshot().map(path => (
    [path.pathId, path]
  )));
  assert.equal(legacyAudit['distant-legacy-tree'].active, true);
  assert.equal(legacyAudit['distant-legacy-tree'].instanceCount > 0, true);
  assert.equal(legacyAudit['distant-static-tree'].instanceCount, 0);

  const shared = await createPresentation(true);
  assert.equal(await shared.sync(syncInput), true);
  let coverageGeneration = 1;
  let planRevision = 1;
  const apply = ({ retainedOwnerKeys, readyPages = [] }) => shared.applyStaticTreePlan({
    coverageGeneration,
    planRevision,
    planId: `path-audit:${coverageGeneration}:${planRevision}`,
    destructionRevision: 'none',
    quality: 'high',
    renderDistancePreset: 'current',
    renderOrigin: syncInput.renderOrigin,
    playerLogicalX: 8,
    playerLogicalZ: 8,
    activeDataKeys: ['5,0'],
    renderedKeys: [],
    retainedOwnerKeys,
    readyPages,
  });
  const drive = async predicate => {
    for (let frame = 0; frame < 100 && !predicate(); frame += 1) {
      shared.update(8, 8, syncInput.renderOrigin);
      shared.markFirstDraw();
      await new Promise(resolve => setImmediate(resolve));
    }
    assert.equal(predicate(), true);
  };
  apply({
    retainedOwnerKeys: ['5,0'],
    readyPages: [{
      ownerKey: '5,0', resourceKind: 'canonical', value: firstChunk,
      readyAtMs: performance.now(), required: true, deadlineAtMs: performance.now() + 100,
    }],
  });
  await drive(() => shared.snapshot().staticTreeCurrentPublishedOwnerCount === 1);
  const sharedAudit = Object.fromEntries(shared.treePathAuditSnapshot().map(path => (
    [path.pathId, path]
  )));
  assert.equal(sharedAudit['distant-static-tree'].active, true);
  assert.equal(sharedAudit['distant-static-tree'].instanceCount > 0, true);
  assert.equal(sharedAudit['distant-legacy-tree'].instanceCount, 0);
  assert.deepEqual(sharedAudit['distant-static-tree'].publicationSources,
    ['static-owner-page-ticket']);
  assert.deepEqual(sharedAudit['distant-static-tree'].coverageGenerations, [1]);

  const dualRootCount = legacyAudit['distant-legacy-tree'].rootCount
    + sharedAudit['distant-static-tree'].rootCount;
  const dualInstanceCount = legacyAudit['distant-legacy-tree'].instanceCount
    + sharedAudit['distant-static-tree'].instanceCount;
  assert.equal(dualRootCount, 2);
  assert.equal(dualInstanceCount > sharedAudit['distant-static-tree'].instanceCount, true);

  coverageGeneration += 1;
  planRevision += 1;
  apply({
    retainedOwnerKeys: ['5,0', '6,0'],
    readyPages: [{
      ownerKey: '6,0', resourceKind: 'canonical', value: secondChunk,
      readyAtMs: performance.now(), required: true, deadlineAtMs: performance.now() + 100,
    }],
  });
  await drive(() => shared.snapshot().staticTreeResidentOwnerCount === 2
    && shared.snapshot().staticTreePendingOwnerCount === 0
    && shared.snapshot().staticTreeCurrentPublishedOwnerCount === 2);
  const moving = shared.treePathAuditSnapshot();
  coverageGeneration += 1;
  planRevision += 1;
  apply({ retainedOwnerKeys: ['5,0'] });
  await drive(() => shared.snapshot().staticTreeDisposeOwnerCount === 0
    && shared.snapshot().staticTreeResidentOwnerCount === 1);
  const stopped = shared.treePathAuditSnapshot();
  coverageGeneration += 1;
  planRevision += 1;
  apply({
    retainedOwnerKeys: ['5,0', '6,0'],
    readyPages: [{
      ownerKey: '6,0', resourceKind: 'canonical', value: secondChunk,
      readyAtMs: performance.now(), required: true, deadlineAtMs: performance.now() + 100,
    }],
  });
  await drive(() => shared.snapshot().staticTreeResidentOwnerCount === 2
    && shared.snapshot().staticTreePendingOwnerCount === 0
    && shared.snapshot().staticTreeCurrentPublishedOwnerCount === 2);
  const reaccelerated = shared.treePathAuditSnapshot();
  const activeTreeInstanceCount = audit => audit
    .filter(path => path.pathId !== 'distant-legacy-tree')
    .reduce((sum, path) => sum + path.instanceCount, 0);
  for (const audit of [moving, stopped, reaccelerated]) {
    const staticPath = audit.find(path => path.pathId === 'distant-static-tree');
    assert.equal(staticPath.rootCount, 1);
    assert.equal(audit.find(path => path.pathId === 'distant-legacy-tree').rootCount, 0);
  }
  assert.equal(activeTreeInstanceCount(moving) > activeTreeInstanceCount(stopped), true);
  assert.equal(activeTreeInstanceCount(reaccelerated), activeTreeInstanceCount(moving));
  t.diagnostic(JSON.stringify({
    legacyOnly: legacyAudit,
    staticOnly: sharedAudit,
    bothEnabled: { rootCount: dualRootCount, instanceCount: dualInstanceCount },
    moving: {
      instanceCount: activeTreeInstanceCount(moving),
      paths: moving.filter(path => path.active),
    },
    stopped: {
      instanceCount: activeTreeInstanceCount(stopped),
      paths: stopped.filter(path => path.active),
    },
    reaccelerated: {
      instanceCount: activeTreeInstanceCount(reaccelerated),
      paths: reaccelerated.filter(path => path.active),
    },
  }));
  legacy.dispose();
  shared.dispose();
});

test('Current natural query covers exact 140m Trees plus sparse canonical Forest horizon to Fog', async () => {
  const chunkSize = 16;
  const queryRadius = 140;
  const horizonRadius = resolveW8VegetationLodPolicy('tree', 'current')
    .horizonVisibilityMeters;
  const innerRadius = 84;
  const intersects = (chunkX, chunkZ, playerX, playerZ, radius) => {
    const nearestX = Math.max(chunkX * chunkSize, Math.min(playerX, (chunkX + 1) * chunkSize));
    const nearestZ = Math.max(chunkZ * chunkSize, Math.min(playerZ, (chunkZ + 1) * chunkSize));
    return Math.hypot(playerX - nearestX, playerZ - nearestZ) <= radius;
  };
  const run = async (playerLogicalX, playerLogicalZ) => {
    const centerChunkX = Math.floor(playerLogicalX / chunkSize);
    const centerChunkZ = Math.floor(playerLogicalZ / chunkSize);
    const activeDataKeys = [];
    for (let chunkZ = centerChunkZ - 2; chunkZ <= centerChunkZ + 2; chunkZ += 1) {
      for (let chunkX = centerChunkX - 2; chunkX <= centerChunkX + 2; chunkX += 1) {
        activeDataKeys.push(`${chunkX},${chunkZ}`);
      }
    }
    const activeKeys = new Set(activeDataKeys);
    const chunks = new Map();
    const exactProviderCalls = [];
    const horizonProviderCalls = [];
    const getChunk = (chunkX, chunkZ) => {
      const key = `${chunkX},${chunkZ}`;
      if (!chunks.has(key)) chunks.set(key, canonicalChunk(chunkX, chunkZ, []));
      return chunks.get(key);
    };
    const presentation = await createW8DistantPresentation({
      THREE: DISTANT_TEST_THREE,
      scene: new DistantTestGroup(),
      worldSeedHash: CANONICAL_WORLD_SEED_HASH,
      visualAssets: createSilhouetteTestVisualAssets(),
      findSettlementsNear: async () => [],
      resolveTemplate: async () => null,
      getCanonicalChunkData: async (chunkX, chunkZ) => {
        exactProviderCalls.push(`${chunkX},${chunkZ}`);
        return getChunk(chunkX, chunkZ);
      },
      getForestHorizonManifest: async (chunkX, chunkZ) => {
        horizonProviderCalls.push(`${chunkX},${chunkZ}`);
        return getChunk(chunkX, chunkZ);
      },
    });
    const syncInput = {
      activeDataKeys,
      renderedKeys: [],
      getChunkData: getChunk,
      renderOrigin: { renderOriginChunkX: centerChunkX, renderOriginChunkZ: centerChunkZ },
      centerChunkX,
      centerChunkZ,
      quality: 'high',
      playerLogicalX,
      playerLogicalZ,
    };
    assert.equal(await presentation.sync(syncInput), true);
    const first = presentation.snapshot();
    const firstExactProviderCalls = [...exactProviderCalls];
    const firstHorizonProviderCalls = [...horizonProviderCalls];
    assert.equal(await presentation.sync(syncInput), true);
    const second = presentation.snapshot();
    const transitionedActiveDataKeys = activeDataKeys.map(key => {
      const [chunkX, chunkZ] = key.split(',').map(Number);
      return `${chunkX + 1},${chunkZ}`;
    });
    assert.equal(await presentation.sync({
      ...syncInput,
      activeDataKeys: transitionedActiveDataKeys,
      renderOrigin: { renderOriginChunkX: centerChunkX + 1, renderOriginChunkZ: centerChunkZ },
      centerChunkX: centerChunkX + 1,
      playerLogicalX: playerLogicalX + chunkSize,
    }), true);
    const transition = presentation.snapshot();
    const expectedExact = [];
    const expectedHorizon = [];
    const innerCircle = [];
    const ultraCircle = [];
    for (let chunkZ = Math.floor((playerLogicalZ - horizonRadius) / chunkSize);
      chunkZ <= Math.floor((playerLogicalZ + horizonRadius) / chunkSize); chunkZ += 1) {
      for (let chunkX = Math.floor((playerLogicalX - horizonRadius) / chunkSize);
        chunkX <= Math.floor((playerLogicalX + horizonRadius) / chunkSize); chunkX += 1) {
        const key = `${chunkX},${chunkZ}`;
        if (intersects(chunkX, chunkZ, playerLogicalX, playerLogicalZ, queryRadius)
          && !activeKeys.has(key)) expectedExact.push(key);
        if (intersects(chunkX, chunkZ, playerLogicalX, playerLogicalZ, horizonRadius)
          && isW8ForestHorizonOwner({
            worldSeedHash: CANONICAL_WORLD_SEED_HASH,
            chunkX,
            chunkZ,
          }) && !activeKeys.has(key)) expectedHorizon.push(key);
        if (intersects(chunkX, chunkZ, playerLogicalX, playerLogicalZ, innerRadius)) innerCircle.push(key);
        else if (intersects(chunkX, chunkZ, playerLogicalX, playerLogicalZ, queryRadius)) ultraCircle.push(key);
      }
    }
    const expected = [...new Set([...expectedExact, ...expectedHorizon])].sort();
    const expectedHorizonOnly = expectedHorizon.filter(key => !expectedExact.includes(key)).sort();
    assert.deepEqual([...firstHorizonProviderCalls].sort(), expectedHorizonOnly);
    assert.equal(firstExactProviderCalls.some(key => expectedHorizonOnly.includes(key)), false);
    assert.deepEqual([...first.queryNaturalOwnerChunkKeys].sort(), expected);
    assert.equal(first.queryNaturalOwnerChunkCount, expected.length);
    assert.deepEqual([...first.queryForestHorizonOwnerChunkKeys].sort(), expectedHorizon.sort());
    assert.equal(first.queryForestHorizonOnlyOwnerChunkCount, expectedHorizonOnly.length);
    assert.equal(first.queryExcludedActiveNaturalOwnerCount, 25);
    assert.equal(first.queryInnerNaturalOwnerChunkCount, innerCircle.filter(key => !activeKeys.has(key)).length);
    assert.equal(first.queryUltraOwnerChunkCount, ultraCircle.filter(key => !activeKeys.has(key)).length);
    assert.equal(first.queryFarOwnerChunkCacheMisses, first.queryInnerNaturalOwnerChunkCount);
    assert.equal(first.queryUltraOwnerChunkCacheMisses, first.queryUltraOwnerChunkCount);
    assert.equal(first.queryForestHorizonOwnerChunkCacheMisses,
      first.queryForestHorizonOnlyOwnerChunkCount);
    assert.equal(first.queryFarOwnerChunkCacheEvictions, 0);
    assert.equal(first.queryUltraOwnerChunkCacheEvictions, 0);
    assert.equal(first.queryForestHorizonOwnerChunkCacheEvictions, 0);
    assert.equal(second.queryFarOwnerChunkCacheHits, second.queryInnerNaturalOwnerChunkCount);
    assert.equal(second.queryFarOwnerChunkCacheMisses, 0);
    assert.equal(second.queryUltraOwnerChunkCacheHits, second.queryUltraOwnerChunkCount);
    assert.equal(second.queryUltraOwnerChunkCacheMisses, 0);
    assert.equal(second.queryForestHorizonOwnerChunkCacheHits,
      second.queryForestHorizonOnlyOwnerChunkCount);
    assert.equal(second.queryForestHorizonOwnerChunkCacheMisses, 0);
    assert.equal(second.queryFarOwnerChunkCacheEvictions, 0);
    assert.equal(second.queryUltraOwnerChunkCacheEvictions, 0);
    assert.ok(transition.queryFarOwnerChunkCacheMisses > 0);
    assert.ok(transition.queryUltraOwnerChunkCacheMisses > 0);
    assert.equal(transition.queryFarOwnerChunkCacheEvictions, 0);
    assert.ok(transition.queryPreparationDurationMs >= 0);
    assert.ok(second.innerWarmDurationMs >= 0);
    assert.ok(second.ultraWarmDurationMs >= 0);
    assert.ok(second.forestHorizonWarmDurationMs >= 0);
    assert.equal(second.queryConcurrencyLimit, 4);
    assert.ok(second.maximumObservedQueryConcurrency <= 4);
    assert.equal(second.ultraOwnerChunkCacheCapacity, 256);
    assert.equal(second.forestHorizonOwnerChunkCacheCapacity, 320);
    for (const key of [...innerCircle, ...ultraCircle]) {
      assert.equal(activeKeys.has(key) || first.queryNaturalOwnerChunkKeys.includes(key), true);
    }
    for (const key of first.queryNaturalOwnerChunkKeys) {
      const [chunkX, chunkZ] = key.split(',').map(Number);
      assert.equal(activeKeys.has(key), false);
      assert.equal(
        intersects(chunkX, chunkZ, playerLogicalX, playerLogicalZ, queryRadius)
          || (intersects(chunkX, chunkZ, playerLogicalX, playerLogicalZ, horizonRadius)
            && isW8ForestHorizonOwner({
              worldSeedHash: CANONICAL_WORLD_SEED_HASH,
              chunkX,
              chunkZ,
            })),
        true,
      );
    }
    presentation.dispose();
  };
  await run(8, 8);
  await run(15.75, 8);
  await run(15.75, 15.75);
});

test('a real horizon-only owner keeps canonical Tree identity through rebase, destruction, and Continue', async () => {
  const owner = Object.freeze({ x: 11, z: 4 });
  assert.equal(isW8ForestHorizonOwner({
    worldSeedHash: CANONICAL_WORLD_SEED_HASH,
    chunkX: owner.x,
    chunkZ: owner.z,
  }), true);
  const tree = Object.freeze({
    candidateId: 'detail-v1:vegetation:canonical-horizon-only-tree',
    subtype: 'broadleaf-tree',
    variationSeed: 0.75,
    orientationSeed: 0.25,
    // Intentionally wrong source Y: the horizon summary must bake the same
    // canonical sloped Terrain surface as the exact presentation path.
    worldPosition: Object.freeze({ x: 184, y: -99, z: 72 }),
    owningChunkCoordinate: owner,
    metadata: Object.freeze({ candidateRadiusMeters: 0.32 }),
  });
  const chunk = canonicalChunk(owner.x, owner.z, []);
  chunk.terrain = {
    ...flatDistantTerrain(),
    heights: [0, 16_000, 0, 16_000],
  };
  chunk.canonicalSurfacePolicy = Object.freeze({
    schemaVersion: 'w8-settlement-surface-policy-1',
    regions: Object.freeze([]),
    riverCorridors: Object.freeze([]),
  });
  chunk.vegetationCandidates = [tree];
  chunk.presentationLayers.natural = { vegetation: [tree], rocks: [] };
  let state = new InfiniteWorldState({
    worldSeed: 'forest-horizon-continue',
    worldSeedHash: CANONICAL_WORLD_SEED_HASH,
    playerSpawn: { x: 8, z: 8 },
  });
  const createPresentation = scene => createW8DistantPresentation({
    THREE: DISTANT_TEST_THREE,
    scene,
    worldSeedHash: CANONICAL_WORLD_SEED_HASH,
    visualAssets: createSilhouetteTestVisualAssets(),
    findSettlementsNear: async () => [],
    resolveTemplate: async () => null,
    getCanonicalChunkData: async (chunkX, chunkZ) => (
      chunkX === owner.x && chunkZ === owner.z ? chunk : null
    ),
    isFeatureDestroyed: stableId => state.isFeatureDestroyed(stableId),
  });
  const syncInput = {
    activeDataKeys: [],
    renderedKeys: [],
    getChunkData: () => null,
    renderOrigin: { renderOriginChunkX: 0, renderOriginChunkZ: 0 },
    centerChunkX: 0,
    centerChunkZ: 0,
    quality: 'high',
    renderDistancePreset: 'current',
    playerLogicalX: 8,
    playerLogicalZ: 8,
  };
  const scene = new DistantTestGroup();
  const presentation = await createPresentation(scene);
  assert.equal(await presentation.sync(syncInput), true);
  presentation.markFirstDraw();
  const horizonPath = presentation.treePathAuditSnapshot().find(path => (
    path.pathId === 'forest-horizon-tree'
  ));
  assert.equal(horizonPath.active, true);
  assert.equal(horizonPath.instanceCount, 1);
  assert.equal(horizonPath.stableIdCount, 1);
  assert.deepEqual(horizonPath.publicationSources, ['distant-atomic-root']);
  assert.equal(horizonPath.meshes.every(mesh => mesh.mode === 'horizon'), true);
  const initial = presentation.canonicalAuditSnapshot().find(value => (
    value.identity.stableId === tree.candidateId
  ));
  assert.ok(initial);
  assert.deepEqual(initial.identity.owningChunkCoordinate, owner);
  assert.deepEqual(initial.identity.worldPosition, { x: 184, y: 8, z: 72 });
  assert.equal(initial.naturalLod.naturalHorizonOnly, true);
  assert.equal(initial.naturalLod.forestHorizonEligible, true);
  assert.equal(initial.naturalLod.fullInstanceCount, 0);
  assert.equal(initial.naturalLod.forestInstanceCount, 0);
  assert.equal(initial.naturalLod.atmosphericInstanceCount, 0);
  assert.equal(initial.naturalLod.horizonInstanceCount, 1);
  assert.equal(initial.visibleLod, 'far');
  assert.equal(initial.distanceMeters > 140 && initial.distanceMeters < 234, true);

  presentation.update(15.75, 8, {
    renderOriginChunkX: 0,
    renderOriginChunkZ: 0,
    rebaseCount: 0,
  });
  const beforeBoundary = presentation.canonicalAuditSnapshot().find(value => (
    value.identity.stableId === tree.candidateId
  ));
  presentation.update(16.25, 8, {
    renderOriginChunkX: 1,
    renderOriginChunkZ: 0,
    rebaseCount: 1,
  });
  const afterBoundary = presentation.canonicalAuditSnapshot().find(value => (
    value.identity.stableId === tree.candidateId
  ));
  assert.deepEqual(afterBoundary.identity, beforeBoundary.identity);
  assert.equal(afterBoundary.visibleLod, 'far');
  assert.equal(Math.abs(
    afterBoundary.naturalLod.horizonOpacity - beforeBoundary.naturalLod.horizonOpacity
  ) < 0.02, true);
  assert.equal(presentation.snapshot().duplicateVisibleStableIdCount, 0);

  const identityBeforeRebase = initial.identity;
  presentation.update(8, 8, {
    renderOriginChunkX: 9,
    renderOriginChunkZ: -4,
    rebaseCount: 2,
  });
  const rebased = presentation.canonicalAuditSnapshot().find(value => (
    value.identity.stableId === tree.candidateId
  ));
  assert.deepEqual(rebased.identity, identityBeforeRebase);
  assert.equal(rebased.distanceMeters, initial.distanceMeters);
  assert.equal(rebased.naturalLod.horizonOpacity, initial.naturalLod.horizonOpacity);
  assert.equal(presentation.snapshot().duplicateVisibleStableIdCount, 0);

  presentation.update(-83, 72, {
    renderOriginChunkX: -6,
    renderOriginChunkZ: 3,
    rebaseCount: 3,
  });
  let moved = presentation.canonicalAuditSnapshot().find(value => (
    value.identity.stableId === tree.candidateId
  ));
  assert.equal(moved.distanceMeters, 267);
  assert.equal(moved.naturalLod.horizonOpacity, 0.5);
  presentation.update(-116, 72, {
    renderOriginChunkX: -8,
    renderOriginChunkZ: 3,
    rebaseCount: 4,
  });
  moved = presentation.canonicalAuditSnapshot().find(value => (
    value.identity.stableId === tree.candidateId
  ));
  assert.equal(moved.distanceMeters, 300);
  assert.equal(moved.naturalLod.horizonOpacity, 0);
  assert.equal(moved.visibleLod, 'hidden');
  presentation.update(8, 8, {
    renderOriginChunkX: 0,
    renderOriginChunkZ: 0,
    rebaseCount: 5,
  });

  state.damageFeature({ stableId: tree.candidateId, maxHp: 1 }, 1);
  presentation.update(8, 8, {
    renderOriginChunkX: 0,
    renderOriginChunkZ: 0,
    rebaseCount: 5,
  });
  const destroyed = presentation.canonicalAuditSnapshot().find(value => (
    value.identity.stableId === tree.candidateId
  ));
  assert.equal(destroyed.visibleLod, 'destroyed');
  assert.equal(destroyed.naturalLod.horizonInstanceCount, 0);
  presentation.dispose();

  const encoded = await encodeInfiniteWorldSave(state.createSaveSnapshot());
  const decoded = await decodeInfiniteWorldSave(encoded, {
    worldSeedHash: CANONICAL_WORLD_SEED_HASH,
  });
  state = new InfiniteWorldState({
    worldSeed: 'forest-horizon-continue',
    worldSeedHash: CANONICAL_WORLD_SEED_HASH,
    playerSpawn: { x: 8, z: 8 },
  });
  state.restoreSaveSnapshot(decoded);
  const restoredScene = new DistantTestGroup();
  const restored = await createPresentation(restoredScene);
  assert.equal(await restored.sync(syncInput), true);
  const continued = restored.canonicalAuditSnapshot().find(value => (
    value.identity.stableId === tree.candidateId
  ));
  assert.equal(continued.visibleLod, 'destroyed');
  assert.equal(continued.naturalLod.horizonInstanceCount, 0);
  assert.equal(restored.snapshot().visibleCanonicalForestHorizonInstanceCount, 0);
  restored.dispose();
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
      resourceKind: 'canonical',
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
  const presentation = await createW8DistantPresentation({
    THREE: DISTANT_TEST_THREE,
    scene: new DistantTestGroup(),
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
  presentation.markFirstDraw();
  snapshot = presentation.snapshot();
  const lifecycleSnapshot = telemetry.snapshot();
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

test('incremental Tree stop-drain-reaccelerate harness enforces unified per-frame work limits', async t => {
  const ownerCount = 160;
  const treesPerOwner = 8;
  const createPage = ownerX => {
    const vegetation = Object.freeze(Array.from({ length: treesPerOwner }, (_, index) => (
      Object.freeze({
        candidateId: `detail-v1:vegetation:stream-harness:${ownerX}:${index}`,
        subtype: 'broadleaf-tree',
        variationSeed: (index + 1) / (treesPerOwner + 1),
        orientationSeed: index / treesPerOwner,
        worldPosition: Object.freeze({
          x: ownerX * LEGACY_CHUNK_SIZE_METERS + 2 + index,
          y: 0.4,
          z: 8,
        }),
        owningChunkCoordinate: Object.freeze({ x: ownerX, z: 0 }),
        metadata: Object.freeze({ candidateRadiusMeters: 0.32 }),
      })
    )));
    const chunk = canonicalChunk(ownerX, 0, []);
    chunk.vegetationCandidates = vegetation;
    chunk.presentationLayers.natural = { vegetation, rocks: [] };
    return Object.freeze({
      ownerKey: `${ownerX},0`,
      resourceKind: 'canonical',
      value: chunk,
      readyAtMs: performance.now(),
      required: ownerX % 4 === 0,
      deadlineAtMs: performance.now() + (ownerX % 4 === 0 ? 100 : 1_000),
    });
  };
  const initialPages = Object.freeze(Array.from({ length: ownerCount }, (_, index) => (
    createPage(index + 1)
  )));
  const replacementPages = Object.freeze(Array.from({ length: ownerCount / 2 }, (_, index) => (
    createPage(ownerCount + index + 1)
  )));
  const initialOwnerKeys = Object.freeze(initialPages.map(page => page.ownerKey));
  const retainedAfterAcceleration = Object.freeze([
    ...initialOwnerKeys.slice(ownerCount / 2),
    ...replacementPages.map(page => page.ownerKey),
  ]);
  const telemetry = createWorldStreamingTelemetry({
    enabled: true,
    capacity: 4096,
    sessionId: 'tree-stop-drain-reaccelerate',
  });
  const publishedOwners = [];
  const publishedAtByOwner = new Map();
  const presentation = await createW8DistantPresentation({
    THREE: DISTANT_TEST_THREE,
    scene: new DistantTestGroup(),
    worldSeedHash: CANONICAL_WORLD_SEED_HASH,
    visualAssets: createSilhouetteTestVisualAssets(),
    findSettlementsNear: async () => [],
    resolveTemplate: async () => null,
    getCanonicalChunkData: async () => null,
    incrementalStaticTreePages: true,
    telemetry,
    yieldToMainThread: () => new Promise(resolve => setImmediate(resolve)),
    publishStaticOwnerTickets: input => {
      publishedOwners.push(...input.ownerKeys);
      for (const ownerKey of input.ownerKeys) publishedAtByOwner.set(ownerKey, performance.now());
      return Object.freeze(input.ownerKeys.map(ownerKey => Object.freeze({ ownerKey })));
    },
  });
  const renderOrigin = { renderOriginChunkX: 0, renderOriginChunkZ: 0 };
  const plan = ({ coverageGeneration, planRevision, retainedOwnerKeys, readyPages }) => ({
    coverageGeneration,
    planRevision,
    planId: `tree-stream-harness:${coverageGeneration}:${planRevision}`,
    destructionRevision: 'none',
    quality: 'high',
    renderDistancePreset: 'current',
    renderOrigin,
    playerLogicalX: 8,
    playerLogicalZ: 8,
    activeDataKeys: [],
    renderedKeys: [],
    retainedOwnerKeys,
    readyPages,
  });
  const updateDurations = [];
  const admissionBacklogs = [];
  const prioritizeReadyPages = pages => [...pages].sort((left, right) => (
    Number(right.required) - Number(left.required)
      || left.deadlineAtMs - right.deadlineAtMs
      || left.readyAtMs - right.readyAtMs
      || left.ownerKey.localeCompare(right.ownerKey)
  ));
  let activeCoverageGeneration = 1;
  let activeRetainedOwnerKeys = initialOwnerKeys;
  let sourceReadyPages = prioritizeReadyPages(initialPages);
  let planRevision = 0;
  let capacityPhase = 'moving';
  let capacityPlayerSpeed = 33;
  let previousPublishedEventCount = 0;
  let previousStaleCount = 0;
  const capacityFrames = [];
  const updateOnce = async () => {
    const readyPages = sourceReadyPages.splice(0, resolveNaturalOwnerBuildQueueTarget({
      backlog: sourceReadyPages.length,
    }));
    presentation.applyStaticTreePlan(plan({
      coverageGeneration: activeCoverageGeneration,
      planRevision: ++planRevision,
      retainedOwnerKeys: activeRetainedOwnerKeys,
      readyPages,
    }));
    const startedAt = performance.now();
    presentation.update(8, 8, renderOrigin);
    updateDurations.push(performance.now() - startedAt);
    presentation.markFirstDraw();
    const state = presentation.snapshot();
    admissionBacklogs.push(
      sourceReadyPages.length
        + state.staticTreePendingOwnerCount
        + state.staticTreeDisposeOwnerCount,
    );
    await new Promise(resolve => setImmediate(resolve));
    const sampled = presentation.snapshot();
    capacityFrames.push(Object.freeze({
      phase: capacityPhase,
      playerSpeed: capacityPlayerSpeed,
      requested: readyPages.length,
      required: readyPages.filter(page => page.required).length,
      published: publishedOwners.length - previousPublishedEventCount,
      usefulPublished: publishedOwners.length - previousPublishedEventCount,
      staleCompleted: sampled.staticTreeStalePageDiscardCount - previousStaleCount,
      cancelled: 0,
      queueDepth: sourceReadyPages.length,
      inFlight: sampled.staticTreeBuildInFlightCount,
      preparePending: sampled.staticTreePreparePendingOwnerCount
        + sampled.staticTreeBuildQueuedOwnerCount,
      publicationPending: sampled.staticTreePublicationPendingOwnerCount,
      gateActive: false,
      gateDuration: 0,
    }));
    previousPublishedEventCount = publishedOwners.length;
    previousStaleCount = sampled.staticTreeStalePageDiscardCount;
  };
  const driveUntil = async (predicate, maximumFrames = 1_000) => {
    let frames = 0;
    while (!predicate() && frames < maximumFrames) {
      await updateOnce();
      frames += 1;
    }
    assert.equal(predicate(), true, 'Tree presentation backlog did not drain');
    return frames;
  };
  const percentile = (values, ratio) => {
    if (!values.length) return 0;
    const ordered = [...values].sort((left, right) => left - right);
    return ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * ratio))];
  };
  const summarize = samples => ({
    frameCount: samples.length,
    publishedOwnerCount: samples.reduce((sum, sample) => sum + sample.publishedOwners, 0),
    admittedOwnerCount: samples.reduce((sum, sample) => sum + sample.admittedOwners, 0),
    admissionMaximumPerFrame: Math.max(0, ...samples.map(sample => sample.admittedOwners)),
    publishOwnerMaximumPerFrame: Math.max(0, ...samples.map(sample => sample.publishedOwners)),
    builtOwnerCount: samples.reduce((sum, sample) => sum + sample.builtOwners, 0),
    disposedOwnerCount: samples.reduce((sum, sample) => sum + sample.disposedOwners, 0),
    disposeOwnerMaximumPerFrame: Math.max(0, ...samples.map(sample => sample.disposedOwners)),
    compactionMoveCount: samples.reduce((sum, sample) => sum + sample.compactionMoves, 0),
    compactionMoveMaximumPerFrame: Math.max(0, ...samples.map(sample => sample.compactionMoves)),
    visibilityMatrixInvalidationCount: samples.reduce((sum, sample) => (
      sum + sample.visibilityMatrixInvalidations
    ), 0),
    matrixUpdateCount: samples.reduce((sum, sample) => sum + sample.matrixUpdates, 0),
    matrixUpdateMaximumPerFrame: Math.max(0, ...samples.map(sample => sample.matrixUpdates)),
    bufferUpdateCount: samples.reduce((sum, sample) => sum + sample.attributeUpdates, 0),
    bufferUpdateMaximumPerFrame: Math.max(0, ...samples.map(sample => sample.attributeUpdates)),
    bufferRangeUpdateCount: samples.reduce((sum, sample) => (
      sum + sample.bufferRangeUpdates
    ), 0),
    bufferRangeUpdateMaximumPerFrame: Math.max(
      0,
      ...samples.map(sample => sample.bufferRangeUpdates),
    ),
    bufferUploadBytes: samples.reduce((sum, sample) => sum + sample.bufferUploadBytes, 0),
    bufferUploadMaximumBytesPerFrame: Math.max(
      0,
      ...samples.map(sample => sample.bufferUploadBytes),
    ),
    visibilityMaximumMs: Math.max(0, ...samples.map(sample => sample.visibilityMs)),
    composeMaximumMs: Math.max(0, ...samples.map(sample => sample.composeMs)),
    disposeMaximumMs: Math.max(0, ...samples.map(sample => sample.disposeMs)),
    buildMaximumSliceMs: Math.max(0, ...samples.map(sample => sample.buildMaximumSliceMs)),
    sampleTotalP95Ms: percentile(samples.map(sample => sample.totalMs), 0.95),
    sampleTotalMaximumMs: Math.max(0, ...samples.map(sample => sample.totalMs)),
    residentMaximum: Math.max(0, ...samples.map(sample => sample.residentAfter)),
    pendingMaximum: Math.max(0, ...samples.map(sample => (
      sample.pendingPagesBefore + sample.pendingPublicationsBefore
    ))),
    allocatedObjects: samples.reduce((sum, sample) => sum + sample.allocatedObjects, 0),
    allocatedInstances: samples.reduce((sum, sample) => sum + sample.allocatedInstances, 0),
    allocatedBuckets: samples.reduce((sum, sample) => sum + sample.allocatedBuckets, 0),
  });

  const heapBefore = process.memoryUsage().heapUsed;
  for (let frame = 0; frame < 24; frame += 1) await updateOnce();
  let snapshot = presentation.snapshot();
  const movingSequence = snapshot.staticTreeFrameSamples.at(-1)?.frameSequence ?? 0;
  const moving = summarize(snapshot.staticTreeFrameSamples);
  const movingState = {
    resident: snapshot.staticTreeResidentOwnerCount,
    pending: snapshot.staticTreePendingOwnerCount,
    published: snapshot.staticTreeCurrentPublishedOwnerCount,
  };

  capacityPhase = 'stopped';
  capacityPlayerSpeed = 0;
  const stopFrames = await driveUntil(() => {
    const state = presentation.snapshot();
    return sourceReadyPages.length === 0
      && state.staticTreePendingOwnerCount === 0
      && state.staticTreeCurrentPublishedOwnerCount === ownerCount;
  });
  snapshot = presentation.snapshot();
  const stoppedSequence = snapshot.staticTreeFrameSamples.at(-1)?.frameSequence ?? movingSequence;
  const stopped = summarize(snapshot.staticTreeFrameSamples.filter(sample => (
    sample.frameSequence > movingSequence && sample.frameSequence <= stoppedSequence
  )));
  const stoppedState = {
    resident: snapshot.staticTreeResidentOwnerCount,
    pending: snapshot.staticTreePendingOwnerCount,
    published: snapshot.staticTreeCurrentPublishedOwnerCount,
  };

  const replacementReadyAtMs = performance.now();
  const accelerationPages = replacementPages.map(page => Object.freeze({
    ...page,
    readyAtMs: replacementReadyAtMs,
  }));
  activeCoverageGeneration = 2;
  activeRetainedOwnerKeys = retainedAfterAcceleration;
  sourceReadyPages = prioritizeReadyPages(accelerationPages);
  capacityPhase = 'reaccelerated';
  capacityPlayerSpeed = 47.85;
  const accelerationUpdateStart = updateDurations.length;
  const accelerationBacklogStart = admissionBacklogs.length;
  const accelerationFrames = await driveUntil(() => {
    const state = presentation.snapshot();
    return sourceReadyPages.length === 0
      && state.staticTreePendingOwnerCount === 0
      && state.staticTreeDisposeOwnerCount === 0
      && state.staticTreeCurrentPublishedOwnerCount === ownerCount;
  });
  snapshot = presentation.snapshot();
  const accelerated = summarize(snapshot.staticTreeFrameSamples.filter(sample => (
    sample.frameSequence > stoppedSequence
  )));
  const accelerationUpdateDurations = updateDurations.slice(accelerationUpdateStart);
  const accelerationBacklogs = admissionBacklogs.slice(accelerationBacklogStart);
  const accelerationPublicationWaits = accelerationPages.map(page => (
    publishedAtByOwner.get(page.ownerKey) - page.readyAtMs
  ));
  const requiredPublicationWaits = accelerationPages.filter(page => page.required).map(page => (
    publishedAtByOwner.get(page.ownerKey) - page.readyAtMs
  ));
  const prefetchedPublicationWaits = accelerationPages.filter(page => !page.required).map(page => (
    publishedAtByOwner.get(page.ownerKey) - page.readyAtMs
  ));
  const heapAfter = process.memoryUsage().heapUsed;
  const lifecycleSnapshot = telemetry.snapshot();
  const capacityWindows = Object.freeze(['moving', 'stopped', 'reaccelerated']
    .flatMap(phase => {
      const frames = capacityFrames.filter(frame => frame.phase === phase);
      const windows = [];
      for (let offset = 0; offset < frames.length; offset += 60) {
        const samples = frames.slice(offset, offset + 60);
        const rate = 60 / samples.length;
        const sum = key => samples.reduce((total, sample) => total + sample[key], 0);
        windows.push(Object.freeze({
          time: `${phase}:${Math.floor(offset / 60)}`,
          playerSpeed: samples[0]?.playerSpeed ?? 0,
          requestedPerSec: sum('requested') * rate,
          requiredPerSec: sum('required') * rate,
          publishedPerSec: sum('published') * rate,
          usefulPublishedPerSec: sum('usefulPublished') * rate,
          staleCompletedPerSec: sum('staleCompleted') * rate,
          cancelledPerSec: sum('cancelled') * rate,
          queueDepth: Math.max(0, ...samples.map(sample => sample.queueDepth)),
          inFlight: Math.max(0, ...samples.map(sample => sample.inFlight)),
          preparePending: Math.max(0, ...samples.map(sample => sample.preparePending)),
          publicationPending: Math.max(
            0,
            ...samples.map(sample => sample.publicationPending),
          ),
          gateActive: samples.some(sample => sample.gateActive),
          gateDuration: sum('gateDuration'),
        }));
      }
      return windows;
    }));
  const maximumBacklogDrop = Math.max(0, ...accelerationBacklogs.slice(1).map((value, index) => (
    accelerationBacklogs[index] - value
  )));

  assert.equal(movingState.resident < ownerCount, true);
  assert.equal(movingState.pending > 0, true);
  assert.deepEqual(stoppedState, { resident: ownerCount, pending: 0, published: ownerCount });
  assert.equal(snapshot.staticTreeResidentOwnerCount, ownerCount);
  assert.equal(snapshot.staticTreeCurrentPublishedOwnerCount, ownerCount);
  assert.equal(snapshot.staticTreePendingOwnerCount, 0);
  assert.equal(snapshot.staticTreeDisposeOwnerCount, 0);
  assert.equal(snapshot.staticTreeOwnerDisposeCount, ownerCount / 2);
  assert.equal(snapshot.staticTreeDuplicatePageQueueCount, 0);
  assert.equal(snapshot.staticTreeOwnerRebuildCount, 0);
  assert.equal(snapshot.staticTreeStalePageDiscardCount, 0);
  assert.equal(snapshot.staticTreeRootResetCount, 1);
  assert.equal(
    snapshot.staticTreeMaximumAdmissionsPerFrame <= NATURAL_OWNER_BUILD_QUEUE_MAXIMUM,
    true,
  );
  assert.equal(snapshot.staticTreeAdmissionLimitViolationCount, 0);
  assert.equal(snapshot.staticNaturalActiveLegacyRecordCount, 0);
  assert.equal(snapshot.staticNaturalOverlappingStableIdCount, 0);
  assert.equal(moving.admissionMaximumPerFrame > 1, true);
  assert.equal(stopped.admissionMaximumPerFrame <= NATURAL_OWNER_BUILD_QUEUE_MAXIMUM, true);
  assert.equal(accelerated.admissionMaximumPerFrame <= NATURAL_OWNER_BUILD_QUEUE_MAXIMUM, true);
  assert.equal(accelerated.publishOwnerMaximumPerFrame <= 1, true);
  assert.equal(accelerated.disposeOwnerMaximumPerFrame <= 1, true);
  assert.equal(accelerated.disposedOwnerCount, ownerCount / 2);
  assert.equal(accelerated.frameCount > accelerated.disposedOwnerCount, true);
  assert.equal(maximumBacklogDrop <= NATURAL_OWNER_BUILD_QUEUE_MAXIMUM + 1, true);
  assert.equal(accelerated.visibilityMatrixInvalidationCount, 0);
  assert.equal(snapshot.staticTreeVisibilityMatrixInvalidationCount, 0);
  assert.equal(accelerated.visibilityMaximumMs < snapshot.staticTreeFrameBudgetMs, true);
  assert.equal(accelerated.composeMaximumMs < snapshot.staticTreeFrameBudgetMs, true);
  assert.equal(accelerated.disposeMaximumMs < snapshot.staticTreeFrameBudgetMs, true);
  assert.equal(accelerated.buildMaximumSliceMs < snapshot.staticTreeFrameBudgetMs, true);
  assert.equal(accelerated.matrixUpdateMaximumPerFrame <= 512, true);
  assert.equal(accelerated.bufferUpdateMaximumPerFrame <= 512, true);
  assert.equal(percentile(requiredPublicationWaits, 0.95)
    < percentile(prefetchedPublicationWaits, 0.95), true);
  assert.equal(Math.max(...accelerationUpdateDurations) < 50, true);
  assert.equal(accelerated.sampleTotalMaximumMs < 50, true);
  assert.equal(new Set(publishedOwners).size, ownerCount + ownerCount / 2);
  assert.equal(lifecycleSnapshot.lifecycles.every(value => value.firstDrawAtMs !== null), true);
  assert.equal(snapshot.staticTreeFrameSamples.length <= snapshot.staticTreeFrameSampleCapacity, true);
  const nodeBenchmark = evaluateNodeStreamingBenchmark({
    requiredOwnerMissingCount: lifecycleSnapshot.lifecycles.filter(value => (
      value.firstDrawAtMs === null
    )).length,
    duplicateQueueCount: snapshot.staticTreeDuplicatePageQueueCount,
    stalePublicationCount: snapshot.staticTreeStalePageDiscardCount,
    orphanResourceCount: snapshot.staticNaturalOrphanObjectCount
      + snapshot.staticNaturalOrphanSlotCount,
    admissionMaximumPerFrame: snapshot.staticTreeMaximumAdmissionsPerFrame,
    configuredAdmissionLimit: snapshot.staticTreeOwnerAdmissionMaximum,
    observedWork: {
      matrixUpdates: accelerated.matrixUpdateCount,
      bufferUpdates: accelerated.bufferUpdateCount,
      uploadBytes: accelerated.bufferUploadBytes,
      allocations: accelerated.allocatedObjects + accelerated.allocatedInstances
        + accelerated.allocatedBuckets,
      compactionMoves: accelerated.compactionMoveCount,
    },
  });
  assert.equal(nodeBenchmark.deterministicPass, true);
  assert.equal(nodeBenchmark.admissionLimitChangeRequired, false);
  assert.equal(nodeBenchmark.productionBudgetChangeRequired, false);
  assert.equal(nodeBenchmark.configuredAdmissionLimit, NATURAL_OWNER_BUILD_QUEUE_MAXIMUM);
  assert.equal(nodeBenchmark.browserFrameGate, 'pending');
  t.diagnostic(JSON.stringify({
    acceptance: nodeBenchmark,
    moving: { frames: 24, ...movingState, work: moving },
    stopped: { frames: stopFrames, ...stoppedState, work: stopped },
    reaccelerated: {
      frames: accelerationFrames,
      resident: snapshot.staticTreeResidentOwnerCount,
      pending: snapshot.staticTreePendingOwnerCount,
      published: snapshot.staticTreeCurrentPublishedOwnerCount,
      work: accelerated,
      updateP95Ms: percentile(accelerationUpdateDurations, 0.95),
      updateMaximumMs: Math.max(...accelerationUpdateDurations),
      publicationWaitP95Ms: percentile(accelerationPublicationWaits, 0.95),
      publicationWaitMaximumMs: Math.max(...accelerationPublicationWaits),
      requiredPublicationWaitP95Ms: percentile(requiredPublicationWaits, 0.95),
      prefetchedPublicationWaitP95Ms: percentile(prefetchedPublicationWaits, 0.95),
      maximumBacklogDrop,
      backlogStart: accelerationBacklogs[0],
      backlogEnd: accelerationBacklogs.at(-1),
      over50MsHarnessCount: accelerationUpdateDurations.filter(value => value > 50).length,
      firstDrawMissing: lifecycleSnapshot.lifecycles.filter(value => (
        value.firstDrawAtMs === null
      )).length,
    },
    totals: {
      ownerBuildCount: snapshot.staticTreeOwnerBuildCount,
      ownerReuseCount: snapshot.staticTreeOwnerReuseCount,
      ownerRebuildCount: snapshot.staticTreeOwnerRebuildCount,
      ownerDisposeCount: snapshot.staticTreeOwnerDisposeCount,
      duplicatePageQueueCount: snapshot.staticTreeDuplicatePageQueueCount,
      stalePageDiscardCount: snapshot.staticTreeStalePageDiscardCount,
      olderCoveragePageCount: snapshot.staticTreeOlderCoveragePageCount,
      rootResetCount: snapshot.staticTreeRootResetCount,
      admissionMaximumPerFrame: snapshot.staticTreeMaximumAdmissionsPerFrame,
      admissionLimitViolations: snapshot.staticTreeAdmissionLimitViolationCount,
      compactionMoveCount: snapshot.staticTreeCompactionMoveCount,
      visibilityMatrixInvalidationCount:
        snapshot.staticTreeVisibilityMatrixInvalidationCount,
      maximumVisibilitySliceMs: snapshot.staticTreeMaximumVisibilitySliceMs,
      maximumDisposeSliceMs: snapshot.staticTreeMaximumDisposeSliceMs,
      maximumComposeSliceMs: snapshot.staticTreeMaximumSliceMs,
      allocatedObjects: snapshot.staticTreeAllocatedObjectCount,
      allocatedInstances: snapshot.staticTreeAllocatedInstanceCount,
      allocatedBuckets: snapshot.staticTreeAllocatedBucketCount,
      heapDeltaBytes: heapAfter - heapBefore,
    },
    capacityWindows,
  }));
  presentation.dispose();
});

test('Tree Forest-to-Atmospheric-to-Horizon cross-fades remain continuous through Fog', async () => {
  const candidate = (candidateId, x) => Object.freeze({
    candidateId,
    subtype: 'broadleaf-tree',
    variationSeed: 1,
    orientationSeed: 0.25,
    worldPosition: Object.freeze({ x, y: 0.4, z: 8 }),
    owningChunkCoordinate: Object.freeze({ x: 5, z: 0 }),
    metadata: Object.freeze({ candidateRadiusMeters: 0.32 }),
  });
  const candidates = Object.freeze([
    ...Array.from({ length: 64 }, (_, index) => candidate(`detail-v1:handoff-76:${index}`, 84)),
    ...Array.from({ length: 64 }, (_, index) => candidate(`detail-v1:handoff-80:${index}`, 88)),
    ...Array.from({ length: 64 }, (_, index) => candidate(`detail-v1:ultra-84:${index}`, 92)),
    ...Array.from({ length: 64 }, (_, index) => candidate(`detail-v1:ultra-124:${index}`, 132)),
    ...Array.from({ length: 64 }, (_, index) => candidate(`detail-v1:ultra-132:${index}`, 140)),
    ...Array.from({ length: 64 }, (_, index) => candidate(`detail-v1:ultra-138:${index}`, 146)),
    ...Array.from({ length: 16 }, (_, index) => candidate(`detail-v1:ultra-140:${index}`, 148)),
  ]);
  const run = async vegetation => {
    const chunk = canonicalChunk(5, 0, []);
    chunk.vegetationCandidates = vegetation;
    chunk.presentationLayers.natural.vegetation = vegetation;
    const presentation = await createW8DistantPresentation({
      THREE: DISTANT_TEST_THREE,
      scene: new DistantTestGroup(),
      worldSeedHash: CANONICAL_WORLD_SEED_HASH,
      visualAssets: createSilhouetteTestVisualAssets(),
      findSettlementsNear: async () => [],
      resolveTemplate: async () => null,
      getCanonicalChunkData: async () => chunk,
    });
    assert.equal(await presentation.sync(canonicalSyncInput({
      centerChunkX: 0,
      activeDataKeys: ['5,0'],
      renderedKeys: [],
      chunk,
      playerLogicalX: 8,
      quality: 'high',
    })), true);
    const visibleByDistance = new Map();
    const opacityByDistance = new Map();
    for (const object of presentation.canonicalAuditSnapshot()) {
      const distance = Math.round(object.distanceMeters);
      visibleByDistance.set(distance, (visibleByDistance.get(distance) ?? 0)
        + (object.visibleLod === 'hidden' ? 0 : 1));
      opacityByDistance.set(distance, object.naturalLod.totalOpacity);
    }
    const result = {
      visibleByDistance: Object.fromEntries(visibleByDistance),
      opacityByDistance: Object.fromEntries(opacityByDistance),
      stableIds: presentation.canonicalAuditSnapshot().filter(object => object.visibleLod !== 'hidden')
        .map(object => object.identity.stableId),
      snapshot: presentation.snapshot(),
      presentation,
    };
    return result;
  };
  const [normal, reverse, parallel] = await Promise.all([
    run(candidates), run(Object.freeze([...candidates].reverse())), run(candidates),
  ]);
  assert.deepEqual(normal.visibleByDistance, reverse.visibleByDistance);
  assert.deepEqual(normal.visibleByDistance, parallel.visibleByDistance);
  assert.deepEqual(normal.opacityByDistance, reverse.opacityByDistance);
  assert.deepEqual(normal.opacityByDistance, parallel.opacityByDistance);
  assert.deepEqual(normal.stableIds, reverse.stableIds);
  assert.deepEqual(normal.stableIds, parallel.stableIds);
  assert.equal(normal.visibleByDistance[76], 64);
  assert.equal(normal.visibleByDistance[80], 64);
  assert.equal(normal.visibleByDistance[84], 64);
  assert.equal(normal.visibleByDistance[124], 64);
  assert.equal(normal.visibleByDistance[132], 64);
  assert.equal(normal.visibleByDistance[138], 64);
  assert.equal(normal.visibleByDistance[140], 16);
  assert.equal(normal.opacityByDistance[124], 1);
  assert.equal(normal.opacityByDistance[132], 1);
  assert.equal(normal.opacityByDistance[138], 1);
  assert.equal(normal.opacityByDistance[140], 1);
  assert.equal(normal.snapshot.visibleCanonicalFullTreeCount, 0);
  assert.equal(
    normal.snapshot.visibleCanonicalSilhouetteTreeCount + normal.snapshot.visibleCanonicalUltraTreeCount,
    normal.visibleByDistance[76] + normal.visibleByDistance[80] + normal.visibleByDistance[84]
      + normal.visibleByDistance[124] + normal.visibleByDistance[132]
      + normal.visibleByDistance[138] + normal.visibleByDistance[140],
  );
  assert.equal(normal.snapshot.visibleCanonicalNaturalCrossFadeCount, 192);
  assert.equal(normal.snapshot.visibleCanonicalForestHorizonInstanceCount, 144);
  assert.equal(normal.snapshot.distantTreeProxyCount, 0);
  normal.presentation.dispose();
  reverse.presentation.dispose();
  parallel.presentation.dispose();
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

test('Tree, Bush, Grass, and Rock share bounded natural LOD resources', async () => {
  const vegetation = Object.freeze([
    Object.freeze({
      candidateId: 'detail-v1:vegetation:all-kinds-tree',
      subtype: 'broadleaf-tree', variationSeed: 1, orientationSeed: 0.25,
      worldPosition: Object.freeze({ x: 88, y: 0.4, z: 8 }),
      owningChunkCoordinate: Object.freeze({ x: 5, z: 0 }),
      metadata: Object.freeze({ candidateRadiusMeters: 0.32 }),
    }),
    Object.freeze({
      candidateId: 'detail-v1:vegetation:all-kinds-formal-shrub',
      subtype: 'shrub', variationSeed: 1, orientationSeed: 0.25,
      worldPosition: Object.freeze({ x: 89, y: 0.4, z: 8 }),
      owningChunkCoordinate: Object.freeze({ x: 5, z: 0 }),
      metadata: Object.freeze({ candidateRadiusMeters: 0.2 }),
    }),
  ]);
  const rock = Object.freeze({
    candidateId: 'detail-v1:rock:all-kinds', candidateType: 'rock',
    subtype: 'medium-rock', sizeClass: 'medium', variationSeed: 0.5,
    orientationSeed: 0.25, worldPosition: Object.freeze({ x: 90, y: 0.4, z: 8 }),
    owningChunkCoordinate: Object.freeze({ x: 5, z: 0 }),
    metadata: Object.freeze({ candidateRadiusMeters: 0.22 }),
  });
  const ambient = Object.freeze([
    Object.freeze({
      stableId: 'wf1:ambient-detail:all-kinds-grass', detailType: 'grass',
      worldPosition: Object.freeze({ x: 91, y: 0.4, z: 8 }), rotationY: 0,
      variation: 1, owningChunkCoordinate: Object.freeze({ x: 5, z: 0 }),
    }),
    Object.freeze({
      stableId: 'wf1:ambient-detail:all-kinds-shrub', detailType: 'shrub',
      worldPosition: Object.freeze({ x: 92, y: 0.4, z: 8 }), rotationY: 0,
      variation: 1, owningChunkCoordinate: Object.freeze({ x: 5, z: 0 }),
    }),
  ]);
  const chunk = canonicalChunk(5, 0, []);
  chunk.vegetationCandidates = vegetation;
  chunk.rockCandidates = [rock];
  chunk.ambientDetails = ambient;
  chunk.presentationLayers.natural = { vegetation, rocks: [rock] };
  chunk.presentationLayers.ambientDetails = ambient;
  const scene = new DistantTestGroup();
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
    centerChunkX: 3, activeDataKeys: ['5,0'], renderedKeys: [], chunk,
  })), true);
  const snapshot = presentation.snapshot();
  assert.equal(snapshot.canonicalTreeRecordCount, 1);
  assert.equal(snapshot.canonicalShrubRecordCount, 2);
  assert.equal(snapshot.canonicalGrassRecordCount, 1);
  assert.equal(snapshot.canonicalRockRecordCount, 1);
  assert.equal(snapshot.visibleCanonicalTreeCount, 1);
  assert.equal(snapshot.visibleCanonicalShrubCount, 2);
  assert.equal(snapshot.visibleCanonicalGrassCount, 1);
  assert.equal(snapshot.visibleCanonicalRockCount, 1);
  const audit = presentation.canonicalAuditSnapshot();
  assert.deepEqual(new Set(audit.map(object => object.naturalLod.kind)),
    new Set(['tree', 'bush', 'grass', 'rock']));
  assert.equal(audit.every(object => (
    object.naturalLod.distanceSource === 'logical-object-position'
      && object.naturalLod.owner === object.ownerKey
  )), true);
  const naturalMeshes = scene.children[0].children[0].children.filter(mesh => (
    mesh.material?.userData?.naturalLod === true
  ));
  const rockAtmosphere = naturalMeshes.find(mesh => (
    mesh.material.userData.naturalLodKind === 'rock'
      && mesh.material.userData.naturalLodMode === 'atmospheric'
  ));
  assert.ok(rockAtmosphere);
  assert.equal(rockAtmosphere.material.userData.naturalLodSourceTinted, true,
    'Rock retains its neutral source tint instead of becoming vegetation green');
  assert.equal(naturalMeshes.every(mesh => mesh.geometry.attributes.w8NaturalAnchorXZ), true);
  presentation.dispose();
});

test('persistent Static Natural pages incrementally publish Tree, Bush, Grass, and Rock once', async () => {
  const vegetation = Object.freeze([
    Object.freeze({
      candidateId: 'detail-v1:vegetation:static-page-tree',
      subtype: 'broadleaf-tree', variationSeed: 1, orientationSeed: 0.25,
      worldPosition: Object.freeze({ x: 88, y: 0.4, z: 8 }),
      owningChunkCoordinate: Object.freeze({ x: 5, z: 0 }),
      metadata: Object.freeze({ candidateRadiusMeters: 0.32 }),
    }),
    Object.freeze({
      candidateId: 'detail-v1:vegetation:static-page-bush',
      subtype: 'shrub', variationSeed: 0.5, orientationSeed: 0.75,
      worldPosition: Object.freeze({ x: 89, y: 0.4, z: 8 }),
      owningChunkCoordinate: Object.freeze({ x: 5, z: 0 }),
      metadata: Object.freeze({ candidateRadiusMeters: 0.2 }),
    }),
  ]);
  const rock = Object.freeze({
    candidateId: 'detail-v1:rock:static-page', candidateType: 'rock',
    subtype: 'medium-rock', sizeClass: 'medium', variationSeed: 0.5,
    orientationSeed: 0.25, worldPosition: Object.freeze({ x: 90, y: 0.4, z: 8 }),
    owningChunkCoordinate: Object.freeze({ x: 5, z: 0 }),
    metadata: Object.freeze({ candidateRadiusMeters: 0.22 }),
  });
  const grass = Object.freeze({
    stableId: 'wf1:ambient-detail:static-page-grass', detailType: 'grass',
    worldPosition: Object.freeze({ x: 91, y: 0.4, z: 8 }), rotationY: 0,
    variation: 1, owningChunkCoordinate: Object.freeze({ x: 5, z: 0 }),
  });
  const chunk = canonicalChunk(5, 0, []);
  chunk.vegetationCandidates = vegetation;
  chunk.rockCandidates = [rock];
  chunk.ambientDetails = [grass];
  chunk.presentationLayers.natural = { vegetation, rocks: [rock] };
  chunk.presentationLayers.ambientDetails = [grass];
  const destroyed = new Set();
  const presentation = await createW8DistantPresentation({
    THREE: DISTANT_TEST_THREE,
    scene: new DistantTestGroup(),
    worldSeedHash: CANONICAL_WORLD_SEED_HASH,
    visualAssets: createDistantTestVisualAssets(),
    findSettlementsNear: async () => [],
    resolveTemplate: async () => null,
    getCanonicalChunkData: async () => chunk,
    incrementalStaticTreePages: true,
    isFeatureDestroyed: stableId => destroyed.has(stableId),
  });
  const input = canonicalSyncInput({
    centerChunkX: 3, activeDataKeys: ['5,0'], renderedKeys: [], chunk,
  });
  assert.equal(await presentation.sync(input), true);
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
      ownerKey: '5,0', resourceKind: 'canonical', value: chunk,
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
  assert.equal(snapshot.canonicalShrubRecordCount, 1);
  assert.equal(snapshot.canonicalGrassRecordCount, 1);
  assert.equal(snapshot.canonicalRockRecordCount, 1);
  const audit = presentation.canonicalAuditSnapshot();
  assert.deepEqual(new Set(audit.map(object => object.naturalLod.kind)),
    new Set(['tree', 'bush', 'grass', 'rock']));
  assert.equal(new Set(audit.map(object => object.identity.stableId)).size, audit.length);
  assert.equal(snapshot.staticTreeMaximumAdmissionsPerFrame <= 1, true);
  assert.equal(snapshot.staticTreeAdmissionLimitViolationCount, 0);
  const bushId = audit.find(object => object.naturalLod.kind === 'bush').identity.stableId;
  destroyed.add(bushId);
  presentation.advanceStaticNaturalFrame({
    coverageGeneration: 1,
    planRevision: 1,
    planId: 'static-natural-all-kinds',
    destructionRevision: bushId,
    playerLogicalX: input.playerLogicalX,
    playerLogicalZ: input.playerLogicalZ,
    activeDataKeys: input.activeDataKeys,
    renderedKeys: input.renderedKeys,
  });
  presentation.update(input.playerLogicalX, input.playerLogicalZ, input.renderOrigin);
  assert.equal(presentation.canonicalAuditSnapshot()
    .find(object => object.identity.stableId === bushId).visibleLod, 'destroyed');
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
      ownerKey: '5,0', resourceKind: 'canonical', value: chunk,
      readyAtMs: performance.now(), required: true, deadlineAtMs: performance.now() + 100,
    }],
  });
  presentation.update(input.playerLogicalX, input.playerLogicalZ, input.renderOrigin);
  const restored = presentation.canonicalAuditSnapshot();
  assert.notEqual(restored.find(object => object.identity.stableId === bushId).visibleLod,
    'destroyed');
  assert.equal(presentation.snapshot().staticTreeOwnerReuseCount > 0, true);
  assert.equal(presentation.snapshot().staticTreeDuplicatePageQueueCount, 0);
  assert.equal(presentation.snapshot().staticNaturalCoverageApplyCount, 1);
  assert.equal(presentation.snapshot().staticNaturalFrameAdvanceCount >= 3, true);
  presentation.dispose();
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

test('Static Natural owner pages include only kinds covered by their registered policies', async () => {
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
    retainedOwnerKeys: ['5,0', '6,0'],
    resourceKindEntries: [['5,0', 'canonical'], ['6,0', 'canonical']],
    policyResourceCoverage: [
      policyCoverage('tree', [['5,0', 'canonical'], ['6,0', 'manifest']]),
      policyCoverage('grass', [['5,0', 'manifest'], ['6,0', 'canonical']]),
      policyCoverage('bush', [['5,0', 'manifest'], ['6,0', 'manifest']]),
      policyCoverage('rock', [['5,0', 'manifest'], ['6,0', 'manifest']]),
    ],
    readyPages: [
      { ownerKey: '5,0', resourceKind: 'canonical', value: treeChunk,
        readyAtMs: performance.now(), required: true, deadlineAtMs: performance.now() + 100 },
      { ownerKey: '6,0', resourceKind: 'canonical', value: grassChunk,
        readyAtMs: performance.now(), required: true, deadlineAtMs: performance.now() + 100 },
    ],
  });
  for (let frame = 0; frame < 100
    && presentation.snapshot().staticNaturalResidentOwnerCount !== 2; frame += 1) {
    presentation.update(88, 8, { renderOriginChunkX: 0, renderOriginChunkZ: 0 });
    await new Promise(resolve => setImmediate(resolve));
  }
  const audit = presentation.canonicalAuditSnapshot();
  assert.deepEqual(audit.map(object => [object.ownerKey, object.naturalLod.kind]).sort(), [
    ['5,0', 'tree'],
    ['6,0', 'grass'],
  ]);
  const snapshot = presentation.snapshot();
  assert.equal(snapshot.staticNaturalOrphanObjectCount, 0);
  assert.equal(snapshot.staticNaturalOrphanSlotCount, 0);
  assert.equal(new Set(audit.map(object => object.identity.stableId)).size, audit.length);
  presentation.dispose();
});

test('persistent Natural owner build rolls back capacity and mid-build failures completely', async () => {
  const tree = (id, index, subtype = 'broadleaf-tree') => Object.freeze({
    candidateId: id,
    subtype,
    variationSeed: (index % 100) / 100,
    orientationSeed: ((index * 7) % 100) / 100,
    worldPosition: Object.freeze({ x: 82 + (index % 8), y: 0.4, z: 2 + index * 0.01 }),
    owningChunkCoordinate: Object.freeze({ x: 5, z: 0 }),
    metadata: Object.freeze({ candidateRadiusMeters: 0.32 }),
  });
  const chunkWithTrees = (count, hashDigit, malformed = false) => {
    const chunk = canonicalChunk(5, 0, []);
    const vegetation = Array.from({ length: count }, (_, index) => tree(
      `detail-v1:vegetation:transaction:${hashDigit}:${index}`,
      index,
      malformed && index === count - 1 ? 'unsupported-natural' : 'broadleaf-tree',
    ));
    chunk.contentHash = `sha256:${hashDigit.repeat(64)}`;
    chunk.vegetationCandidates = vegetation;
    chunk.presentationLayers.natural = { vegetation, rocks: [] };
    return chunk;
  };
  const valid = chunkWithTrees(1, '3');
  const overCapacity = chunkWithTrees(65, '4');
  const malformed = chunkWithTrees(1, '5');
  malformed.ambientDetails = [{
    stableId: 'wf1:ambient-detail:transaction-malformed',
    detailType: 'grass',
    worldPosition: null,
    rotationY: 0,
    variation: 1,
    owningChunkCoordinate: Object.freeze({ x: 5, z: 0 }),
  }];
  malformed.presentationLayers.ambientDetails = malformed.ambientDetails;
  let current = valid;
  const presentation = await createW8DistantPresentation({
    THREE: DISTANT_TEST_THREE,
    scene: new DistantTestGroup(),
    worldSeedHash: CANONICAL_WORLD_SEED_HASH,
    visualAssets: createDistantTestVisualAssets(),
    findSettlementsNear: async () => [],
    resolveTemplate: async () => null,
    getCanonicalChunkData: async () => current,
    incrementalStaticTreePages: true,
    resolveStaticNaturalCapacity: () => [{
      naturalKind: 'tree',
      maximumCanonicalOwnerCount: 1,
      maximumManifestOwnerCount: 1,
    }],
  });
  const inputFor = chunk => canonicalSyncInput({
    centerChunkX: 3,
    activeDataKeys: ['5,0'],
    renderedKeys: [],
    chunk,
    quality: 'high',
  });
  assert.equal(await presentation.sync(inputFor(valid)), true);
  const before = presentation.snapshot();
  const beforeAudit = presentation.canonicalAuditSnapshot();
  assert.equal(before.staticNaturalResidentOwnerCount, 1);
  assert.equal(before.staticNaturalOrphanObjectCount, 0);

  current = overCapacity;
  await assert.rejects(
    presentation.sync(inputFor(overCapacity)),
    /persistent Natural bucket capacity exceeded/,
  );
  let after = presentation.snapshot();
  assert.equal(after.staticNaturalResidentOwnerCount, 1);
  assert.equal(after.staticNaturalOrphanObjectCount, 0);
  assert.equal(after.staticNaturalOrphanSlotCount, 0);
  assert.deepEqual(presentation.canonicalAuditSnapshot(), beforeAudit);

  current = malformed;
  await assert.rejects(presentation.sync(inputFor(malformed)), /World Object|identity|position/);
  after = presentation.snapshot();
  assert.equal(after.staticNaturalResidentOwnerCount, 1);
  assert.equal(after.staticNaturalOrphanObjectCount, 0);
  assert.equal(after.staticNaturalOrphanSlotCount, 0);
  assert.deepEqual(presentation.canonicalAuditSnapshot(), beforeAudit);
  presentation.dispose();
});

test('manifest and canonical builds for one owner serialize without LOD identity mismatch', async () => {
  const ownerKey = '5,0';
  const vegetation = Object.freeze(Array.from({ length: 300 }, (_, index) => Object.freeze({
    candidateId: `detail-v1:vegetation:replacement-race-${String(index).padStart(3, '0')}`,
    subtype: 'broadleaf-tree',
    variationSeed: (index % 100) / 100,
    orientationSeed: ((index * 7) % 100) / 100,
    worldPosition: Object.freeze({ x: 80 + (index % 16) * 0.25, y: 0, z: index * 0.01 }),
    owningChunkCoordinate: Object.freeze({ x: 5, z: 0 }),
    metadata: Object.freeze({ candidateRadiusMeters: 0.32 }),
  })));
  const canonical = canonicalChunk(5, 0, []);
  canonical.vegetationCandidates = vegetation;
  canonical.presentationLayers.natural = { vegetation, rocks: [] };
  const manifest = {
    chunkX: 5,
    chunkZ: 0,
    chunkId: canonical.chunkId,
    contentHash: `sha256:${'3'.repeat(64)}`,
    sourceW5ContentHash: canonical.sourceW5ContentHash,
    generatorVersion: canonical.generatorVersion,
    presentationLayers: { natural: { vegetation, rocks: [] } },
  };
  const presentation = await createW8DistantPresentation({
    THREE: DISTANT_TEST_THREE,
    scene: new DistantTestGroup(),
    worldSeedHash: CANONICAL_WORLD_SEED_HASH,
    visualAssets: createDistantTestVisualAssets(),
    findSettlementsNear: async () => [],
    resolveTemplate: async () => null,
    getCanonicalChunkData: async () => canonical,
    getForestHorizonManifest: async () => manifest,
    incrementalStaticTreePages: true,
    yieldToMainThread: () => new Promise(resolve => setImmediate(resolve)),
  });
  const input = canonicalSyncInput({
    centerChunkX: 3,
    activeDataKeys: [ownerKey],
    renderedKeys: [],
    chunk: canonical,
  });
  const planInput = {
    coverageGeneration: 1,
    planRevision: 1,
    planId: 'manifest-first-replacement-race',
    destructionRevision: 'none',
    quality: input.quality,
    renderDistancePreset: 'current',
    renderOrigin: input.renderOrigin,
    playerLogicalX: input.playerLogicalX,
    playerLogicalZ: input.playerLogicalZ,
    activeDataKeys: [],
    renderedKeys: [],
    retainedOwnerKeys: [ownerKey],
    resourceKindEntries: [[ownerKey, 'manifest']],
  };
  presentation.applyStaticNaturalPlan({
    ...planInput,
    readyPages: [{
      ownerKey,
      resourceKind: 'manifest',
      value: manifest,
      readyAtMs: performance.now(),
      required: false,
      deadlineAtMs: performance.now() + 1_000,
    }],
  });
  presentation.update(input.playerLogicalX, input.playerLogicalZ, input.renderOrigin);

  assert.equal(await presentation.sync(input), true,
    'canonical seed must wait for the in-flight manifest owner build');
  for (let frame = 0; frame < 200
    && presentation.snapshot().staticTreeCurrentPublishedOwnerCount !== 1; frame += 1) {
    presentation.update(input.playerLogicalX, input.playerLogicalZ, input.renderOrigin);
    presentation.markFirstDraw();
    await new Promise(resolve => setImmediate(resolve));
  }
  const canonicalFirst = presentation.snapshot();
  const audit = presentation.canonicalAuditSnapshot();
  assert.equal(canonicalFirst.identityAuditErrorCount, 0);
  assert.equal(canonicalFirst.staticNaturalStalePageDiscardCount, 0);
  assert.equal(canonicalFirst.staticNaturalResidentOwnerCount, 1);
  assert.equal(canonicalFirst.staticNaturalOverlappingStableIdCount, 0);
  assert.equal(audit.length, vegetation.length);
  assert.equal(new Set(audit.map(value => value.identity.stableId)).size, vegetation.length);
  assert.equal(audit.every(value => (
    value.identity.canonicalSourceRevision === `${CANONICAL_WORLD_SEED_HASH}:800`
      && value.identity.sourceW5ContentHash === canonical.sourceW5ContentHash
      && !Object.hasOwn(value.identity, 'contentHash')
  )), true);

  presentation.applyStaticNaturalPlan({
    ...planInput,
    planRevision: 2,
    planId: 'canonical-first-obsolete-manifest',
    resourceKindEntries: [[ownerKey, 'canonical']],
    readyPages: [{
      ownerKey,
      resourceKind: 'manifest',
      value: manifest,
      readyAtMs: performance.now(),
      required: false,
      deadlineAtMs: performance.now() + 1_000,
    }],
  });
  presentation.update(input.playerLogicalX, input.playerLogicalZ, input.renderOrigin);
  await new Promise(resolve => setImmediate(resolve));
  const afterObsoleteManifest = presentation.snapshot();
  assert.equal(afterObsoleteManifest.identityAuditErrorCount, 0);
  assert.equal(afterObsoleteManifest.staticNaturalStalePageDiscardCount, 1);
  assert.equal(presentation.canonicalAuditSnapshot().length, vegetation.length,
    JSON.stringify({
      resident: afterObsoleteManifest.staticNaturalResidentOwnerCount,
      pending: afterObsoleteManifest.staticNaturalPendingOwnerCount,
      dispose: afterObsoleteManifest.staticNaturalDisposeOwnerCount,
      stale: afterObsoleteManifest.staticNaturalStalePageDiscardCount,
      builds: afterObsoleteManifest.staticTreeOwnerBuildCount,
      reuses: afterObsoleteManifest.staticTreeOwnerReuseCount,
    }));
  presentation.dispose();
});

test('Near handoff suppresses only the matching natural Stable ID across every tier', async () => {
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
  ]);
  const chunk = canonicalChunk(5, 0, []);
  chunk.vegetationCandidates = trees;
  chunk.presentationLayers.natural.vegetation = trees;
  let nearIds = [];
  const presentation = await createW8DistantPresentation({
    THREE: DISTANT_TEST_THREE,
    scene: new DistantTestGroup(),
    worldSeedHash: CANONICAL_WORLD_SEED_HASH,
    visualAssets: createDistantTestVisualAssets(),
    findSettlementsNear: async () => [],
    resolveTemplate: async () => null,
    getCanonicalChunkData: async () => chunk,
    getNearVisibleStableIds: () => nearIds,
  });
  const input = canonicalSyncInput({
    centerChunkX: 3, activeDataKeys: ['5,0'], renderedKeys: [], chunk,
  });
  assert.equal(await presentation.sync(input), true);
  nearIds = [trees[0].candidateId];
  assert.equal(presentation.commitRuntimeState({
    activeDataKeys: input.activeDataKeys,
    renderedKeys: input.renderedKeys,
    renderOrigin: input.renderOrigin,
    quality: 'high',
    playerLogicalX: input.playerLogicalX,
    playerLogicalZ: input.playerLogicalZ,
  }), true);
  let audit = Object.fromEntries(presentation.canonicalAuditSnapshot().map(value => (
    [value.identity.stableId, value]
  )));
  assert.equal(audit[trees[0].candidateId].visibleLod, 'near');
  assert.deepEqual([
    audit[trees[0].candidateId].naturalLod.fullInstanceCount,
    audit[trees[0].candidateId].naturalLod.forestInstanceCount,
    audit[trees[0].candidateId].naturalLod.atmosphericInstanceCount,
  ], [0, 0, 0]);
  assert.equal(audit[trees[1].candidateId].visibleLod, 'mid');
  assert.deepEqual([
    audit[trees[1].candidateId].naturalLod.fullInstanceCount,
    audit[trees[1].candidateId].naturalLod.forestInstanceCount,
    audit[trees[1].candidateId].naturalLod.atmosphericInstanceCount,
  ], [1, 1, 1]);
  assert.equal(presentation.snapshot().duplicateVisibleStableIdCount, 0);

  nearIds = [];
  presentation.commitRuntimeState({
    activeDataKeys: input.activeDataKeys,
    renderedKeys: input.renderedKeys,
    renderOrigin: input.renderOrigin,
    quality: 'high',
    playerLogicalX: input.playerLogicalX,
    playerLogicalZ: input.playerLogicalZ,
  });
  audit = Object.fromEntries(presentation.canonicalAuditSnapshot().map(value => (
    [value.identity.stableId, value]
  )));
  assert.equal(audit[trees[0].candidateId].visibleLod, 'mid');
  assert.deepEqual([
    audit[trees[0].candidateId].naturalLod.fullInstanceCount,
    audit[trees[0].candidateId].naturalLod.forestInstanceCount,
    audit[trees[0].candidateId].naturalLod.atmosphericInstanceCount,
  ], [1, 1, 1]);
  assert.equal(audit[trees[0].candidateId].ownerKey, '5,0');
  presentation.dispose();
});

test('Tree, Bush, and Rock destruction removes every tier and survives Save Continue', async () => {
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
  const presentation = await createW8DistantPresentation({
    THREE: DISTANT_TEST_THREE,
    scene: new DistantTestGroup(),
    worldSeedHash: CANONICAL_WORLD_SEED_HASH,
    visualAssets: createDistantTestVisualAssets(),
    findSettlementsNear: async () => [],
    resolveTemplate: async () => null,
    getCanonicalChunkData: async () => chunk,
    isFeatureDestroyed: stableId => activeState.isFeatureDestroyed(stableId),
  });
  const midInput = canonicalSyncInput({
    centerChunkX: 3, activeDataKeys: ['5,0'], renderedKeys: [], chunk,
  });
  assert.equal(await presentation.sync(midInput), true);
  for (const [record, type] of [[tree, 'tree'], [bush, 'tree'], [rock, 'rock']]) {
    const contract = W6_STATIC_TARGET_CONTRACTS[type];
    activeState.damageFeature(
      { stableId: record.candidateId, maxHp: contract.maxHp },
      contract.maxHp,
    );
  }
  presentation.update(8, 8, midInput.renderOrigin);
  for (const object of presentation.canonicalAuditSnapshot()) {
    assert.equal(object.visibleLod, 'destroyed');
    assert.equal(object.naturalLod.fullInstanceCount, 0);
    assert.equal(object.naturalLod.forestInstanceCount, 0);
    assert.equal(object.naturalLod.atmosphericInstanceCount, 0);
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
    assert.equal(presentation.canonicalAuditSnapshot().every(object => (
      object.visibleLod === 'destroyed'
        && activeState.isFeatureDestroyed(object.identity.stableId)
    )), true);
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
    });
    const startedAt = performance.now();
    assert.equal(await presentation.sync(canonicalSyncInput({
      centerChunkX: 3, activeDataKeys: ['5,0'], renderedKeys: [], chunk,
    })), true);
    const syncMs = performance.now() - startedAt;
    const updateStartedAt = performance.now();
    for (let frame = 0; frame < 120; frame += 1) {
      presentation.update(8 + frame % 2, 8, { renderOriginChunkX: 0, renderOriginChunkZ: 0 });
    }
    const updateMeanMs = (performance.now() - updateStartedAt) / 120;
    const snapshot = presentation.snapshot();
    const naturalMeshes = scene.children[0].children[0].children.filter(mesh => (
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
  assert.deepEqual(rows.map(row => row.instance), [24, 48, 120, 240]);
  t.diagnostic(JSON.stringify(rows));
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
    assert.ok(snapshot.queryNaturalOwnerChunkCount > 0);
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
  assert.ok(snapshot.queryNaturalOwnerChunkCount > 0);
  assert.equal(snapshot.queryOwnerChunkKeys.length, snapshot.queryOwnerChunkCount);
  assert.equal(snapshot.queryCanonicalChunkSuccessCount, snapshot.queryOwnerChunkCount);
  assert.equal(snapshot.templateCacheCapacity, 5);
  assert.equal(snapshot.templateCacheSize, 5);
  assert.equal(snapshot.farOwnerChunkCacheCapacity, 128);
  assert.equal(
    snapshot.farOwnerChunkCacheSize,
    Math.min(
      snapshot.queryOwnerChunkCount - snapshot.queryUltraOnlyOwnerChunkCount
        - snapshot.queryForestHorizonOnlyOwnerChunkCount,
      snapshot.farOwnerChunkCacheCapacity,
    ),
  );
  assert.equal(
    snapshot.forestHorizonOwnerChunkCacheSize,
    Math.min(
      snapshot.queryForestHorizonOnlyOwnerChunkCount,
      snapshot.forestHorizonOwnerChunkCacheCapacity,
    ),
  );
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
