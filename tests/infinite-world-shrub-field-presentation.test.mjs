import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  W8_SHRUB_FIELD_DISTANCE_BANDS_METERS,
  W8_SHRUB_FIELD_PRESENTATION_SCHEMA,
  createW8ShrubFieldPresentation,
} from '../src/infinite-world/render/w8-shrub-field-presentation.js';
import { isRenderedOwnerChunk } from '../src/infinite-world/chunk-streaming-plan.js';
import {
  LOGICAL_CHUNK_SIZE_METERS,
  RENDER_BLOCK_CHUNK_RADIUS,
  UNITS_PER_METER,
  squareChunkCoordinates,
} from '../src/infinite-world/chunk-coordinates.js';
import { W8_PARITY_FEATURE_PARTS } from '../src/infinite-world/render/w8-parity-visual-assets.js';

// A THREE stand-in that composes matrices for real, so the instance transforms this lane
// writes can be checked against the numbers the Near tier projects rather than merely
// counted.
class Vector3 {
  constructor(x = 0, y = 0, z = 0) { this.set(x, y, z); }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
  multiplyScalar(value) { this.x *= value; this.y *= value; this.z *= value; return this; }
}
class Euler {
  constructor() { this.set(0, 0, 0); }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
}
class Quaternion {
  constructor() { this.x = 0; this.y = 0; this.z = 0; this.w = 1; }
  setFromEuler(euler) {
    // Intrinsic XYZ, the same order THREE uses by default.
    const [cx, cy, cz] = [euler.x, euler.y, euler.z].map(value => Math.cos(value / 2));
    const [sx, sy, sz] = [euler.x, euler.y, euler.z].map(value => Math.sin(value / 2));
    this.x = sx * cy * cz + cx * sy * sz;
    this.y = cx * sy * cz - sx * cy * sz;
    this.z = cx * cy * sz + sx * sy * cz;
    this.w = cx * cy * cz - sx * sy * sz;
    return this;
  }
}
class Matrix4 {
  constructor() { this.elements = new Float64Array(16); this.elements[0] = 1; this.elements[5] = 1; this.elements[10] = 1; this.elements[15] = 1; }
  compose(position, quaternion, scale) {
    const { x, y, z, w } = quaternion;
    const [x2, y2, z2] = [x + x, y + y, z + z];
    const [xx, xy, xz] = [x * x2, x * y2, x * z2];
    const [yy, yz, zz] = [y * y2, y * z2, z * z2];
    const [wx, wy, wz] = [w * x2, w * y2, w * z2];
    const element = this.elements;
    element[0] = (1 - (yy + zz)) * scale.x;
    element[1] = (xy + wz) * scale.x;
    element[2] = (xz - wy) * scale.x;
    element[3] = 0;
    element[4] = (xy - wz) * scale.y;
    element[5] = (1 - (xx + zz)) * scale.y;
    element[6] = (yz + wx) * scale.y;
    element[7] = 0;
    element[8] = (xz + wy) * scale.z;
    element[9] = (yz - wx) * scale.z;
    element[10] = (1 - (xx + yy)) * scale.z;
    element[11] = 0;
    element[12] = position.x;
    element[13] = position.y;
    element[14] = position.z;
    element[15] = 1;
    return this;
  }
}
class Color {
  setHex(hex) {
    this.r = ((hex >> 16) & 0xff) / 255;
    this.g = ((hex >> 8) & 0xff) / 255;
    this.b = (hex & 0xff) / 255;
    return this;
  }
}
class Attribute {
  constructor(values, itemSize) { this.values = values; this.itemSize = itemSize; this.count = values.length / itemSize; }
  getX(index) { return this.values[index * this.itemSize]; }
  getY(index) { return this.values[index * this.itemSize + 1]; }
  getZ(index) { return this.values[index * this.itemSize + 2]; }
}
class Float32BufferAttribute extends Attribute {}
class BufferGeometry {
  constructor() { this.attributes = {}; this.index = null; this.disposed = false; }
  setAttribute(name, attribute) { this.attributes[name] = attribute; }
  getAttribute(name) { return this.attributes[name]; }
  setIndex(values) { this.index = new Attribute(values, 1); }
  getIndex() { return this.index; }
  computeBoundingSphere() { this.boundingSphereComputed = true; }
  applyMatrix4(matrix) {
    const position = this.attributes.position;
    const element = matrix.elements;
    for (let index = 0; index < position.count; index += 1) {
      const [x, y, z] = [position.getX(index), position.getY(index), position.getZ(index)];
      position.values[index * 3] = element[0] * x + element[4] * y + element[8] * z + element[12];
      position.values[index * 3 + 1] = element[1] * x + element[5] * y + element[9] * z + element[13];
      position.values[index * 3 + 2] = element[2] * x + element[6] * y + element[10] * z + element[14];
    }
    return this;
  }
  dispose() { this.disposed = true; }
}
const unitGeometry = corners => {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(Float64Array.from(corners), 3));
  geometry.setAttribute('normal', new Float32BufferAttribute(Float64Array.from(corners), 3));
  geometry.setIndex([0, 1, 2]);
  return geometry;
};
class BoxGeometry extends BufferGeometry {
  constructor() { super(); Object.assign(this, unitGeometry([-0.5, -0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, 0.5])); }
}
class SphereGeometry extends BoxGeometry {}
class DodecahedronGeometry extends BufferGeometry {
  constructor() { super(); Object.assign(this, unitGeometry([-1, -1, -1, 1, -1, -1, 1, 1, 1])); }
}
class MeshLambertMaterial { constructor(options) { this.options = options; this.disposed = false; } dispose() { this.disposed = true; } }
class Node {
  constructor() { this.children = []; this.parent = null; }
  add(child) { this.children.push(child); child.parent = this; }
  remove(child) { this.children = this.children.filter(value => value !== child); child.parent = null; }
}
class InstancedMesh extends Node {
  constructor(geometry, material, capacity) {
    super();
    this.geometry = geometry;
    this.material = material;
    this.count = capacity;
    this.matrices = [];
    this.instanceMatrix = { needsUpdate: false };
    this.disposed = false;
  }
  setMatrixAt(index, matrix) { this.matrices[index] = Float64Array.from(matrix.elements); }
  dispose() { this.disposed = true; }
}
const FakeThree = {
  Vector3, Euler, Quaternion, Matrix4, Color, BufferGeometry, Float32BufferAttribute,
  BoxGeometry, SphereGeometry, DodecahedronGeometry, MeshLambertMaterial, InstancedMesh,
};

