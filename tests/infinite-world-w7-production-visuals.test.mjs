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
  W8_PRODUCTION_TREE_VISUAL_SCALE,
  createW8ParityVisualAssetLibrary,
} from '../src/infinite-world/render/w8-parity-visual-assets.js';
import { GameplayRenderAdapter } from '../src/infinite-world/render/gameplay-render-adapter.js';
import { W7_NUCLEAR_CONTRACT } from '../src/infinite-world/gameplay-contract.js';

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
class RingGeometry extends Geometry {
  constructor(innerRadius, outerRadius, segments) {
    super(); Object.assign(this, { innerRadius, outerRadius, segments });
  }
}
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
  RingGeometry, DodecahedronGeometry, MeshLambertMaterial, MeshPhongMaterial, Mesh, InstancedMesh,
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

test('W8 production Trees enlarge every part uniformly while preserving ground contact', () => {
  assert.equal(W8_PRODUCTION_TREE_VISUAL_SCALE, 4 / 3);
  const originalTreeParts = {
    tree: [
      ['box', 'treeTrunk', [0, 0.207, 0], [0.15, 0.414, 0.15]],
      ['cone', 'treeLeaves', [0, 0.621, 0], [0.5, 0.759, 0.5]],
    ],
    broadleafTree: [
      ['box', 'treeTrunk', [0, 0.207, 0], [0.15, 0.414, 0.15]],
      ['sphere', 'treeLeavesMeadow', [0, 0.552, 0], [0.6875, 0.448, 0.6875]],
      ['sphere', 'treeLeavesMeadow', [0.265, 0.655, -0.265], [0.4375, 0.241, 0.4375]],
    ],
    wetlandTree: [
      ['box', 'treeTrunk', [0, 0.207, 0], [0.15, 0.414, 0.15]],
      ['sphere', 'treeLeavesForest', [0, 0.552, 0], [0.6875, 0.448, 0.6875]],
      ['sphere', 'treeLeavesForest', [-0.265, 0.655, 0.265], [0.4375, 0.241, 0.4375]],
    ],
  };

  for (const [kind, originalParts] of Object.entries(originalTreeParts)) {
    const enlargedParts = W8_PARITY_FEATURE_PARTS[kind];
    assert.equal(enlargedParts.length, originalParts.length, kind);
    for (let index = 0; index < originalParts.length; index += 1) {
      const [geometry, material, position, scale] = originalParts[index];
      const enlarged = enlargedParts[index];
      assert.equal(enlarged.geometry, geometry, `${kind} geometry ${index}`);
      assert.equal(enlarged.material, material, `${kind} material ${index}`);
      assert.deepEqual(enlarged.rotation, [0, 0, 0], `${kind} rotation ${index}`);
      assert.deepEqual(
        enlarged.position,
        position.map(value => value * W8_PRODUCTION_TREE_VISUAL_SCALE),
        `${kind} position ${index}`,
      );
      assert.deepEqual(
        enlarged.scale,
        scale.map(value => value * W8_PRODUCTION_TREE_VISUAL_SCALE),
        `${kind} scale ${index}`,
      );
    }
    const trunk = enlargedParts[0];
    assert.equal(trunk.position[1] - trunk.scale[1] / 2, 0, `${kind} trunk ground contact`);
  }
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
  assert.equal(countMeshes(finiteHuman), 4);
  assert.equal(finiteHuman.userData.finiteMeshCount, 4);
  assert.deepEqual(Object.keys(finiteHuman.userData.presentationParts).sort(), [
    'body', 'head', 'leftLeg', 'legs', 'rightLeg', 'torso',
  ]);
  const humanParts = finiteHuman.userData.presentationParts;
  assert.equal(humanParts.body, humanParts.torso);
  assert.deepEqual(humanParts.legs, [humanParts.leftLeg, humanParts.rightLeg]);
  assert.deepEqual(
    { x: humanParts.torso.scale.x, y: humanParts.torso.scale.y, z: humanParts.torso.scale.z },
    { x: 36, y: 55, z: 26 },
  );
  assert.deepEqual(
    { x: humanParts.leftLeg.position.x, y: humanParts.leftLeg.position.y,
      z: humanParts.leftLeg.position.z },
    { x: -11, y: 34, z: 0 },
  );
  assert.deepEqual(
    { x: humanParts.rightLeg.position.x, y: humanParts.rightLeg.position.y,
      z: humanParts.rightLeg.position.z },
    { x: 11, y: 34, z: 0 },
  );
  assert.deepEqual(
    { x: humanParts.head.position.x, y: humanParts.head.position.y,
      z: humanParts.head.position.z },
    { x: 0, y: 130, z: 0 },
  );
  assert.deepEqual(
    { x: humanParts.head.scale.x, y: humanParts.head.scale.y, z: humanParts.head.scale.z },
    { x: 10, y: 10, z: 10 },
  );
  const humanMinimumY = Math.min(
    humanParts.leftLeg.position.y - humanParts.leftLeg.scale.y / 2,
    humanParts.rightLeg.position.y - humanParts.rightLeg.scale.y / 2,
  );
  const humanMaximumY = humanParts.head.position.y + humanParts.head.scale.y;
  assert.equal(humanMinimumY, 0);
  assert.equal(humanMaximumY, 140);
  const humanVisualScale = finiteHuman.userData.productionVisualScale;
  assert.equal(humanVisualScale, 0.5);
  assert.equal((humanMaximumY - humanMinimumY) * humanVisualScale
    / PRODUCTION_VISUAL_UNITS_PER_METER, 1.75);
  assert.equal(humanParts.head.scale.y * 2 * humanVisualScale
    / PRODUCTION_VISUAL_UNITS_PER_METER, 0.25);
  assert.equal(humanParts.torso.scale.x * humanVisualScale
    / PRODUCTION_VISUAL_UNITS_PER_METER, 0.45);
  assert.equal(humanParts.leftLeg.scale.y * humanVisualScale
    / PRODUCTION_VISUAL_UNITS_PER_METER, 0.85);
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
  assert.equal(adapter.setPlayerLocomotion({
    movedMeters: 1, elapsedSeconds: 0.1, grounded: true, intro: false,
  }), true);
  assert.notEqual(parts.legs[0].rotation.x, 0);
  assert.equal(parts.visualRoot.position.y, 0);
  assert.ok(adapter.getPlayerPresentationOffsetUnits().y > 0);
  assert.ok(Math.abs(parts.legs[0].rotation.x - Math.sin(3) * 0.8) < 1e-12);
  assert.ok(Math.abs(parts.legs[0].position.y - Math.max(0, Math.sin(6) * 10)) < 1e-12);
  assert.ok(Math.abs(adapter.getPlayerPresentationOffsetUnits().y
    - Math.abs(Math.sin(2.5)) * 20) < 1e-12);
  adapter.consumePresentationEvents([{
    type: 'both-claw-swish', logicalPosition: { x: 0, z: 0 }, intensity: 1,
    lifetimeSeconds: 0.28, soundCue: 'swish',
    sequence: 12,
    direction: { x: 0, z: 1 },
    presentation: {
      sides: ['left', 'right'], heading: 0, arcRadiusMeters: 4.5,
      particleScale: 1, visualScale: 1, particleCountPerSide: 28,
    },
  }], { playerMarker: player });
  adapter.updatePresentation(0.1);
  assert.equal(adapter.snapshot().effectInstancePools.wind.count, 56);
  assert.equal(adapter.effectInstancePools.get('wind').mesh.geometry, assets.geometries.box);
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
  adapter.consumePresentationEvents([{
    type: 'charge-release', logicalPosition: { x: 0, z: 0 }, intensity: 0,
    lifetimeSeconds: 0.01,
  }], { playerMarker: player });
  assert.equal(adapter.playerAttackPresentation.charging, false);
  assert.equal(adapter.getPlayerPresentationOffsetUnits().x, 0);
  assert.equal(adapter.getPlayerPresentationOffsetUnits().z, 0);

  const rendererBeforeTankShell = adapter.snapshot();
  const tankShellState = {
    id: 'tank-shot', ownerStableId: 'tank', type: 'tank-shell', x: 1.25, y: 2.05, z: -3.5,
    directionX: 0, directionZ: 1, remainingSeconds: 1,
  };
  adapter.syncTransientCombat([tankShellState], []);
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
  assert.equal(
    adapter.snapshot().counts.transientCreated - rendererBeforeTankShell.counts.transientCreated,
    1,
    'one Projectile state creates one renderer entry',
  );
  adapter.syncTransientCombat([{ ...tankShellState, x: 2.5, remainingSeconds: 0.5 }], []);
  assert.equal(adapter.projectileMeshes.get('tank-shot').mesh, tankShellMesh,
    'later frames update the existing renderer entry');
  assert.equal(
    adapter.snapshot().counts.transientCreated - rendererBeforeTankShell.counts.transientCreated,
    1,
    'later frames do not recreate the Projectile model',
  );
  adapter.syncTransientCombat([], []);
  assert.equal(adapter.snapshot().liveProjectileMeshes, 0);
  assert.equal(
    adapter.snapshot().counts.transientRemoved - rendererBeforeTankShell.counts.transientRemoved,
    1,
    'Projectile state removal removes its renderer entry once',
  );
  adapter.syncTransientCombat([], []);
  assert.equal(
    adapter.snapshot().counts.transientRemoved - rendererBeforeTankShell.counts.transientRemoved,
    1,
    'later frames cannot remove the same renderer entry again',
  );

  adapter.consumePresentationEvents([{
    sequence: 41, type: 'nuclear-destruction', logicalPosition: { x: 0, y: 12.5, z: 0 },
    direction: { x: 0, z: 1 }, intensity: 4, lifetimeSeconds: 3.5, soundCue: 'atomic',
  }], { playerMarker: player });
  adapter.updatePresentation(0.1);
  const nuclearPools = adapter.snapshot().effectInstancePools;
  assert.equal(nuclearPools.flash.count, 0);
  assert.equal(nuclearPools.atomicWhite.count, 36);
  assert.equal(nuclearPools.atomicOrange.count, 36);
  assert.equal(nuclearPools.goldSpark.count, 35);
  assert.equal(nuclearPools.atomicRing.count, 26);
  assert.equal(nuclearPools.smoke.count, 0);
  assert.equal(nuclearPools.shockwave.count, 0);
  assert.equal(nuclearPools.scorch.count, 0);
  assert.equal(Object.values(nuclearPools).every(pool => pool.count <= pool.capacity), true);
  const firstRing = adapter.effectInstancePools.get('atomicRing').mesh.matrices[0];
  assert.deepEqual(firstRing.scale, {
    x: 8 * adapter.unitsPerMeter,
    y: 2.25 * adapter.unitsPerMeter,
    z: 8 * adapter.unitsPerMeter,
  });
  const drag = -60 * Math.log(0.98);
  const ringSpeed = W7_NUCLEAR_CONTRACT.pushRadius * drag / (1 - Math.exp(-drag * 2.2));
  const expectedRingTravel = ringSpeed * (1 - Math.exp(-drag * 0.1)) / drag
    / 40 * adapter.unitsPerMeter;
  assert.ok(Math.abs(firstRing.position.x - expectedRingTravel) < 1e-9);
  const atomicWhiteY = adapter.effectInstancePools.get('atomicWhite').mesh.matrices[0].position.y;
  assert.ok(atomicWhiteY > 10 * adapter.unitsPerMeter,
    `Atomic cloud originates at the airborne Player instead of terrain zero: ${atomicWhiteY}`);

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

  assert.equal(adapter.consumePresentationEvents([{
    ...event(1, 'finite-target-destruction', 4, 1.8),
    presentation: {
      targetType: 'tank', radiusMeters: 1.75,
      charredCount: 5, sparkCount: 6, debrisCount: 10, bloodCount: 0,
      ruinScale: 0.85, scarKind: 'scorch', scarRadiusMeters: 1.75,
      shockwaveRadiusMeters: 0,
    },
  }]), 1);
  adapter.updatePresentation(0);

  let snapshot = adapter.snapshot();
  assert.equal(snapshot.activePresentationEffectCount, 2);
  assert.equal(snapshot.persistentTankScarCount, 1);
  assert.equal(snapshot.effectInstancePools.debris.count, 10);
  assert.equal(snapshot.effectInstancePools.charredImpact.count, 5);
  assert.equal(snapshot.effectInstancePools.goldSpark.count, 6);
  assert.equal(snapshot.effectInstancePools.ruin.count, 2);
  assert.equal(snapshot.effectInstancePools.smoke.count, 1);
  assert.equal(snapshot.effectInstancePools.scorch.count, 1);
  assert.equal(snapshot.effectInstancePools.blood.count, 0);

  adapter.updatePresentation(4);
  snapshot = adapter.snapshot();
  assert.equal(snapshot.activePresentationEffectCount, 1);
  assert.equal(snapshot.effectInstancePools.debris.count, 0);
  assert.equal(snapshot.effectInstancePools.charredImpact.count, 0);
  assert.equal(snapshot.effectInstancePools.goldSpark.count, 0);
  assert.equal(snapshot.effectInstancePools.ruin.count, 2);
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
  adapter.consumePresentationEvents([{
    ...event(400, 'finite-destruction-revisit', 0, 1.8),
    presentation: {
      targetType: 'house', radiusMeters: 2,
      charredCount: 5, sparkCount: 6, debrisCount: 10, bloodCount: 0,
      ruinScale: 0.85, scarKind: 'scorch', scarRadiusMeters: 2,
      shockwaveRadiusMeters: 0,
    },
  }]);
  adapter.updatePresentation(0);
  snapshot = adapter.snapshot();
  assert.equal(snapshot.activePresentationEffectCount, 1, 'revisit recreates only the timed Ruin');
  assert.equal(snapshot.persistentTankScarCount, 1, 'revisit recreates the durable Scorch');
  assert.equal(snapshot.effectInstancePools.debris.count, 0, 'transient debris is not replayed');

  await adapter.shutdown();
  assets.dispose();
});

