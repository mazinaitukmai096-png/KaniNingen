import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MACRO_COARSE_PRESENTATION_CONSTANTS,
  createMacroCoarseWorldPresentation,
} from '../src/infinite-world/render/macro-coarse-world-presentation.js';

class FakeVector3 {
  constructor() {
    this.x = 0;
    this.y = 0;
    this.z = 0;
  }

  set(x, y, z) {
    this.x = x;
    this.y = y;
    this.z = z;
  }
}

class FakeNode {
  constructor() {
    this.children = [];
    this.parent = null;
    this.position = new FakeVector3();
    this.userData = {};
    this.visible = true;
    this.removeCount = 0;
  }

  add(child) {
    if (child.parent) child.parent.remove(child);
    child.parent = this;
    this.children.push(child);
  }

  remove(child) {
    const index = this.children.indexOf(child);
    if (index < 0) return;
    this.children.splice(index, 1);
    child.parent = null;
    this.removeCount += 1;
  }

  clear() {
    for (const child of [...this.children]) this.remove(child);
  }
}

class FakeGroup extends FakeNode {}

class FakeBufferAttribute {
  constructor(array, itemSize) {
    this.array = array;
    this.itemSize = itemSize;
    this.count = array.length / itemSize;
    this.needsUpdate = false;
    this.updateRanges = [];
  }

  clearUpdateRanges() {
    this.updateRanges.length = 0;
  }

  addUpdateRange(start, count) {
    this.updateRanges.push({ start, count });
  }
}

class FakeFloat32BufferAttribute extends FakeBufferAttribute {}
class FakeUint32BufferAttribute extends FakeBufferAttribute {}

class FakeBufferGeometry {
  constructor() {
    this.attributes = {};
    this.index = null;
    this.drawRange = { start: 0, count: Infinity };
    this.userData = {};
    this.boundingBox = null;
    this.boundingSphere = null;
    this.disposeCount = 0;
  }

  setAttribute(name, attribute) {
    this.attributes[name] = attribute;
    return this;
  }

  setIndex(attribute) {
    this.index = attribute;
    return this;
  }

  setDrawRange(start, count) {
    this.drawRange = { start, count };
  }

  dispose() {
    this.disposeCount += 1;
  }
}

class FakeMaterial {
  constructor(sourceName = 'canonical-terrain') {
    this.sourceName = sourceName;
    this.userData = {};
    this.onBeforeCompile = null;
    this.disposeCount = 0;
  }

  clone() {
    const clone = new FakeMaterial(this.sourceName);
    clone.userData = { ...this.userData };
    return clone;
  }

  customProgramCacheKey() {
    return `fake:${this.sourceName}`;
  }

  dispose() {
    this.disposeCount += 1;
  }
}

class FakeMesh extends FakeNode {
  constructor(geometry, material) {
    super();
    this.geometry = geometry;
    this.material = material;
    this.frustumCulled = true;
    this.castShadow = true;
    this.receiveShadow = true;
    this.disposeCount = 0;
  }

  dispose() {
    this.disposeCount += 1;
  }
}

const FakeThree = Object.freeze({
  Group: FakeGroup,
  Mesh: FakeMesh,
  BufferGeometry: FakeBufferGeometry,
  Float32BufferAttribute: FakeFloat32BufferAttribute,
  Uint32BufferAttribute: FakeUint32BufferAttribute,
});

function makeCell(macroX, macroZ, heightOffset = 0) {
  const minimumX = macroX * 64;
  const minimumZ = macroZ * 64;
  const terrainSamples = [];
  for (let z = 0; z < 5; z += 1) {
    for (let x = 0; x < 5; x += 1) {
      const worldX = minimumX + x * 16;
      const worldZ = minimumZ + z * 16;
      terrainSamples.push(Object.freeze({
        worldX,
        worldZ,
        heightMeters: heightOffset + x * 2 - z * 3,
        color: Object.freeze([0.1 + x * 0.1, 0.2 + z * 0.05, 0.3 + (x + z) * 0.025]),
      }));
    }
  }
  return Object.freeze({
    schemaVersion: 'macro-coarse-terrain-cell-1',
    key: `${macroX},${macroZ}`,
    macroX,
    macroZ,
    terrainSamples: Object.freeze(terrainSamples),
  });
}