const shrubRecord = (chunkX, chunkZ, localX, localZ, suffix = '') => Object.freeze({
  stableId: `wf1:ambient-detail:shrub:${chunkX},${chunkZ}${suffix}`,
  owner: `${chunkX},${chunkZ}`,
  position: Object.freeze([
    chunkX * LOGICAL_CHUNK_SIZE_METERS + localX,
    2.5,
    chunkZ * LOGICAL_CHUNK_SIZE_METERS + localZ,
  ]),
  objectType: 'shrub',
  subtype: null,
  visualKind: 'shrub',
  dimensions: Object.freeze([0.75, 0.7, 0.75]),
  rotationY: 0.5,
  variationSeed: null,
  densityRank: 0.3,
  paletteKey: 'shrub:shrub',
});

const shrubField = shrubs => Object.freeze({
  schemaVersion: 'w8-canonical-shrub-field-1',
  cellSizeMeters: 4,
  shrubs: Object.freeze(shrubs),
});

test('the handoff predicate is exactly the render block', () => {
  // The Bush handoff is only free of gaps and overlaps because both sides read one rule, and
  // it must be the rule for what the renderer *draws*. Reading the tier that merely authors
  // ambient details instead left 746 Bushes drawn by nobody, so this holds the predicate
  // against the very coordinate set the renderer projects.
  for (const [centerChunkX, centerChunkZ] of [[0, 0], [7, -13], [-40, 25]]) {
    const rendered = new Set(squareChunkCoordinates(
      centerChunkX, centerChunkZ, RENDER_BLOCK_CHUNK_RADIUS,
    ).map(value => value.key));
    assert.equal(rendered.size, (RENDER_BLOCK_CHUNK_RADIUS * 2 + 1) ** 2);
    const span = RENDER_BLOCK_CHUNK_RADIUS + 3;
    for (let chunkZ = centerChunkZ - span; chunkZ <= centerChunkZ + span; chunkZ += 1) {
      for (let chunkX = centerChunkX - span; chunkX <= centerChunkX + span; chunkX += 1) {
        assert.equal(
          isRenderedOwnerChunk(chunkX, chunkZ, centerChunkX, centerChunkZ),
          rendered.has(`${chunkX},${chunkZ}`),
          `${chunkX},${chunkZ} around ${centerChunkX},${centerChunkZ}`,
        );
      }
    }
  }
});