test('finite Human and Rock destruction retain exact High-quality particle counts', async () => {
  const scene = new Group();
  const assets = createW8ParityVisualAssetLibrary({ THREE: FakeThree });
  const adapter = new GameplayRenderAdapter({ THREE: FakeThree, scene, visualAssets: assets });
  const base = {
    logicalPosition: { x: 0, y: 0, z: 0 },
    direction: { x: 1, y: 0, z: 0 },
    intensity: 1,
    lifetimeSeconds: 4,
    soundCue: null,
  };
  adapter.consumePresentationEvents([{
    ...base,
    sequence: 1,
    type: 'finite-target-destruction',
    presentation: {
      targetType: 'human', radiusMeters: 0.625,
      charredCount: 0, sparkCount: 0, debrisCount: 0, bloodCount: 35,
      ruinScale: 0, scarKind: 'blood', scarRadiusMeters: 0.9375,
      shockwaveRadiusMeters: 4,
    },
  }]);
  adapter.updatePresentation(0.1);
  let snapshot = adapter.snapshot();
  assert.equal(snapshot.effectInstancePools.blood.count, 35);
  assert.equal(snapshot.effectInstancePools.shockwave.count, 1);
  assert.equal(snapshot.effectInstancePools.bloodScar.count, 1);
  assert.equal(snapshot.effectInstancePools.charredImpact.count, 0);
  assert.equal(snapshot.effectInstancePools.goldSpark.count, 0);

  adapter.clearCombatPresentation();
  adapter.consumePresentationEvents([{
    ...base,
    sequence: 2,
    type: 'finite-target-destruction',
    presentation: {
      targetType: 'rock', radiusMeters: 1.25,
      charredCount: 5, sparkCount: 6, debrisCount: 8, bloodCount: 0,
      ruinScale: 0, scarKind: 'scorch', scarRadiusMeters: 1.25,
      shockwaveRadiusMeters: 0,
    },
  }]);
  adapter.updatePresentation(0.1);
  snapshot = adapter.snapshot();
  assert.equal(snapshot.effectInstancePools.charredImpact.count, 5);
  assert.equal(snapshot.effectInstancePools.goldSpark.count, 6);
  assert.equal(snapshot.effectInstancePools.rockDebris.count, 8);
  assert.equal(snapshot.effectInstancePools.scorch.count, 1);
  await adapter.shutdown();
  assets.dispose();
});

