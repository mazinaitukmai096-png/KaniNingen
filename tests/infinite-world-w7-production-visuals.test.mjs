import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  FINITE_VISUAL_SOURCE_COMMIT,
  PRODUCTION_FEATURE_PARTS,
  PRODUCTION_VISUAL_UNITS_PER_METER,
  createProductionVisualAssetLibrary,
} from '../src/infinite-world/render/production-visual-assets.js';

const repoRoot = resolve(import.meta.dirname, '..');
const provenancePath = resolve(repoRoot, 'docs/infinite-world/W7-VISUAL-PROVENANCE.json');
const destinationPath = resolve(repoRoot, 'src/infinite-world/render/production-visual-assets.js');
const sha256 = value => createHash('sha256').update(value).digest('hex');

class Triple {
  constructor() { this.set(0, 0, 0); }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
}
class NodeObject {
  constructor() {
    this.children = []; this.position = new Triple(); this.rotation = new Triple();
    this.scale = new Triple().set(1, 1, 1); this.userData = {};
  }
  add(child) { this.children.push(child); child.parent = this; }
}
class Group extends NodeObject {}
class Geometry { dispose() { this.disposed = true; } }
class BoxGeometry extends Geometry {}
class ConeGeometry extends Geometry {}
class CylinderGeometry extends Geometry {}
class SphereGeometry extends Geometry {}
class DodecahedronGeometry extends Geometry {}
class Material { constructor(options) { this.options = options; } dispose() { this.disposed = true; } }
class MeshLambertMaterial extends Material {}
class Mesh extends NodeObject {
  constructor(geometry, material) { super(); this.geometry = geometry; this.material = material; }
}
const FakeThree = {
  Group, BoxGeometry, ConeGeometry, CylinderGeometry, SphereGeometry,
  DodecahedronGeometry, MeshLambertMaterial, Mesh,
};

test('W7A visual assets come only from the fixed finite baseline with verified provenance', () => {
  const provenance = JSON.parse(readFileSync(provenancePath, 'utf8'));
  assert.equal(FINITE_VISUAL_SOURCE_COMMIT, 'f8bc9f80c2af417bb585bff26c99522c4229ab8e');
  assert.equal(provenance.sourceCommit, FINITE_VISUAL_SOURCE_COMMIT);
  for (const [path, expectedHash] of Object.entries(provenance.sourceHashes)) {
    const content = execFileSync('git', ['show', `${FINITE_VISUAL_SOURCE_COMMIT}:${path}`], {
      cwd: repoRoot,
      encoding: null,
    });
    assert.equal(sha256(content), expectedHash, path);
  }
  assert.equal(sha256(readFileSync(destinationPath)), provenance.destination.sha256);
  assert.match(provenance.extractionMethod, /git show/);
});

test('W7A exposes production multipart visuals without adding logical World types', () => {
  assert.equal(PRODUCTION_VISUAL_UNITS_PER_METER, 40);
  assert.deepEqual(
    Object.keys(PRODUCTION_FEATURE_PARTS).sort(),
    ['broadleafTree', 'church', 'house', 'rock', 'school', 'shrub', 'tower', 'tree'],
  );
  for (const type of ['house', 'tower', 'school', 'church']) {
    assert.ok(PRODUCTION_FEATURE_PARTS[type].length >= 2, type);
  }
  const provenance = JSON.parse(readFileSync(provenancePath, 'utf8'));
  const referenceOnly = provenance.assets.filter(asset => asset.status === 'REFERENCE_ONLY')
    .map(asset => asset.asset).sort();
  assert.deepEqual(referenceOnly, ['Factory', 'Flower', 'Grass', 'Military Base', 'Street Object']);
});

test('W7A production Player, Human, and Tank share bounded resources and dispose once', () => {
  const assets = createProductionVisualAssetLibrary({ THREE: FakeThree });
  const initial = assets.snapshot();
  const player = assets.createPlayerModel();
  const human = assets.createEntityModel('human');
  const tank = assets.createEntityModel('tank');
  assert.ok(player.children.length >= 10);
  assert.equal(human.children.length, 2);
  assert.ok(tank.children.length >= 6);
  assert.equal(assets.snapshot().sharedGeometryCount, initial.sharedGeometryCount);
  assert.equal(assets.snapshot().sharedMaterialCount, initial.sharedMaterialCount);
  assets.dispose();
  assets.dispose();
  assert.equal(assets.snapshot().disposed, true);
});

test('W7A normal render paths no longer name Proxy geometry', () => {
  const source = [
    'src/infinite-world/render/chunk-render-adapter.js',
    'src/infinite-world/render/gameplay-render-adapter.js',
    'src/infinite-world/sandbox-boot.js',
  ].map(path => readFileSync(resolve(repoRoot, path), 'utf8')).join('\n');
  assert.doesNotMatch(source, /w1a-(?:tree|rock)-proxies|w1a-player-marker/);
  assert.match(source, /production-vegetation/);
  assert.match(source, /createPlayerModel/);
  assert.match(source, /createEntityModel/);
});