test('the render block the handoff reads is the one the runtime projects', () => {
  // The predicate and the renderer's own coordinate set must stay one definition; a second
  // radius written down anywhere else is how the two sides drift apart again.
  const runtime = readFileSync(
    resolve(import.meta.dirname, '..', 'src/infinite-world/chunk-runtime-manager.js'), 'utf8',
  );
  assert.match(runtime, /squareChunkCoordinates([^)]*RENDER_BLOCK_CHUNK_RADIUS)/,
    'the runtime must build its render set from the shared radius');
  assert.equal(/squareChunkCoordinates((?:chunkX|centerChunkX), (?:chunkZ|centerChunkZ), 1)/
    .test(runtime), false, 'no render set may restate the radius as a literal');
});

test('a Bush this lane draws carries the Near tier\'s own transform', () => {
  const presentation = createW8ShrubFieldPresentation({ THREE: FakeThree });
  const root = new Node();
  presentation.setRoot(root);
  // Owner 40,0 sits far past Full residency, so this lane owns the draw.
  const shrub = shrubRecord(40, 0, 8, 8);
  assert.equal(presentation.stage('10,0', shrubField([shrub]), {
    buildOriginChunkX: 0, buildOriginChunkZ: 0,
  }), true);
  presentation.setViewer(0, 0);

  const mesh = root.children[0];
  assert.equal(mesh.count, 1);
  const elements = mesh.matrices[0];
  // The Near tier places a detail at its world position and scales the authored part by the
  // canonical dimensions; the baked unit Bush plus an instance scale of those dimensions has
  // to land in the same place at the same size.
  const [part] = W8_PARITY_FEATURE_PARTS.shrub;
  assert.equal(elements[12], shrub.position[0] * UNITS_PER_METER);
  assert.equal(elements[13], shrub.position[1] * UNITS_PER_METER);
  assert.equal(elements[14], shrub.position[2] * UNITS_PER_METER);
  assert.ok(mesh.geometry.getAttribute('position').count > 0,
    'the unit Bush must carry the authored geometry');
  // Instance scale is the record's own dimensions, in metres.
  assert.ok(Math.abs(Math.hypot(elements[0], elements[1], elements[2])
    - shrub.dimensions[0]) < 1e-9);
  assert.ok(Math.abs(Math.hypot(elements[4], elements[5], elements[6])
    - shrub.dimensions[1]) < 1e-9);
  // The unit Bush is one metre tall before that scale, so the authored part offset and
  // extent both ride the instance scale exactly as the Near tier's part matrix does.
  assert.equal(part.position[1] * UNITS_PER_METER > 0, true);
  assert.deepEqual(presentation.drawnStableIds(), [shrub.stableId]);
  presentation.dispose();
});

