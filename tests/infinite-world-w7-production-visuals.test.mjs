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
  setScalar(value) { return this.set(value, value, value); }
}
class NodeObject {
  constructor() {
    this.children = []; this.position = new Triple(); this.rotation = new Triple();
    this.scale = new Triple().set(1, 1, 1); this.userData = {};
  }
  add(child) { this.children.push(child); child.parent = this; }
  remove(child) { this.children = this.children.filter(value => value !== child); child.parent = null; }
  clear() { for (const child of this.children) child.parent = null; this.children = []; }
  updateMatrix() {
    this.matrix = { position: { ...this.position }, rotation: { ...this.rotation }, scale: { ...this.scale } };
  }
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
class InstancedMesh extends Mesh {
  constructor(geometry, material, capacity) {
    super(geometry, material); this.capacity = capacity; this.count = 0;
    this.matrices = []; this.instanceMatrix = {};
  }
  setMatrixAt(index, matrix) { this.matrices[index] = structuredClone(matrix); }
}
const FakeThree = {
  Group, BoxGeometry, ConeGeometry, CylinderGeometry, SphereGeometry,
  DodecahedronGeometry, MeshLambertMaterial, MeshPhongMaterial, Mesh, InstancedMesh,
  Object3D: NodeObject,
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
    transparent: true,
    opacity: 0.72,
    depthWrite: false,
    shininess: 4,
  });
  assert.equal('horizonTerrain' in assets.materials, false);
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

  const finiteHuman = assets.createEntityModel('human');
  assert.equal(countMeshes(finiteHuman), 2);
  assert.equal(finiteHuman.userData.finiteMeshCount, 2);
  assert.deepEqual(Object.keys(finiteHuman.userData.presentationParts).sort(), ['body', 'head']);
  const finiteTank = assets.createEntityModel('tank');
  assert.equal(countMeshes(finiteTank), 8);
  assert.equal(finiteTank.userData.finiteMeshCount, 8);
  assert.equal(finiteTank.userData.presentationParts.gun.parent,
    finiteTank.userData.presentationParts.turret);
  assert.equal(finiteTank.userData.presentationParts.muzzle.parent,
    finiteTank.userData.presentationParts.gun);
  const finiteBoss = assets.createEntityModel('boss');
  assert.equal(finiteBoss.userData.segmentMeshes.length, 14);
  assert.equal(finiteBoss.userData.finiteToothCount, 10);
  assert.equal(finiteBoss.userData.finiteEyeCount, 4);
  assert.equal(countMeshes(finiteBoss), 28);
  assert.equal(finiteBoss.userData.segmentMeshes[0].children.length, 15);

  const adapter = new GameplayRenderAdapter({ THREE: FakeThree, scene, visualAssets: assets });
  adapter.consumePresentationEvents([], { playerMarker: player });
  const tankState = {
    stableId: 'wf1:tank:w8-scale-suppression',
    ownerChunkKey: '0,0',
    type: 'tank',
    x: 2,
    z: 3,
    rotationY: 0,
    turretRotationY: 0,
    gunPitch: 0,
    groundY: 1,
    groundPitch: 0,
    groundRoll: 0,
    alive: true,
    spawned: true,
  };
  await adapter.loadChunk('0,0', [tankState]);
  const loadedTankMesh = adapter.entityMeshes.get(tankState.stableId).mesh;
  assert.equal(loadedTankMesh.visible, true);
  adapter.syncEntity({ ...tankState, sandboxSuppressed: true });
  assert.equal(loadedTankMesh.visible, false);
  adapter.syncEntity({ ...tankState, sandboxSuppressed: false });
  assert.equal(loadedTankMesh.visible, true);
  adapter.syncReinforcement(tankState);
  assert.equal(adapter.entityMeshes.has(tankState.stableId), true);
  assert.equal(adapter.reinforcementMeshes.has(tankState.stableId), false,
    'a loaded canonical Tank Stable ID cannot create a second occurrence renderer entry');
  adapter.syncReinforcement({
    ...tankState,
    stableId: 'wf1:tank:w8-scale-suppression-fallback',
    sandboxSuppressed: true,
  });
  const fallbackTankMesh = adapter.reinforcementMeshes
    .get('wf1:tank:w8-scale-suppression-fallback').mesh;
  assert.equal(fallbackTankMesh.visible, false);
  adapter.syncReinforcement({
    ...tankState,
    stableId: 'wf1:tank:w8-scale-suppression-fallback',
    sandboxSuppressed: false,
  });
  assert.equal(fallbackTankMesh.visible, true);
  adapter.removeReinforcement('wf1:tank:w8-scale-suppression-fallback');
  await adapter.unloadChunk('0,0');
  adapter.syncReinforcement(tankState);
  assert.equal(adapter.entityMeshes.has(tankState.stableId), false);
  assert.equal(adapter.reinforcementMeshes.has(tankState.stableId), true);
  await adapter.loadChunk('0,0', [tankState]);
  assert.equal(adapter.entityMeshes.has(tankState.stableId), true);
  assert.equal(adapter.reinforcementMeshes.has(tankState.stableId), false,
    'canonical owner reload atomically replaces the occurrence renderer entry');
  await adapter.unloadChunk('0,0');
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

  adapter.syncTransientCombat([{
    id: 'tank-shot', ownerStableId: 'tank', type: 'tank-shell', x: 1.25, y: 2.05, z: -3.5,
    directionX: 0, directionZ: 1, remainingSeconds: 1,
  }], []);
  assert.deepEqual(
    { ...adapter.projectileMeshes.get('tank-shot').mesh.position },
    { x: 1.25 * adapter.unitsPerMeter, y: 2.05 * adapter.unitsPerMeter,
      z: -3.5 * adapter.unitsPerMeter },
  );
  const tankShellMesh = adapter.projectileMeshes.get('tank-shot').mesh;
  assert.equal(tankShellMesh.name, 'tank-projectile');
  assert.equal(tankShellMesh.material, assets.materials.blood);
  assert.equal(tankShellMesh.material.options.color, 0x7e1019);
  assert.deepEqual(
    { ...tankShellMesh.scale },
    { x: 0.5 * adapter.unitsPerMeter, y: 0.5 * adapter.unitsPerMeter,
      z: 0.5 * adapter.unitsPerMeter },
  );

  adapter.consumePresentationEvents([{
    sequence: 41, type: 'nuclear-destruction', logicalPosition: { x: 0, z: 0 },
    direction: { x: 0, z: 1 }, intensity: 4, lifetimeSeconds: 2.2, soundCue: 'atomic',
  }], { playerMarker: player });
  adapter.updatePresentation(0.1);
  const nuclearPools = adapter.snapshot().effectInstancePools;
  assert.equal(nuclearPools.flash.count, 1);
  assert.equal(nuclearPools.smoke.count, 8);
  assert.equal(nuclearPools.shockwave.count, 3);
  assert.equal(nuclearPools.scorch.count, 1);
  assert.equal(Object.values(nuclearPools).every(pool => pool.count <= pool.capacity), true);

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