test('Boss Tail, segment, landing, Acid and recover events use bounded finite presentation pools', async () => {
  const scene = new Group();
  const assets = createW8ParityVisualAssetLibrary({ THREE: FakeThree });
  const adapter = new GameplayRenderAdapter({ THREE: FakeThree, scene, visualAssets: assets });
  const event = (sequence, type, lifetimeSeconds, presentation = null) => ({
    sequence, type, logicalPosition: { x: 0, y: 0, z: 0 },
    direction: { x: 1, y: 0, z: 0 }, intensity: 1,
    lifetimeSeconds, soundCue: null, presentation,
  });
  adapter.consumePresentationEvents([
    event(1, 'boss-tail-hit', 0.35, { particleCount: 8 }),
    event(2, 'boss-segment-break', 3.5, { bloodCount: 75, segmentCount: 3 }),
    event(3, 'boss-landing', 1.2, { dustCount: 24 }),
    event(4, 'boss-landing-scar', 0),
    event(5, 'acid-impact', 0.35, { acidCount: 12, dustCount: 0 }),
    event(6, 'boss-recover-star', 1.2),
  ]);
  adapter.updatePresentation(0.1);
  const pools = adapter.snapshot().effectInstancePools;
  assert.equal(pools.whiteParticle.count, 8);
  assert.equal(pools.blood.count, 75);
  assert.equal(pools.debris.count, 3);
  assert.equal(pools.dust.count, 24);
  assert.equal(pools.scorch.count, 1);
  assert.equal(pools.acid.count, 12);
  assert.equal(pools.dizzyStar.count, 1);
  assert.equal(Object.values(pools).every(pool => pool.count <= pool.capacity), true);
  await adapter.shutdown();
  assets.dispose();
});