function createHarness({
  maximumCells = 3,
  unitsPerMeter = 2,
  logicalChunkSizeMeters = 16,
  anchorWorldX = -96,
  anchorWorldZ = 224,
} = {}) {
  const parent = new FakeGroup();
  const terrainSourceMaterial = new FakeMaterial();
  const presentation = createMacroCoarseWorldPresentation({
    THREE: FakeThree,
    parent,
    terrainSourceMaterial,
    maximumCells,
    unitsPerMeter,
    logicalChunkSizeMeters,
    anchorWorldX,
    anchorWorldZ,
  });
  return { parent, presentation, terrainSourceMaterial };
}

function float32(values) {
  return Array.from(new Float32Array(values));
}

function expectedCellArrays(cell, anchorX, anchorZ, unitsPerMeter) {
  const positions = [];
  const colors = [];
  for (const sample of cell.terrainSamples) {
    positions.push(
      (sample.worldX - anchorX) * unitsPerMeter,
      sample.heightMeters * unitsPerMeter,
      (sample.worldZ - anchorZ) * unitsPerMeter,
    );
    colors.push(...sample.color);
  }
  return { positions: float32(positions), colors: float32(colors) };
}

function assertRanges(attribute, expected) {
  assert.deepEqual(attribute.updateRanges, expected);
}

function compile(material) {
  const shader = {
    uniforms: {},
    vertexShader: 'void main() {\n#include <begin_vertex>\n}',
    fragmentShader: 'void main() {\n#include <color_fragment>\n}',
  };
  material.onBeforeCompile(shader);
  return shader;
}

test('Terrain-only presentation uses fixed dense buffers and exact negative-coordinate 5x5 data', () => {
  assert.deepEqual(MACRO_COARSE_PRESENTATION_CONSTANTS, {
    terrainSamplesPerAxis: 5,
    terrainVerticesPerCell: 25,
    terrainTrianglesPerCell: 32,
  });
  const { presentation } = createHarness();
  const { root, terrainMesh } = presentation;
  const positionAttribute = terrainMesh.geometry.attributes.position;
  const colorAttribute = terrainMesh.geometry.attributes.color;
  const indexAttribute = terrainMesh.geometry.index;
  const fixedArrays = {
    positions: positionAttribute.array,
    colors: colorAttribute.array,
    indices: indexAttribute.array,
  };

  assert.deepEqual(root.children, [terrainMesh]);
  assert.equal(root.userData.presentationContent, 'terrain-only');
  assert.equal(terrainMesh.geometry.index instanceof FakeUint32BufferAttribute, true);
  assert.equal(positionAttribute.array.length, 3 * 25 * 3);
  assert.equal(colorAttribute.array.length, 3 * 25 * 3);
  assert.equal(indexAttribute.array.length, 3 * 96);
  assert.deepEqual(Array.from(indexAttribute.array.subarray(0, 6)), [0, 5, 1, 1, 5, 6]);
  assert.deepEqual(Array.from(indexAttribute.array.subarray(96, 102)), [25, 30, 26, 26, 30, 31]);
  assert.equal(Object.hasOwn(presentation, 'forestMesh'), false);
  assert.equal(Object.hasOwn(presentation, 'setForestDetailReady'), false);
  assert.equal(Object.hasOwn(presentation, 'updateForestDetailReadiness'), false);

  const first = makeCell(-2, 3, -4);
  const second = makeCell(-1, 3, 10);
  const third = makeCell(-2, 4, 20);
  assert.equal(presentation.publishCell(first), true);
  assert.equal(presentation.publishCell(second), true);
  assert.equal(presentation.publishCell(third), true);
  presentation.update({
    playerWorldX: -96,
    playerWorldZ: 224,
    renderOrigin: { renderOriginChunkX: 0, renderOriginChunkZ: 0 },
  });

  const expectedFirst = expectedCellArrays(first, -96, 224, 2);
  assert.deepEqual(Array.from(positionAttribute.array.subarray(0, 75)), expectedFirst.positions);
  assert.deepEqual(Array.from(colorAttribute.array.subarray(0, 75)), expectedFirst.colors);
  assert.equal(terrainMesh.geometry.drawRange.count, 3 * 96);
  assert.deepEqual(presentation.snapshot(), {
    enabled: true,
    presentationContent: 'terrain-only',
    terrainIntegration: 'independent-macro-mesh-with-exclusive-detail-mask',
    terrainOverlapCount: 0,
    terrainCellCount: 3,
    terrainCellCapacity: 3,
    terrainTriangleCount: 96,
    terrainDrawCallEquivalent: 1,
    terrainCellPublicationCount: 3,
    compactionMoveCount: 0,
    maximumTerrainCells: 3,
    bufferUpdateRangeCount: 2,
    bufferUploadBytes: 1_800,
    reanchorCount: 0,
    anchorWorldX: -96,
    anchorWorldZ: 224,
  });
  assert.deepEqual(
    Object.keys(presentation.snapshot()).filter(key => /forest|cluster|stable.?id/i.test(key)),
    [],
  );

  const expectedThird = expectedCellArrays(third, -96, 224, 2);
  assert.equal(presentation.retireCell(second.key), true);
  assert.equal(terrainMesh.geometry.drawRange.count, 2 * 96);
  assert.deepEqual(Array.from(positionAttribute.array.subarray(75, 150)), expectedThird.positions,
    'retirement densely compacts the last Terrain cell');
  assert.deepEqual(Array.from(colorAttribute.array.subarray(75, 150)), expectedThird.colors);
  presentation.flushUpdates();
  assertRanges(positionAttribute, [{ start: 75, count: 75 }]);
  assertRanges(colorAttribute, [{ start: 75, count: 75 }]);
  assert.equal(presentation.snapshot().compactionMoveCount, 1);
  assert.equal(presentation.snapshot().bufferUploadBytes, 2_400);

  assert.equal(presentation.publishCell(makeCell(-1, 4, 30)), true);
  assert.throws(() => presentation.publishCell(makeCell(0, 4, 40)), /capacity exceeded/);
  assert.strictEqual(positionAttribute.array, fixedArrays.positions);
  assert.strictEqual(colorAttribute.array, fixedArrays.colors);
  assert.strictEqual(indexAttribute.array, fixedArrays.indices);
  assert.deepEqual(root.children, [terrainMesh], 'publication never creates per-cell drawables');
});

