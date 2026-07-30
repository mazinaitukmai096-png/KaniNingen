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
  sampleW8DistantTerrainAt,
  w8TerrainColorFromWeights,
} from '../src/infinite-world/render/w8-distant-presentation.js';
import { W6_STATIC_TARGET_CONTRACTS } from '../src/infinite-world/gameplay-contract.js';
import { RENDER_CHUNK_SIZE } from '../src/infinite-world/chunk-coordinates.js';
import { createCanonicalRiverProjection } from '../src/infinite-world/canonical-river-realization.js';
import {
  W8_FINITE_SETTLEMENT_VIEW_CONTRACT,
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

const LEGACY_CHUNK_SIZE_METERS = 16;
const LEGACY_FIVE_BY_FIVE_HALF_EXTENT_METERS = LEGACY_CHUNK_SIZE_METERS * 2.5;
const CANONICAL_WORLD_SEED_HASH = `sha256:${'0'.repeat(64)}`;

class DistantTestVector {
  constructor() { this.set(0, 0, 0); }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
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
class DistantTestMaterial {
  constructor(options = {}) { Object.assign(this, options); }
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
  const material = () => new DistantTestMaterial();
  return {
    geometries: { box: geometry, sphere: geometry, cone: geometry },
    materials: {
      houseWall: material(), road: material(), lotResidential: material(), lotCivic: material(),
      water: material(), bush: material(), treeTrunk: material(), treeLeaves: material(),
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
    child.name === 'w8-canonical-lod-natural-box-bush'
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
    assert.equal(object.instanceCount, 1);
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

test('high-quality Tree full, silhouette, and Ultra tiers remain canonical, exclusive, and deterministic', async () => {
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
    candidate('detail-v1:vegetation:hidden-tree', 'broadleaf-tree', 153),
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
      worldSeedHash: CANONICAL_WORLD_SEED_HASH,
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
      instances: value.instanceCount,
      occurrences: result.occurrences[value.identity.stableId],
    },
  ]));
  assert.deepEqual(auditById(normal), auditById(reverse));
  assert.deepEqual(auditById(normal), auditById(parallel));
  assert.deepEqual(normal.occurrences, {
    'detail-v1:vegetation:full-broadleaf': 3,
    'detail-v1:vegetation:silhouette-broadleaf': 1,
    'detail-v1:vegetation:silhouette-wetland': 1,
    'detail-v1:vegetation:silhouette-conifer': 1,
    'detail-v1:vegetation:ultra-tree': 1,
    'detail-v1:vegetation:hidden-tree': 0,
  });
  assert.equal(normal.snapshot.visibleCanonicalTreeCount, 5);
  assert.equal(normal.snapshot.visibleCanonicalFullTreeCount, 1);
  assert.equal(normal.snapshot.visibleCanonicalSilhouetteTreeCount, 3);
  assert.equal(normal.snapshot.visibleCanonicalUltraTreeCount, 1);
  assert.equal(normal.snapshot.visibleCanonicalTreePartInstanceCount, 7);
  assert.equal(normal.snapshot.distantTreeProxyCount, 0);
  const broadleafSilhouette = candidates[1];
  const broadleafAudit = normal.audit.find(value => (
    value.identity.stableId === broadleafSilhouette.candidateId
  ));
  assert.equal(broadleafAudit.visibleLod, 'mid');
  assert.deepEqual(broadleafAudit.identity.worldPosition, broadleafSilhouette.worldPosition);
  assert.deepEqual(broadleafAudit.identity.owningChunkCoordinate, { x: 5, z: 0 });
  assert.equal(broadleafAudit.identity.rotationY, Math.PI / 2);
  const broadleafMesh = normal.meshes.find(mesh => (
    mesh.name === 'w8-canonical-lod-natural-silhouette-sphere-treeLeaves'
  ));
  assert.ok(broadleafMesh);
  const broadleafMatrix = broadleafMesh.matrices[broadleafMesh.userData.canonicalStableIds.indexOf(
    broadleafSilhouette.candidateId,
  )].value;
  const visual = resolveW8NaturalCandidateVisual(broadleafSilhouette);
  const fullScale = {
    x: visual.widthMeters * 256 * 0.82,
    y: visual.heightMeters * 256 * 0.72,
    z: visual.depthMeters * 256 * 0.82,
  };
  const canonicalBroadleafMatrix = {
    position: {
      x: broadleafSilhouette.worldPosition.x * 256,
      y: broadleafSilhouette.worldPosition.y * 256 + visual.heightMeters * 256 * 0.64,
      z: broadleafSilhouette.worldPosition.z * 256,
    },
    rotation: { x: 0, y: Math.PI / 2, z: 0 },
    scale: fullScale,
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
  const wetlandMesh = normal.meshes.find(mesh => (
    mesh.name === 'w8-canonical-lod-natural-silhouette-sphere-wetlandLeaves'
  ));
  const coniferMesh = normal.meshes.find(mesh => (
    mesh.name === 'w8-canonical-lod-natural-silhouette-cone-treeLeaves'
  ));
  assert.ok(wetlandMesh);
  assert.ok(coniferMesh);
  assert.deepEqual(
    matrixFor(wetlandMesh, candidates[2].candidateId),
    canonicalTreeMatrix(candidates[2], SILHOUETTE_WETLAND_PRIMARY_PART),
  );
  assert.deepEqual(
    matrixFor(coniferMesh, candidates[3].candidateId),
    canonicalTreeMatrix(candidates[3], SILHOUETTE_CONIFER_PART),
  );
  assert.equal(broadleafMesh.material.flatShading, undefined);
  assert.equal(broadleafMesh.material.shininess, undefined);
  const ultraMesh = normal.meshes.find(mesh => (
    mesh.name === 'w8-canonical-lod-natural-ultra-sphere-treeLeaves'
  ));
  assert.ok(ultraMesh);
  assert.equal(ultraMesh.material, broadleafMesh.material);
  const ultraTree = candidates[4];
  const ultraMatrix = ultraMesh.matrices[ultraMesh.userData.canonicalStableIds.indexOf(
    ultraTree.candidateId,
  )].value;
  const ultraVisual = resolveW8NaturalCandidateVisual(ultraTree);
  assert.deepEqual(ultraMatrix, {
    position: {
      x: ultraTree.worldPosition.x * 256,
      y: ultraTree.worldPosition.y * 256 + ultraVisual.heightMeters * 256 * 0.64,
      z: ultraTree.worldPosition.z * 256,
    },
    rotation: { x: 0, y: Math.PI / 2, z: 0 },
    scale: {
      x: ultraVisual.widthMeters * 256 * 0.82,
      y: ultraVisual.heightMeters * 256 * 0.72,
      z: ultraVisual.depthMeters * 256 * 0.82,
    },
  });
  normal.presentation.update(32, 8, { renderOriginChunkX: 0, renderOriginChunkZ: 0 });
  assert.equal(normal.presentation.canonicalAuditSnapshot().find(value => (
    value.identity.stableId === broadleafSilhouette.candidateId
  )).presentationTier, 'full');
  const fullMatrix = broadleafMesh.matrices[broadleafMesh.userData.canonicalStableIds.indexOf(
    broadleafSilhouette.candidateId,
  )].value;
  normal.presentation.update(-12, 8, { renderOriginChunkX: 0, renderOriginChunkZ: 0 });
  assert.equal(normal.presentation.canonicalAuditSnapshot().find(value => (
    value.identity.stableId === broadleafSilhouette.candidateId
  )).presentationTier, 'ultra');
  const switchedUltraMatrix = ultraMesh.matrices[ultraMesh.userData.canonicalStableIds.indexOf(
    broadleafSilhouette.candidateId,
  )].value;
  assert.deepEqual(fullMatrix, canonicalBroadleafMatrix);
  assert.deepEqual(switchedUltraMatrix, canonicalBroadleafMatrix);
  /* Full, silhouette, and Ultra share the authored canonical transform; LOD only reduces parts. */
  assert.deepEqual(broadleafAudit.identity.worldPosition, broadleafSilhouette.worldPosition);
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

test('canonical LOD only rewrites dirty buckets', async () => {
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
  assert.ok(changed.canonicalComposeCount > reused.canonicalComposeCount);
  assert.ok(changed.canonicalDirtyBucketCount - reused.canonicalDirtyBucketCount < changed.canonicalMeshCount);
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
      requestMetadata.push(metadata);
      ownerCalls += 1;
      if (ownerCalls === 1) {
        signalFirstOwner();
        await firstOwner;
      }
      return canonicalChunk(chunkX, chunkZ, []);
    },
    cancelCanonicalChunkRequests: options => cancelledConsumers.push(options),
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
  releaseFirstOwner();
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

test('High current-Settlement horizon uses canonical Building and Landmark records exclusively', async () => {
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
  assert.equal(templateCalls, 1);
  assert.equal(audit[horizonBuilding.stableId].presentationTier, 'horizon');
  assert.equal(audit[horizonLandmark.stableId].presentationTier, 'horizon');
  assert.equal(audit[horizonBuilding.stableId].ownerKey, '5,0');
  assert.equal(audit[horizonLandmark.stableId].ownerKey, '5,0');
  assert.deepEqual(audit[horizonBuilding.stableId].identity.worldPosition, horizonBuilding.worldPosition);
  assert.deepEqual(audit[horizonLandmark.stableId].identity.worldPosition, horizonLandmark.worldPosition);
  assert.equal(audit[horizonBuilding.stableId].identity.rotationY, horizonBuilding.rotationY);
  assert.equal(audit[horizonLandmark.stableId].identity.landmarkType, 'house');
  const snapshot = presentation.snapshot();
  assert.equal(snapshot.currentSettlementId, CANONICAL_SETTLEMENT_ID);
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
  assert.equal(resolveW8SettlementPresentationPolicy('high', 'standard').remote.hiddenDistanceMeters, 656.25);
  assert.equal(resolveW8SettlementPresentationPolicy('high', 'short').remote.hiddenDistanceMeters, 352);
  assert.equal(resolveW8SettlementPresentationPolicy('high').remote.fog, false);
  assert.equal(high.current.candidate.settlementId, 'settlement-v1:current');
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
  const limits = ['CITY', 'TOWN', 'RURAL'].map(settlementType => (
    resolveRemoteHorizonBuildingLimit({ settlementType, buildingCount: 100, quality: 'high' })
  ));
  assert.deepEqual(limits, [100, 100, 100]);
});

test('remote Settlement Horizon preserves every canonical Building Stable ID and yields per Building to Near ownership', async () => {
  const settlementId = 'settlement-v1:remote-horizon';
  const centerX = 401;
  const candidate = Object.freeze({
    settlementId,
    settlementType: 'RURAL',
    townType: 'suburb',
    center: Object.freeze({ x: centerX, z: 8 }),
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
  assert.equal(snapshot.currentSettlementId, null);
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
  const baselineIdentityById = new Map(presentation.canonicalAuditSnapshot()
    .filter(object => buildings.some(building => building.stableId === object.identity.stableId))
    .map(object => [object.identity.stableId, object.identity]));
  assert.equal(new Set([...baselineIdentityById.values()].map(identity => (
    `${identity.owningChunkCoordinate.x},${identity.owningChunkCoordinate.z}`
  ))).size > 1, true);
  let previousVisibleIds = null;
  for (const distanceMeters of [850, 750, 500, 300, 200, 150, 100, 50]) {
    presentation.update(centerX - distanceMeters, 8, {
      renderOriginChunkX: 0,
      renderOriginChunkZ: 0,
    });
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

test('Tree LOD diagnostics are opt-in and mirror canonical full and silhouette tiers', async () => {
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
  assert.equal(overlays.filter(child => child.userData.treeLodTier === 'silhouette')
    .reduce((sum, child) => sum + child.count, 0), before.visibleCanonicalSilhouetteTreeCount);
  assert.equal(overlays.filter(child => child.userData.treeLodTier === 'ultra')
    .reduce((sum, child) => sum + child.count, 0), before.visibleCanonicalUltraTreeCount);
  assert.equal(overlays.every(child => child.material.depthTest === false
    && child.material.depthWrite === false && child.renderOrder >= 10_000), true);
  const ring = diagnostic.children.find(child => child.name === 'w8-tree-lod-debug-84m-ring');
  assert.ok(ring);
  assert.equal(ring.material.depthTest, false);
  assert.equal(ring.renderOrder, 10_002);
  assert.equal(presentation.setTreeLodDiagnosticsEnabled(false), false);
  assert.equal(generationRoot.children.some(child => child.name === 'w8-tree-lod-diagnostics'), false);
  assert.deepEqual(presentation.snapshot().visibleCanonicalTreeCount, before.visibleCanonicalTreeCount);
  assert.equal(presentation.snapshot().distantTreeProxyCount, 0);
  presentation.dispose();
});

test('High circular natural-owner query covers the 140m Ultra Tree circle without duplicate active or inner owners', async () => {
  const chunkSize = 16;
  const queryRadius = 140;
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
      getCanonicalChunkData: async (chunkX, chunkZ) => getChunk(chunkX, chunkZ),
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
    const expected = [];
    const innerCircle = [];
    const ultraCircle = [];
    for (let chunkZ = Math.floor((playerLogicalZ - queryRadius) / chunkSize);
      chunkZ <= Math.floor((playerLogicalZ + queryRadius) / chunkSize); chunkZ += 1) {
      for (let chunkX = Math.floor((playerLogicalX - queryRadius) / chunkSize);
        chunkX <= Math.floor((playerLogicalX + queryRadius) / chunkSize); chunkX += 1) {
        const key = `${chunkX},${chunkZ}`;
        if (intersects(chunkX, chunkZ, playerLogicalX, playerLogicalZ, queryRadius)
          && !activeKeys.has(key)) expected.push(key);
        if (intersects(chunkX, chunkZ, playerLogicalX, playerLogicalZ, innerRadius)) innerCircle.push(key);
        else if (intersects(chunkX, chunkZ, playerLogicalX, playerLogicalZ, queryRadius)) ultraCircle.push(key);
      }
    }
    expected.sort();
    assert.deepEqual([...first.queryNaturalOwnerChunkKeys].sort(), expected);
    assert.equal(first.queryNaturalOwnerChunkCount, expected.length);
    assert.equal(first.queryExcludedActiveNaturalOwnerCount, 25);
    assert.equal(first.queryInnerNaturalOwnerChunkCount, innerCircle.filter(key => !activeKeys.has(key)).length);
    assert.equal(first.queryUltraOwnerChunkCount, ultraCircle.filter(key => !activeKeys.has(key)).length);
    assert.equal(first.queryFarOwnerChunkCacheMisses, first.queryInnerNaturalOwnerChunkCount);
    assert.equal(first.queryUltraOwnerChunkCacheMisses, first.queryUltraOwnerChunkCount);
    assert.equal(first.queryFarOwnerChunkCacheEvictions, 0);
    assert.equal(first.queryUltraOwnerChunkCacheEvictions, 0);
    assert.equal(second.queryFarOwnerChunkCacheHits, second.queryInnerNaturalOwnerChunkCount);
    assert.equal(second.queryFarOwnerChunkCacheMisses, 0);
    assert.equal(second.queryUltraOwnerChunkCacheHits, second.queryUltraOwnerChunkCount);
    assert.equal(second.queryUltraOwnerChunkCacheMisses, 0);
    assert.equal(second.queryFarOwnerChunkCacheEvictions, 0);
    assert.equal(second.queryUltraOwnerChunkCacheEvictions, 0);
    assert.ok(transition.queryFarOwnerChunkCacheMisses > 0);
    assert.ok(transition.queryUltraOwnerChunkCacheMisses > 0);
    assert.equal(transition.queryFarOwnerChunkCacheEvictions, 0);
    assert.ok(transition.queryPreparationDurationMs >= 0);
    assert.ok(second.innerWarmDurationMs >= 0);
    assert.ok(second.ultraWarmDurationMs >= 0);
    assert.equal(second.queryConcurrencyLimit, 4);
    assert.ok(second.maximumObservedQueryConcurrency <= 4);
    assert.equal(second.ultraOwnerChunkCacheCapacity, 256);
    for (const key of [...innerCircle, ...ultraCircle]) {
      assert.equal(activeKeys.has(key) || first.queryNaturalOwnerChunkKeys.includes(key), true);
    }
    for (const key of first.queryNaturalOwnerChunkKeys) {
      const [chunkX, chunkZ] = key.split(',').map(Number);
      assert.equal(activeKeys.has(key), false);
      assert.equal(intersects(chunkX, chunkZ, playerLogicalX, playerLogicalZ, queryRadius), true);
    }
    presentation.dispose();
  };
  await run(8, 8);
  await run(15.75, 8);
  await run(15.75, 15.75);
});

test('High Tree silhouette-to-Ultra handoff and 124m to 140m Ultra fade are deterministic', async () => {
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
    for (const object of presentation.canonicalAuditSnapshot()) {
      const distance = Math.round(object.distanceMeters);
      visibleByDistance.set(distance, (visibleByDistance.get(distance) ?? 0)
        + (object.visibleLod === 'hidden' ? 0 : 1));
    }
    const result = {
      visibleByDistance: Object.fromEntries(visibleByDistance),
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
  assert.deepEqual(normal.stableIds, reverse.stableIds);
  assert.deepEqual(normal.stableIds, parallel.stableIds);
  assert.equal(normal.visibleByDistance[76], 64);
  assert.equal(normal.visibleByDistance[80], 64);
  assert.equal(normal.visibleByDistance[84], 64);
  assert.equal(normal.visibleByDistance[124], 64);
  assert.ok(normal.visibleByDistance[124] > normal.visibleByDistance[132]);
  assert.ok(normal.visibleByDistance[132] > normal.visibleByDistance[138]);
  assert.ok(normal.visibleByDistance[138] > 0);
  assert.equal(normal.visibleByDistance[140], 0);
  assert.equal(normal.snapshot.visibleCanonicalFullTreeCount, 0);
  assert.equal(
    normal.snapshot.visibleCanonicalSilhouetteTreeCount + normal.snapshot.visibleCanonicalUltraTreeCount,
    normal.visibleByDistance[76] + normal.visibleByDistance[80] + normal.visibleByDistance[84]
      + normal.visibleByDistance[124] + normal.visibleByDistance[132] + normal.visibleByDistance[138],
  );
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
    contentHash: `sha256:${'1'.repeat(64)}`,
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
      snapshot.queryOwnerChunkCount - snapshot.queryUltraOwnerChunkCount,
      snapshot.farOwnerChunkCacheCapacity,
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