test('Player landing renders two bounded shockwaves and finite-parity radial dust', async () => {
  const scene = new Group();
  const assets = createW8ParityVisualAssetLibrary({ THREE: FakeThree });
  const adapter = new GameplayRenderAdapter({ THREE: FakeThree, scene, visualAssets: assets });
  const event = (sequence, type, intensity, lifetimeSeconds, presentation = undefined) => ({
    sequence,
    type,
    logicalPosition: { x: 2, y: 1, z: -3 },
    direction: { x: 0, y: 0, z: 1 },
    intensity,
    lifetimeSeconds,
    soundCue: null,
    presentation,
  });
  adapter.consumePresentationEvents([
    event(1, 'player-landing-shockwave', 13.75, 0.85 / 2.4, {
      ringRole: 'outer', initialRadiusMeters: 0.25, maximumRadiusMeters: 13.75,
      color: 0xff3300, initialOpacity: 0.85,
    }),
    event(2, 'player-landing-shockwave', 9.5, 0.85 / 2.4, {
      ringRole: 'inner', initialRadiusMeters: 0.25, maximumRadiusMeters: 9.5,
      color: 0xffaa00, initialOpacity: 0.85,
    }),
    event(3, 'player-landing-dust', 1, 1.8),
  ]);
  adapter.updatePresentation(0.1);
  const snapshot = adapter.snapshot();
  assert.equal(snapshot.effectInstancePools.landingOuter.count, 1);
  assert.equal(snapshot.effectInstancePools.landingInner.count, 1);
  assert.equal(snapshot.effectInstancePools.dust.count, 14);
  assert.equal(snapshot.effectInstancePools.flash.count, 0);
  assert.equal(snapshot.effectInstancePools.debris.count, 0);
  assert.ok(Math.abs(adapter.effectInstancePools.get('landingOuter').mesh.material.opacity
    - (0.85 - 0.04 * 6)) < 1e-12);
  const outerMatrix = adapter.effectInstancePools.get('landingOuter').mesh.matrices[0];
  const expectedOuterRadius = 13.75 - (13.75 - 0.25) * (0.88 ** 6);
  assert.ok(Math.abs(outerMatrix.scale.x - expectedOuterRadius * adapter.unitsPerMeter) < 1e-12);
  assert.equal(assets.geometries.landingRing.innerRadius, 0.1);
  assert.equal(assets.geometries.landingRing.outerRadius, 1);
  assert.equal(assets.geometries.landingRing.segments, 20);
  assert.equal(assets.materials.landingOuter.options.color, 0xff3300);
  assert.equal(assets.materials.landingOuter.options.transparent, true);
  assert.equal(assets.materials.landingOuter.options.depthTest, false);
  assert.equal(assets.materials.landingOuter.options.depthWrite, false);
  assert.equal(assets.materials.landingInner.options.color, 0xffaa00);
  await adapter.rebase({ renderOriginChunkX: 1, renderOriginChunkZ: -1, rebaseCount: 2 });
  const rebasedOuterMatrix = adapter.effectInstancePools.get('landingOuter').mesh.matrices[0];
  assert.equal(rebasedOuterMatrix.position.x, (2 - 16) * adapter.unitsPerMeter);
  assert.equal(rebasedOuterMatrix.position.z, (-3 + 16) * adapter.unitsPerMeter);
  assert.equal(await adapter.rebase({
    renderOriginChunkX: 0, renderOriginChunkZ: 0, rebaseCount: 1,
  }), false, 'a delayed sync cannot restore an older effect origin');
  assert.deepEqual(adapter.effectInstancePools.get('landingOuter').mesh.matrices[0], rebasedOuterMatrix);
  assert.equal(adapter.snapshot().counts.staleRebasesRejected, 1);
  await adapter.shutdown();
  assets.dispose();
});

test('World Detail destruction renders six fixed-pool colored fragments', async () => {
  const scene = new Group();
  const assets = createW8ParityVisualAssetLibrary({ THREE: FakeThree });
  const adapter = new GameplayRenderAdapter({ THREE: FakeThree, scene, visualAssets: assets });
  adapter.consumePresentationEvents([{
    sequence: 1,
    type: 'world-detail-destruction',
    logicalPosition: { x: 2, y: 0, z: 3 },
    direction: { x: 0, y: 0, z: 1 },
    intensity: 0.5,
    lifetimeSeconds: 0.45,
    soundCue: 'hit',
  }]);
  adapter.updatePresentation(0.1);
  const snapshot = adapter.snapshot();
  assert.equal(snapshot.effectInstancePools.worldDetailDebris.count, 6);
  assert.equal(snapshot.effectInstancePools.debris.count, 0);
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
