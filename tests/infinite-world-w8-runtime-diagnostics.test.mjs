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
  W8_PRESENTATION_TERRAIN_PALETTE,
  createW8DistantPresentation,
  createW8ClipmapTopology,
  isW8DistantNaturalProxyInRange,
  isW8NaturalCandidateVisible,
  resolveW8NaturalCandidateVisual,
  sampleW8DistantTerrainAt,
  w8TerrainColorFromWeights,
} from '../src/infinite-world/render/w8-distant-presentation.js';
import { W6_STATIC_TARGET_CONTRACTS } from '../src/infinite-world/gameplay-contract.js';
import {
  InfiniteWorldState,
  decodeInfiniteWorldSave,
  encodeInfiniteWorldSave,
} from '../src/infinite-world/world-state-store.js';

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
class DistantTestInstancedMesh extends DistantTestMesh {
  constructor(geometry, material, capacity) {
    super(geometry, material);
    this.capacity = capacity;
    this.count = 0;
    this.matrices = [];
    this.instanceMatrix = {};
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
      tree: [],
      broadleafTree: [],
      wetlandTree: [],
      shrub: [SHRUB_PART],
      rock: [],
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
} = {}) {
  return {
    activeDataKeys,
    renderedKeys,
    getChunkData: (chunkX, chunkZ) =>
      chunkX === chunk.chunkX && chunkZ === chunk.chunkZ ? chunk : null,
    renderOrigin: { renderOriginChunkX: centerChunkX, renderOriginChunkZ: 0 },
    centerChunkX,
    centerChunkZ: 0,
    quality: 'medium',
    playerLogicalX,
    playerLogicalZ: 8,
  };
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

test('natural-object LOD selection is stable and anchored proxies persist into the near field', () => {
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
  assert.equal(isW8NaturalCandidateVisible({ ...candidate, variationSeed: 0 }), false);
  assert.equal(isW8NaturalCandidateVisible({ ...candidate, variationSeed: 1 }), true);

  assert.equal(isW8DistantNaturalProxyInRange(0), true);
  assert.equal(isW8DistantNaturalProxyInRange(24), true);
  assert.equal(isW8DistantNaturalProxyInRange(40), true);
  assert.equal(isW8DistantNaturalProxyInRange(339.999), true);
  assert.equal(isW8DistantNaturalProxyInRange(340), false);
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
    child.name === 'w8-midground-major-natural-box-bush'
  ));
  assert.ok(shrubMesh);
  assert.equal(shrubMesh.count, 1);
  assert.deepEqual(shrubMesh.matrices[0].value.scale, {
    x: visual.widthMeters * 256,
    y: visual.heightMeters * 256,
    z: visual.depthMeters * 256,
  });
  assert.equal(generationRoot.children.some(child => (
    child.name.includes('major-natural') && child.name.includes('treeLeaves')
  )), false);
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

test('canonical settlement identity hands off exclusively and destruction survives distance and save/load', async () => {
  const scene = new DistantTestGroup();
  let activeState = new InfiniteWorldState({
    worldSeed: 'gate-a-canonical',
    worldSeedHash: CANONICAL_WORLD_SEED_HASH,
    playerSpawn: { x: 8, z: 8 },
  });
  let holdNextQuery = false;
  let releaseHeldQuery = null;
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
    assert.equal(await presentation.sync(state.input), true);
    const [object] = presentation.canonicalAuditSnapshot();
    assert.deepEqual(object.identity, expectedIdentity);
    assert.equal(object.visibleLod, state.lod);
    assert.equal(object.instanceCount, 1);
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
    assert.equal(snapshot.canonicalMeshCount, 1);
    assert.equal(snapshot.canonicalVisibleMeshCount, 1);
    assert.equal(snapshot.queryCandidateCount, 1);
    assert.equal(snapshot.queryTemplateSuccessCount, 1);
    assert.equal(snapshot.queryOwnerChunkCount, 1);
    assert.deepEqual(snapshot.queryOwnerChunkKeys, ['5,0']);
    assert.equal(snapshot.queryCanonicalChunkSuccessCount, 1);
    assert.equal(snapshot.querySettlementFeatureCount, 1);
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
  assert.equal(presentation.snapshot().visibilityMeters, W8_CANONICAL_VISIBILITY_METERS.medium);

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
      chunk: canonicalChunk(5, 0, [conflictingBuilding]),
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
    worldPosition: ownerPoints[index * 10],
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
        center: candidate.worldPosition,
        buildings: ownerPoints.slice(index * 10, index * 10 + 10),
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
    quality: 'medium',
    playerLogicalX: 8,
    playerLogicalZ: 8,
  }), true);
  const snapshot = presentation.snapshot();
  assert.equal(snapshot.queryCandidateCount, 8);
  assert.equal(snapshot.queryTemplateSuccessCount, 8);
  assert.equal(snapshot.queryOwnerChunkCount, 80);
  assert.equal(snapshot.queryOwnerChunkKeys.length, 80);
  assert.equal(snapshot.queryCanonicalChunkSuccessCount, 80);
  assert.equal(snapshot.templateCacheCapacity, 4);
  assert.equal(snapshot.templateCacheSize, 4);
  assert.equal(snapshot.farOwnerChunkCacheCapacity, 64);
  assert.equal(snapshot.farOwnerChunkCacheSize, 64);
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