test('W8 Tank death presentation is mechanical, timed, persistent, and bounded', async () => {
  const scene = new Group();
  const assets = createW8ParityVisualAssetLibrary({ THREE: FakeThree });
  const adapter = new GameplayRenderAdapter({ THREE: FakeThree, scene, visualAssets: assets });
  const event = (sequence, type, lifetimeSeconds, intensity) => ({
    sequence,
    type,
    logicalPosition: { x: 2, y: 1.5, z: -3 },
    direction: { x: 0, y: 0, z: 1 },
    intensity,
    lifetimeSeconds,
    soundCue: null,
  });

  assert.equal(adapter.consumePresentationEvents([
    event(1, 'tank-destruction', 4, 1.8),
    event(2, 'tank-ruin', 15, 0.85),
    event(3, 'tank-scar', 0, 1.75),
  ]), 3);
  adapter.updatePresentation(0);

  let snapshot = adapter.snapshot();
  assert.equal(snapshot.activePresentationEffectCount, 2);
  assert.equal(snapshot.persistentTankScarCount, 1);
  assert.equal(snapshot.effectInstancePools.debris.count, 4);
  assert.equal(snapshot.effectInstancePools.spark.count, 6);
  assert.equal(snapshot.effectInstancePools.ruin.count, 3);
  assert.equal(snapshot.effectInstancePools.smoke.count, 4);
  assert.equal(snapshot.effectInstancePools.scorch.count, 2);
  assert.equal(snapshot.effectInstancePools.blood.count, 0);

  adapter.updatePresentation(4);
  snapshot = adapter.snapshot();
  assert.equal(snapshot.activePresentationEffectCount, 1);
  assert.equal(snapshot.effectInstancePools.debris.count, 0);
  assert.equal(snapshot.effectInstancePools.spark.count, 0);
  assert.equal(snapshot.effectInstancePools.ruin.count, 3);
  assert.equal(snapshot.effectInstancePools.smoke.count, 1);
  assert.equal(snapshot.effectInstancePools.scorch.count, 1);
  assert.equal(snapshot.effectInstancePools.blood.count, 0);

  adapter.updatePresentation(11);
  snapshot = adapter.snapshot();
  assert.equal(snapshot.activePresentationEffectCount, 0);
  assert.equal(snapshot.effectInstancePools.ruin.count, 0);
  assert.equal(snapshot.effectInstancePools.smoke.count, 0);
  assert.equal(snapshot.persistentTankScarCount, 1);
  assert.equal(snapshot.effectInstancePools.scorch.count, 1);
  adapter.updatePresentation(100);
  assert.equal(adapter.snapshot().persistentTankScarCount, 1);
  assert.equal(adapter.snapshot().effectInstancePools.scorch.count, 1);

  adapter.consumePresentationEvents([
    ...Array.from({ length: 60 }, (_, index) =>
      event(100 + index, 'tank-scar', 0, 1.75)),
    ...Array.from({ length: 40 }, (_, index) =>
      event(200 + index, 'tank-ruin', 15, 0.85)),
  ]);
  adapter.updatePresentation(0);
  snapshot = adapter.snapshot();
  assert.equal(snapshot.persistentTankScarCount, snapshot.tankScarLimit);
  assert.equal(snapshot.tankScarLimit, 50);
  assert.equal(snapshot.activePresentationEffectCount, snapshot.tankRuinLimit);
  assert.equal(snapshot.tankRuinLimit, 30);
  assert.equal(snapshot.effectInstancePools.ruin.count, 90);
  assert.equal(snapshot.presentationPoolCapacity <= snapshot.presentationPoolLimit, true);
  assert.equal(
    Object.values(snapshot.effectInstancePools)
      .every(pool => pool.count <= pool.capacity),
    true,
  );

  assert.equal(adapter.clearCombatPresentation(), true);
  snapshot = adapter.snapshot();
  assert.equal(snapshot.activePresentationEffectCount, 0);
  assert.equal(snapshot.persistentTankScarCount, 0);
  assert.equal(
    Object.values(snapshot.effectInstancePools).every(pool => pool.count === 0),
    true,
  );

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
