import {
  W8_SHRUB_FIELD_DISTANCE_BANDS_METERS,
  createW8ShrubFieldPresentation,
} from '../src/infinite-world/render/w8-shrub-field-presentation.js';
import { createPresentationOwnerGenerator } from '../src/infinite-world/presentation-owner-generator.js';
import { LOGICAL_CHUNK_SIZE_METERS } from '../src/infinite-world/chunk-coordinates.js';

/**
 * Reconciles generated Bushes against drawn Bushes, by distance band.
 *
 * "It reaches the horizon" has been wrong about Bush twice, both times by mistaking Trees for
 * Bushes. This counts instead: how many Bushes the generator authors in each band around a
 * player, and how many of those the Bush presentation lane holds - split into the ones it
 * draws and the ones it hands to the Near tier. Generated must equal drawn plus handed over
 * in every band; that equality is the property a screenshot cannot show.
 *
 *   node tests/infinite-world-shrub-field-coverage-helper.mjs [--x <metres>] [--z <metres>]
 *     [--seed <world seed>] [--radius <metres>]
 *
 * One limit to read the output with: this harness builds owners with no presentation context,
 * so it applies no Settlement or Road exclusion. Near a Settlement it therefore reports more
 * Bushes than the running game generates - measured at the spawn town, 676 here against 658
 * live, with the outer bands agreeing exactly because no Settlement reaches them. Compare
 * against the live snapshot for absolute counts near a Settlement; the equality this harness
 * exists to check - generated equals staged equals drawn plus handed over - holds either way.
 */

const MACRO_CELL_CHUNKS = 4;
const MACRO_CELL_METERS = MACRO_CELL_CHUNKS * LOGICAL_CHUNK_SIZE_METERS;

function parseArguments(argv) {
  const options = {
    x: 0,
    z: 0,
    seed: 'KaniNingen Infinite Natural World',
    radiusMeters: W8_SHRUB_FIELD_DISTANCE_BANDS_METERS.at(-1),
  };
  for (let index = 0; index < argv.length; index += 2) {
    const value = argv[index + 1];
    if (value === undefined) throw new RangeError(`missing value for ${argv[index]}`);
    if (argv[index] === '--x') options.x = Number(value);
    else if (argv[index] === '--z') options.z = Number(value);
    else if (argv[index] === '--seed') options.seed = value;
    else if (argv[index] === '--radius') options.radiusMeters = Number(value);
    else throw new RangeError(`unsupported option ${argv[index]}`);
  }
  if (![options.x, options.z, options.radiusMeters].every(Number.isFinite)) {
    throw new RangeError('--x, --z and --radius must be finite');
  }
  return Object.freeze(options);
}

/**
 * A headless THREE surface. The lane only ever composes matrices and counts instances here,
 * so the arithmetic is real and nothing is rasterized.
 */