test('Terrain material retains the exclusive 352m detail mask and has no fake Forest shader', () => {
  const { presentation } = createHarness({ maximumCells: 1 });
  const { terrainMesh } = presentation;
  const shader = compile(terrainMesh.material);
  const uniforms = terrainMesh.material.userData.macroCoarseTerrainUniforms;

  assert.match(shader.vertexShader, /vW8MacroTerrainXZ = position\.xz \/ w8MacroTerrainUnitsPerMeter/);
  assert.match(shader.fragmentShader,
    /length\(vW8MacroTerrainXZ - w8MacroTerrainPlayerXZ\) > w8MacroTerrainVisibleRadius/);
  assert.match(shader.fragmentShader,
    /w8MacroTerrainDetailReady > 0\.5.*w8MacroTerrainDetailExtent/);
  assert.doesNotMatch(`${shader.vertexShader}\n${shader.fragmentShader}`,
    /Forest|w8MacroDetailReady|w8MacroFadeIn|w8MacroFadeOut/);
  assert.equal(shader.uniforms.w8MacroTerrainVisibleRadius.value, 352);
  assert.equal(shader.uniforms.w8MacroTerrainDetailReady.value, 0);
  assert.equal(terrainMesh.userData.overlapPolicy, 'exclusive-detail-mask');
  assert.equal(terrainMesh.material.userData.overlapPolicy,
    'fragment-exclusive-mask-against-published-logical-terrain');
  assert.match(terrainMesh.material.customProgramCacheKey(), /exclusive-mask-v1$/);

  presentation.update({
    playerWorldX: -64,
    playerWorldZ: 256,
    renderOrigin: { renderOriginChunkX: -4, renderOriginChunkZ: 7 },
    detailTerrainReady: true,
    detailTerrainCenterWorldX: -80,
    detailTerrainCenterWorldZ: 240,
    detailTerrainExtentMeters: 180,
  });
  assert.deepEqual(uniforms.w8MacroTerrainPlayerXZ.value, { x: 32, y: 32 });
  assert.deepEqual(uniforms.w8MacroTerrainDetailCenterXZ.value, { x: 16, y: 16 });
  assert.equal(uniforms.w8MacroTerrainUnitsPerMeter.value, 2);
  assert.equal(uniforms.w8MacroTerrainDetailExtent.value, 180);
  assert.equal(uniforms.w8MacroTerrainDetailReady.value, 1);
});

