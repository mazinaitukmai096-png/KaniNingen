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
import {
  W8_FINITE_HOUSE_VARIANTS,
  W8_PARITY_FEATURE_PARTS,
  createW8ParityVisualAssetLibrary,
} from '../src/infinite-world/render/w8-parity-visual-assets.js';
import { GameplayRenderAdapter } from '../src/infinite-world/render/gameplay-render-adapter.js';

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
  remove(child) { this.children = this.children.filter(value => value !== child); child.parent = null; }
  clear() { for (const child of this.children) child.parent = null; this.children = []; }
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
class MeshPhongMaterial extends Material {}
class Mesh extends NodeObject {
  constructor(geometry, material) { super(); this.geometry = geometry; this.material = material; }
}
const FakeThree = {
  Group, BoxGeometry, ConeGeometry, CylinderGeometry, SphereGeometry,
  DodecahedronGeometry, MeshLambertMaterial, MeshPhongMaterial, Mesh,
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
  const canonicalDestination = execFileSync('git', ['show', `HEAD:${provenance.destination.path}`], {
    cwd: repoRoot,
    encoding: null,
  });
  assert.equal(sha256(canonicalDestination), provenance.destination.sha256);
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

test('W8 settlement and atmosphere materials use the finite visual baseline', () => {
  const assets = createW8ParityVisualAssetLibrary({ THREE: FakeThree });
  assert.ok(assets.materials.road instanceof MeshPhongMaterial);
  assert.deepEqual(assets.materials.road.options, { color: 0xc2a878, shininess: 3 });
  assert.equal(assets.materials.houseWall.options.color, 0xeeeeee);
  assert.equal(assets.materials.houseRoof.options.color, 0xaa2222);
  assert.equal(assets.materials.factoryWall.options.color, 0x707878);
  assert.equal(assets.materials.barn.options.color, 0x8b3a2f);
  assert.equal(assets.materials.lotResidential.options.color, 0xa58c68);
  assert.equal(assets.materials.lotCivic.options.color, 0x918d84);
  assert.equal(W8_FINITE_HOUSE_VARIANTS.length, 5);
  assert.ok(W8_PARITY_FEATURE_PARTS.tower.length >= 6);
  assert.ok(W8_PARITY_FEATURE_PARTS.church.length >= 12);
  assert.ok(W8_PARITY_FEATURE_PARTS.school.length >= 10);
  assert.ok(W8_PARITY_FEATURE_PARTS.factory.length >= 7);
  assert.ok(W8_PARITY_FEATURE_PARTS.militaryBase.length >= 18);
  assert.ok(W8_PARITY_FEATURE_PARTS.barn.length >= 7);
  const visualBuilding = {
    stableId: 'palette-building',
    buildingType: 'house',
    visual: { wallColor: 0x80634c, roofColor: 0x536247, roofScale: 1.1 },
  };
  const resolved = assets.resolveBuildingParts(visualBuilding);
  const wall = resolved.find(part => part.materialRole === 'wall');
  const roof = resolved.find(part => part.materialRole === 'roof');
  assert.equal(assets.materials[wall.material].options.color, visualBuilding.visual.wallColor);
  assert.equal(assets.materials[roof.material].options.color, visualBuilding.visual.roofColor);
  const unscaledRoof = assets.resolveBuildingParts({
    ...visualBuilding, visual: { ...visualBuilding.visual, roofScale: 1 },
  }).find(part => part.materialRole === 'roof');
  assert.equal(roof.scale[1], unscaledRoof.scale[1] * 1.1);
  assert.deepEqual(assets.materials.cloud.options, {
    color: 0xffffff,
    flatShading: true,
    transparent: true,
    opacity: 0.68,
    depthWrite: false,
  });
  assert.equal(assets.materials.horizonTerrain.options.color, 0x668c54);
  assets.dispose();
  assert.equal(assets.snapshot().disposed, true);
});

test('W8 Player is the finite 21 Mesh hierarchy and its pivots drive presentation only', async () => {
  const scene = new Group();
  const assets = createW8ParityVisualAssetLibrary({ THREE: FakeThree });
  const player = assets.createPlayerModel();
  const parts = player.userData.presentationParts;
  const countMeshes = node => (node instanceof Mesh ? 1 : 0)
    + node.children.reduce((sum, child) => sum + countMeshes(child), 0);
  assert.equal(countMeshes(player), 21);
  assert.deepEqual(
    { x: parts.leftClaw.position.x, y: parts.leftClaw.position.y, z: parts.leftClaw.position.z },
    { x: 85, y: 30, z: 5 },
  );
  assert.deepEqual(
    { x: parts.rightClaw.position.x, y: parts.rightClaw.position.y, z: parts.rightClaw.position.z },
    { x: -85, y: 30, z: 5 },
  );
  assert.equal(parts.leftClaw.children.length, 3);
  assert.equal(parts.rightClaw.children.length, 3);
  assert.equal(parts.legs.length, 8);

  const adapter = new GameplayRenderAdapter({ THREE: FakeThree, scene, visualAssets: assets });
  adapter.consumePresentationEvents([], { playerMarker: player });
  assert.equal(adapter.setPlayerLocomotion({ movedMeters: 1, walkPhase: 0.8, grounded: true }), true);
  assert.notEqual(parts.legs[0].rotation.x, 0);
  assert.equal(parts.visualRoot.position.y, 0);
  assert.ok(adapter.getPlayerPresentationOffsetUnits().y > 0);
  adapter.consumePresentationEvents([{
    type: 'both-claw-swish', logicalPosition: { x: 0, z: 0 }, intensity: 1,
    lifetimeSeconds: 0.28, soundCue: 'swish',
  }], { playerMarker: player });
  adapter.updatePresentation(0.1);
  assert.notEqual(parts.leftClaw.position.z, 5);
  assert.notEqual(parts.rightClaw.position.z, 5);
  assert.notEqual(parts.visualRoot.rotation.x, 0);
  adapter.consumePresentationEvents([{
    type: 'charge-start', logicalPosition: { x: 0, z: 0 }, intensity: 1,
    lifetimeSeconds: 0.25, soundCue: 'rumble',
  }], { playerMarker: player });
  adapter.updatePresentation(0.5);
  assert.notEqual(adapter.getPlayerPresentationOffsetUnits().x, 0);
  assert.equal(parts.visualRoot.position.y, 0);

  adapter.syncManualBoss({
    stableId: 'manual-boss-camera', alive: true, x: 0, z: 0, rotationY: 0,
    bossBehavior: { verticalOffset: 0, segmentHp: new Array(14).fill(1) },
  });
  assert.equal(adapter.manualBossEntry.mesh.userData.segmentMeshes.length, 14);
  const bossRoot = adapter.manualBossEntry.mesh;
  const firstSegment = bossRoot.userData.segmentMeshes[0];
  const bossCamera = { position: new Triple().set(
    bossRoot.position.x + firstSegment.position.x * bossRoot.scale.x,
    bossRoot.position.y + firstSegment.position.y * bossRoot.scale.y,
    bossRoot.position.z + firstSegment.position.z * bossRoot.scale.z,
  ) };
  const bossCollision = adapter.resolveBossCameraCollision({
    camera: bossCamera, target: { x: 0, y: 0, z: 0 },
  });
  assert.equal(bossCollision.collided, true);
  assert.equal(bossCollision.stableId, 'manual-boss-camera');
  await adapter.shutdown();
  assets.dispose();
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