function createHeadlessThree() {
  class Vector3 {
    constructor() { this.set(0, 0, 0); }
    set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
  }
  class Euler extends Vector3 {}
  class Quaternion {
    constructor() { Object.assign(this, { x: 0, y: 0, z: 0, w: 1 }); }
    setFromEuler(euler) {
      this.x = Math.sin(euler.x / 2);
      this.y = Math.sin(euler.y / 2);
      this.z = Math.sin(euler.z / 2);
      this.w = Math.cos(euler.y / 2);
      return this;
    }
  }
  class Matrix4 {
    constructor() { this.elements = new Float64Array(16); }
    compose(position, quaternion, scale) {
      this.elements[0] = scale.x;
      this.elements[5] = scale.y;
      this.elements[10] = scale.z;
      this.elements[12] = position.x;
      this.elements[13] = position.y;
      this.elements[14] = position.z;
      this.elements[15] = 1;
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
    constructor(values, itemSize) {
      this.values = values;
      this.itemSize = itemSize;
      this.count = values.length / itemSize;
    }
    getX(index) { return this.values[index * this.itemSize]; }
    getY(index) { return this.values[index * this.itemSize + 1]; }
    getZ(index) { return this.values[index * this.itemSize + 2]; }
  }
  class BufferGeometry {
    constructor() { this.attributes = {}; this.index = null; }
    setAttribute(name, attribute) { this.attributes[name] = attribute; }
    getAttribute(name) { return this.attributes[name]; }
    setIndex(values) { this.index = new Attribute(values, 1); }
    getIndex() { return this.index; }
    computeBoundingSphere() {}
    applyMatrix4() { return this; }
    dispose() {}
  }
  class DodecahedronGeometry extends BufferGeometry {
    constructor() {
      super();
      this.setAttribute('position', new Attribute(new Float64Array(9), 3));
      this.setAttribute('normal', new Attribute(new Float64Array(9), 3));
      this.setIndex([0, 1, 2]);
    }
  }
  class Node {
    constructor() { this.children = []; this.parent = null; }
    add(child) { this.children.push(child); child.parent = this; }
    remove(child) {
      this.children = this.children.filter(value => value !== child);
      child.parent = null;
    }
  }
  class InstancedMesh extends Node {
    constructor(geometry, material, capacity) {
      super();
      this.geometry = geometry;
      this.material = material;
      this.count = capacity;
      this.instanceMatrix = { needsUpdate: false };
    }
    setMatrixAt() {}
    dispose() {}
  }
  class Material { dispose() {} }
  return {
    Vector3,
    Euler,
    Quaternion,
    Matrix4,
    Color,
    BufferGeometry,
    Float32BufferAttribute: Attribute,
    BoxGeometry: DodecahedronGeometry,
    SphereGeometry: DodecahedronGeometry,
    DodecahedronGeometry,
    MeshLambertMaterial: Material,
    InstancedMesh,
    Node,
  };
}

function bandIndexOf(distanceMeters) {
  return W8_SHRUB_FIELD_DISTANCE_BANDS_METERS
    .findIndex(maximumMeters => distanceMeters < maximumMeters);
}

function bandLabels() {
  return W8_SHRUB_FIELD_DISTANCE_BANDS_METERS.map((maximumMeters, index) => (
    `${index === 0 ? 0 : W8_SHRUB_FIELD_DISTANCE_BANDS_METERS[index - 1]}-${maximumMeters} m`
  ));
}

export async function measureShrubFieldCoverage({ x, z, seed, radiusMeters }) {
  const generator = await createPresentationOwnerGenerator({ worldSeed: seed });
  const THREE = createHeadlessThree();
  const presentation = createW8ShrubFieldPresentation({ THREE });
  if (presentation === null) throw new Error('Bush presentation lane refused the THREE surface');
  presentation.setRoot(new THREE.Node());

  const minimumCell = Math.floor((Math.min(x, z) - radiusMeters) / MACRO_CELL_METERS);
  const maximumCell = Math.ceil((Math.max(x, z) + radiusMeters) / MACRO_CELL_METERS);
  const generatedByBand = W8_SHRUB_FIELD_DISTANCE_BANDS_METERS.map(() => 0);
  let generatedBeyond = 0;
  let cellCount = 0;

  for (let macroZ = Math.floor((z - radiusMeters) / MACRO_CELL_METERS);
    macroZ <= Math.floor((z + radiusMeters) / MACRO_CELL_METERS); macroZ += 1) {
    for (let macroX = Math.floor((x - radiusMeters) / MACRO_CELL_METERS);
      macroX <= Math.floor((x + radiusMeters) / MACRO_CELL_METERS); macroX += 1) {
      // Only cells whose square can reach the outer band are worth generating.
      const nearestX = Math.max(macroX * MACRO_CELL_METERS,
        Math.min(x, (macroX + 1) * MACRO_CELL_METERS));
      const nearestZ = Math.max(macroZ * MACRO_CELL_METERS,
        Math.min(z, (macroZ + 1) * MACRO_CELL_METERS));
      if (Math.hypot(x - nearestX, z - nearestZ) > radiusMeters) continue;
      const cell = await generator.generateCanonicalTreeCell(macroX, macroZ);
      cellCount += 1;
      for (const shrub of cell.shrubField.shrubs) {
        const index = bandIndexOf(Math.hypot(shrub.position[0] - x, shrub.position[2] - z));
        if (index < 0) generatedBeyond += 1;
        else generatedByBand[index] += 1;
      }
      presentation.stage(cell.key, cell.shrubField, {
        buildOriginChunkX: 0,
        buildOriginChunkZ: 0,
      });
    }
  }
  presentation.setViewer(x, z);
  const snapshot = presentation.snapshot();
  presentation.dispose();
  return Object.freeze({
    minimumCell, maximumCell, cellCount, generatedByBand, generatedBeyond, snapshot,
  });
}

if (import.meta.filename === process.argv[1]) {
  const options = parseArguments(process.argv.slice(2));
  const result = await measureShrubFieldCoverage(options);
  const labels = bandLabels();
  console.log(`seed          ${options.seed}`);
  console.log(`player        ${options.x}, ${options.z} m (owner ${result.snapshot.viewerOwnerKey})`);
  console.log(`macro cells   ${result.cellCount} generated within ${options.radiusMeters} m`);
  console.log('');
  console.log('band          generated       staged        drawn   handed over');
  let failed = false;
  for (let index = 0; index < labels.length; index += 1) {
    const band = result.snapshot.distanceBands[index];
    const generated = result.generatedByBand[index];
    if (generated !== band.shrubCount
      || band.shrubCount !== band.drawnCount + band.handedOverCount) failed = true;
    console.log([
      labels[index].padEnd(12),
      String(generated).padStart(10),
      String(band.shrubCount).padStart(13),
      String(band.drawnCount).padStart(13),
      String(band.handedOverCount).padStart(14),
    ].join(''));
  }
  console.log([
    'beyond'.padEnd(12),
    String(result.generatedBeyond).padStart(10),
    String(result.snapshot.beyondOutermostBandCount).padStart(13),
  ].join(''));
  console.log('');
  console.log(`lane totals   ${result.snapshot.shrubCount} staged, `
    + `${result.snapshot.drawnCount} drawn, ${result.snapshot.handedOverCount} handed over `
    + `across ${result.snapshot.cellCount} cells`);
  if (failed) {
    console.error('MISMATCH: generated must equal staged, and staged must equal drawn + handed over');
    process.exitCode = 1;
  }
}