test('Bushes the Near tier owns are never drawn twice', () => {
  const presentation = createW8ShrubFieldPresentation({ THREE: FakeThree });
  const root = new Node();
  presentation.setRoot(root);
  const near = shrubRecord(0, 0, 8, 8);
  const far = shrubRecord(40, 0, 8, 8);
  presentation.stage('cell', shrubField([near, far]), {
    buildOriginChunkX: 0, buildOriginChunkZ: 0,
  });
  presentation.setViewer(0, 0);

  // Viewer (0, 0) owns Chunk -1,-1, so Chunk 0,0 is inside its render block and Chunk 40,0
  // is far outside it.
  assert.equal(isRenderedOwnerChunk(0, 0, -1, -1), true);
  assert.equal(isRenderedOwnerChunk(40, 0, -1, -1), false);
  const mesh = root.children[0];
  // The handed-over Bush collapses to nothing in place: instance order stays stable, so
  // walking back out of the render block brings it back without a rebuild.
  assert.equal(Math.hypot(mesh.matrices[0][0], mesh.matrices[0][1], mesh.matrices[0][2]), 0);
  assert.ok(Math.hypot(mesh.matrices[1][0], mesh.matrices[1][1], mesh.matrices[1][2]) > 0);
  assert.deepEqual(presentation.drawnStableIds(), [far.stableId]);

  const snapshot = presentation.snapshot();
  assert.equal(snapshot.schemaVersion, W8_SHRUB_FIELD_PRESENTATION_SCHEMA);
  assert.equal(snapshot.shrubCount, 2);
  assert.equal(snapshot.drawnCount, 1);
  assert.equal(snapshot.handedOverCount, 1);
  // A point on a Chunk boundary belongs to the west/north Chunk, the same rule the streaming
  // plan uses to centre Full residency on the player.
  assert.equal(snapshot.viewerOwnerKey, '-1,-1');

  // Walking out to the far Bush's Chunk swaps which lane owns which.
  presentation.setViewer(40 * LOGICAL_CHUNK_SIZE_METERS + 8, 8);
  assert.deepEqual(presentation.drawnStableIds(), [near.stableId]);
  assert.equal(presentation.snapshot().handedOverCount, 1);
  presentation.dispose();
});

test('retiring a Macro cell takes its Bushes out of the tally', () => {
  const presentation = createW8ShrubFieldPresentation({ THREE: FakeThree });
  const root = new Node();
  presentation.setRoot(root);
  const origin = { buildOriginChunkX: 0, buildOriginChunkZ: 0 };
  presentation.stage('near-cell', shrubField([shrubRecord(0, 0, 8, 8)]), origin);
  presentation.stage('far-cell', shrubField([shrubRecord(40, 0, 8, 8)]), origin);
  presentation.setViewer(0, 0);
  assert.deepEqual(
    [presentation.snapshot().shrubCount, presentation.snapshot().handedOverCount], [2, 1],
  );

  assert.equal(presentation.retire('near-cell'), true);
  const afterNear = presentation.snapshot();
  assert.equal(afterNear.shrubCount, 1);
  assert.equal(afterNear.handedOverCount, 0);
  assert.equal(afterNear.drawnCount, 1);
  assert.equal(root.children.length, 1);

  assert.equal(presentation.retire('far-cell'), true);
  assert.equal(presentation.retire('far-cell'), false);
  const empty = presentation.snapshot();
  assert.equal(empty.shrubCount, 0);
  assert.equal(empty.handedOverCount, 0);
  assert.equal(empty.drawnCount, 0);
  assert.equal(root.children.length, 0);
  presentation.dispose();
});

test('the snapshot reports drawn Bushes by distance band', () => {
  const presentation = createW8ShrubFieldPresentation({ THREE: FakeThree });
  presentation.setRoot(new Node());
  // One Bush per band, all outside Full residency so every one of them is this lane's.
  const bands = [150, 250, 400];
  const shrubs = bands.map((distanceMeters, index) => Object.freeze({
    ...shrubRecord(40 + index, 0, 0, 0, `:${index}`),
    position: Object.freeze([distanceMeters, 2.5, 0]),
  }));
  presentation.stage('cell', shrubField(shrubs), {
    buildOriginChunkX: 0, buildOriginChunkZ: 0,
  });
  presentation.setViewer(0, 0);

  const snapshot = presentation.snapshot();
  assert.deepEqual(
    snapshot.distanceBands.map(band => band.maximumMeters),
    [...W8_SHRUB_FIELD_DISTANCE_BANDS_METERS],
  );
  assert.deepEqual(snapshot.distanceBands.map(band => band.shrubCount), [0, 1, 1]);
  assert.deepEqual(snapshot.distanceBands.map(band => band.drawnCount), [0, 1, 1]);
  assert.equal(snapshot.beyondOutermostBandCount, 1,
    'a Bush past the retained Macro window is reported rather than silently counted in');
  presentation.dispose();
});

test('the lane degrades to nothing where THREE is unavailable', () => {
  assert.equal(createW8ShrubFieldPresentation({ THREE: {} }), null);
  assert.equal(createW8ShrubFieldPresentation({
    THREE: { ...FakeThree, DodecahedronGeometry: undefined },
  }), null);
});