test('floating-origin rebases preserve logical Terrain data and far travel reanchors it', () => {
  const { presentation } = createHarness({
    maximumCells: 1,
    anchorWorldX: 32,
    anchorWorldZ: 32,
  });
  const cell = makeCell(0, 0, 5);
  presentation.publishCell(cell);
  presentation.update({
    playerWorldX: 32,
    playerWorldZ: 32,
    renderOrigin: { renderOriginChunkX: 0, renderOriginChunkZ: 0 },
  });
  const positions = presentation.terrainMesh.geometry.attributes.position;
  const beforeRebase = Array.from(positions.array.subarray(0, 75));
  const rangesBeforeRebase = presentation.snapshot().bufferUpdateRangeCount;

  assert.equal(presentation.rebase({ renderOriginChunkX: 7, renderOriginChunkZ: -11 }), true);
  assert.deepEqual(Array.from(positions.array.subarray(0, 75)), beforeRebase,
    'render-origin-only rebases never rewrite world-fixed Terrain vertices');
  assert.deepEqual([
    presentation.root.position.x,
    presentation.root.position.y,
    presentation.root.position.z,
  ], [-160, 0, 416]);
  assert.equal(presentation.snapshot().bufferUpdateRangeCount, rangesBeforeRebase);
  for (let index = 0; index < 25; index += 1) {
    assert.equal(positions.array[index * 3] / 2 + 32, cell.terrainSamples[index].worldX);
    assert.equal(positions.array[index * 3 + 2] / 2 + 32, cell.terrainSamples[index].worldZ);
  }

  presentation.update({
    playerWorldX: 4_200,
    playerWorldZ: -4_200,
    renderOrigin: { renderOriginChunkX: 250, renderOriginChunkZ: -250 },
  });
  const snapshot = presentation.snapshot();
  assert.equal(snapshot.reanchorCount, 1);
  assert.deepEqual([snapshot.anchorWorldX, snapshot.anchorWorldZ], [4_192, -4_192]);
  assertRanges(positions, [{ start: 0, count: 75 }]);
  for (let index = 0; index < 25; index += 1) {
    assert.equal(positions.array[index * 3] / 2 + snapshot.anchorWorldX,
      cell.terrainSamples[index].worldX);
    assert.equal(positions.array[index * 3 + 2] / 2 + snapshot.anchorWorldZ,
      cell.terrainSamples[index].worldZ);
  }
});

test('Terrain updates stay range-bounded, invalidate bounds, and dispose cloned resources once', () => {
  const { parent, presentation, terrainSourceMaterial } = createHarness({ maximumCells: 2 });
  const { root, terrainMesh } = presentation;
  const geometry = terrainMesh.geometry;
  const material = terrainMesh.material;
  const positionAttribute = geometry.attributes.position;
  const colorAttribute = geometry.attributes.color;
  geometry.boundingBox = { stale: true };
  geometry.boundingSphere = { stale: true };

  presentation.publishCell(makeCell(-2, 3, 1));
  const firstUpload = presentation.flushUpdates();
  assert.deepEqual(firstUpload, { ranges: 2, bytes: 600 });
  assertRanges(positionAttribute, [{ start: 0, count: 75 }]);
  assertRanges(colorAttribute, [{ start: 0, count: 75 }]);
  assert.equal(geometry.boundingBox, null);
  assert.equal(geometry.boundingSphere, null);
  assert.deepEqual(presentation.flushUpdates(), { ranges: 0, bytes: 0 });

  presentation.publishCell(makeCell(-1, 3, 2));
  const secondUpload = presentation.flushUpdates();
  assert.deepEqual(secondUpload, { ranges: 2, bytes: 600 });
  assertRanges(positionAttribute, [{ start: 75, count: 75 }]);
  assertRanges(colorAttribute, [{ start: 75, count: 75 }]);
  assert.equal(presentation.snapshot().bufferUpdateRangeCount, 4);
  assert.equal(presentation.snapshot().bufferUploadBytes, 1_200);

  presentation.dispose();
  presentation.dispose();
  assert.deepEqual(parent.children, []);
  assert.equal(root.parent, null);
  assert.equal(parent.removeCount, 1);
  assert.equal(terrainMesh.disposeCount, 1);
  assert.equal(geometry.disposeCount, 1);
  assert.equal(material.disposeCount, 1);
  assert.equal(terrainSourceMaterial.disposeCount, 0,
    'the shared canonical Terrain source is not presentation-owned');
  assert.deepEqual(root.children, []);
  assert.equal(presentation.snapshot().enabled, false);
  assert.equal(presentation.snapshot().terrainCellCount, 0);
  assert.equal(presentation.publishCell(makeCell(0, 0)), false);
  assert.equal(presentation.retireCell('-2,3'), false);
  assert.equal(presentation.update({ playerWorldX: 0, playerWorldZ: 0 }), false);
  assert.equal(presentation.rebase({ renderOriginChunkX: 0, renderOriginChunkZ: 0 }), false);
});
