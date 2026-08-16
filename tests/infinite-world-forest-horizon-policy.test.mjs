import test from 'node:test';
import assert from 'node:assert/strict';

import {
  W8_VEGETATION_LOD_KINDS,
  resolveW8VegetationLodBlend,
  resolveW8VegetationLodPolicy,
} from '../src/infinite-world/vegetation-lod-policy.js';
import { isW8ForestHorizonOwner } from '../src/infinite-world/forest-horizon-owner-policy.js';
import { resolveW8RenderDistancePolicy } from '../src/infinite-world/render-distance-policy.js';
import { createW8ParityChunkGenerator } from '../src/infinite-world/w8-parity-chunk-generator.js';
import { resolveW8NaturalCandidateVisual } from '../src/infinite-world/world-object-canonical-contract.js';

const PRESETS = Object.freeze(['short', 'standard', 'current']);
const q6 = value => Math.round(value * 1e6) / 1e6;
const blendAt = (preset, distanceMeters) => resolveW8VegetationLodBlend({
  kind: W8_VEGETATION_LOD_KINDS.TREE,
  distanceMeters,
  renderDistancePreset: preset,
});

test('canonical Far Tree policy carries the atmospheric handoff to each preset Fog limit', () => {
  for (const preset of PRESETS) {
    const renderDistance = resolveW8RenderDistancePolicy(preset);
    const tree = resolveW8VegetationLodPolicy(W8_VEGETATION_LOD_KINDS.TREE, preset);

    assert.equal(tree.farEntry, tree.atmosphericFade);
    assert.equal(tree.farEntry.maximum <= tree.visibilityMeters, true);
    const outerFadeWidth = q6(Math.max(4, 8 * renderDistance.fogFarMeters / 300));
    assert.deepEqual(tree.farFade, {
      minimum: q6(renderDistance.fogFarMeters - outerFadeWidth / 2),
      maximum: q6(renderDistance.fogFarMeters + outerFadeWidth / 2),
    });
    assert.equal(tree.farFade, tree.farDensity.outerFade,
      'the canonical Tree density and geometry share one outer Fog fade');
    assert.equal(tree.farFade.minimum >= tree.farEntry.maximum, true);
    assert.equal(tree.farFade.minimum < tree.farFade.maximum, true);
    assert.equal(tree.farVisibilityMeters, renderDistance.fogFarMeters);
    assert.equal(tree.visibilityMeters, renderDistance.fogFarMeters);
    assert.equal(tree.forestScale, 1);
    assert.equal(tree.atmosphericScale, 1);
    assert.equal(Object.hasOwn(tree, 'horizonEntry'), false);

    for (const kind of [
      W8_VEGETATION_LOD_KINDS.BUSH,
      W8_VEGETATION_LOD_KINDS.GRASS,
      W8_VEGETATION_LOD_KINDS.ROCK,
    ]) {
      const policy = resolveW8VegetationLodPolicy(kind, preset);
      assert.equal(policy.farEntry, null, `${preset}/${kind}`);
      assert.equal(policy.farFade, null, `${preset}/${kind}`);
      assert.equal(policy.farVisibilityMeters, null, `${preset}/${kind}`);
      assert.equal(resolveW8VegetationLodBlend({
        kind,
        distanceMeters: policy.visibilityMeters,
        renderDistancePreset: preset,
      }).far, 0);
    }
  }
});

test('Tree atmospheric-to-canonical-Far cross-fade is continuous and conserves opacity', () => {
  for (const preset of PRESETS) {
    const policy = resolveW8VegetationLodPolicy(W8_VEGETATION_LOD_KINDS.TREE, preset);
    const entryWidth = policy.farEntry.maximum - policy.farEntry.minimum;
    for (let sample = 0; sample <= 32; sample += 1) {
      const distance = policy.farEntry.minimum + entryWidth * sample / 32;
      const blend = blendAt(preset, distance);
      assert.equal(q6(blend.atmospheric + blend.far), 1, `${preset}@${distance}`);
      assert.equal(blend.totalOpacity, 1, `${preset}@${distance}`);
      assert.equal(blend.visible, true, `${preset}@${distance}`);
    }

    const entryStart = blendAt(preset, policy.farEntry.minimum);
    const entryMiddle = blendAt(
      preset,
      (policy.farEntry.minimum + policy.farEntry.maximum) / 2,
    );
    const entryEnd = blendAt(preset, policy.farEntry.maximum);
    assert.deepEqual(
      [entryStart.atmospheric, entryStart.far],
      [1, 0],
    );
    assert.deepEqual(
      [entryMiddle.atmospheric, entryMiddle.far],
      [0.5, 0.5],
    );
    assert.deepEqual(
      [entryEnd.atmospheric, entryEnd.far],
      [0, 1],
    );

    const fadeStart = blendAt(preset, policy.farFade.minimum);
    const fadeMiddle = blendAt(
      preset,
      (policy.farFade.minimum + policy.farFade.maximum) / 2,
    );
    const fog = blendAt(preset, policy.farVisibilityMeters);
    const fadeEnd = blendAt(preset, policy.farFade.maximum);
    assert.equal(fadeStart.far, 1);
    assert.equal(fadeStart.totalOpacity, 1);
    assert.equal(fadeMiddle.far, 0.5);
    assert.equal(fadeMiddle.totalOpacity, 0.5);
    assert.equal(fog.far > 0, true);
    assert.equal(fog.visible, true);
    assert.equal(fadeEnd.far, 0);
    assert.equal(fadeEnd.totalOpacity, 0);
    assert.equal(fadeEnd.visible, false);

    for (const boundary of [
      policy.farEntry.minimum,
      policy.farEntry.maximum,
      policy.farFade.minimum,
      policy.farFade.maximum,
    ]) {
      const before = blendAt(preset, boundary - 0.0001).totalOpacity;
      const after = blendAt(preset, boundary + 0.0001).totalOpacity;
      assert.equal(Math.abs(before - after) <= 0.000001, true, `${preset}@${boundary}`);
    }
  }
});

test('legacy Forest horizon owner selection remains deterministic for baseline comparison', () => {
  const seeds = Object.freeze([
    'sha256:forest-horizon-a',
    'sha256:forest-horizon-b',
    'sha256:forest-horizon-c',
    'sha256:forest-horizon-d',
  ]);
  const selectedOwners = new Set();

  for (const worldSeedHash of seeds) {
    const selected = [];
    for (let chunkZ = 0; chunkZ < 4; chunkZ += 1) {
      for (let chunkX = 0; chunkX < 4; chunkX += 1) {
        if (isW8ForestHorizonOwner({ worldSeedHash, chunkX, chunkZ })) {
          selected.push(`${chunkX},${chunkZ}`);
        }
      }
    }
    assert.equal(selected.length, 4);
    selectedOwners.add(selected.join('|'));

    for (let baseZ = -16; baseZ <= 16; baseZ += 4) {
      for (let baseX = -16; baseX <= 16; baseX += 4) {
        let selectedCount = 0;
        for (let offsetZ = 0; offsetZ < 4; offsetZ += 1) {
          for (let offsetX = 0; offsetX < 4; offsetX += 1) {
            selectedCount += Number(isW8ForestHorizonOwner({
              worldSeedHash,
              chunkX: baseX + offsetX,
              chunkZ: baseZ + offsetZ,
            }));
          }
        }
        assert.equal(selectedCount, 4, `${worldSeedHash}@${baseX},${baseZ}`);
      }
    }

    for (let chunkZ = -32; chunkZ <= 32; chunkZ += 1) {
      for (let chunkX = -32; chunkX <= 32; chunkX += 1) {
        let covered = false;
        for (let offsetZ = -1; offsetZ <= 1 && !covered; offsetZ += 1) {
          for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
            if (isW8ForestHorizonOwner({
              worldSeedHash,
              chunkX: chunkX + offsetX,
              chunkZ: chunkZ + offsetZ,
            })) {
              covered = true;
              break;
            }
          }
        }
        assert.equal(covered, true, `${worldSeedHash} uncovered ${chunkX},${chunkZ}`);
      }
    }

    const coordinates = Array.from({ length: 19 * 19 }, (_, index) => ({
      chunkX: index % 19 - 9,
      chunkZ: Math.floor(index / 19) - 9,
    }));
    const forward = coordinates.map(coordinate => isW8ForestHorizonOwner({
      worldSeedHash, ...coordinate,
    }));
    const reverse = [...coordinates].reverse().map(coordinate => isW8ForestHorizonOwner({
      worldSeedHash, ...coordinate,
    })).reverse();
    assert.deepEqual(forward, reverse);
  }

  assert.equal(selectedOwners.size > 1, true, 'world seed must affect lattice selection');
  assert.throws(() => isW8ForestHorizonOwner({
    worldSeedHash: '', chunkX: 0, chunkZ: 0,
  }), /worldSeedHash/);
  assert.throws(() => isW8ForestHorizonOwner({
    worldSeedHash: seeds[0], chunkX: 0.5, chunkZ: 0,
  }), /safe integer/);
});

test('legacy Remote Horizon baseline remains reproducible for performance comparison', async t => {
  const generator = await createW8ParityChunkGenerator({
    worldSeed: 'KaniNingen Infinite Natural World',
  });
  try {
    const center = generator.experienceSpawn;
    const chunkSize = 16;
    const intersects = (chunkX, chunkZ, radius) => {
      const nearestX = Math.max(
        chunkX * chunkSize,
        Math.min(center.x, (chunkX + 1) * chunkSize),
      );
      const nearestZ = Math.max(
        chunkZ * chunkSize,
        Math.min(center.z, (chunkZ + 1) * chunkSize),
      );
      return Math.hypot(center.x - nearestX, center.z - nearestZ) <= radius;
    };
    const owners = [];
    const exactOwners = [];
    for (let chunkZ = Math.floor((center.z - 300) / chunkSize);
      chunkZ <= Math.floor((center.z + 300) / chunkSize); chunkZ += 1) {
      for (let chunkX = Math.floor((center.x - 300) / chunkSize);
        chunkX <= Math.floor((center.x + 300) / chunkSize); chunkX += 1) {
        if (!intersects(chunkX, chunkZ, 300)) continue;
        if (intersects(chunkX, chunkZ, 140)) {
          exactOwners.push([chunkX, chunkZ]);
          continue;
        }
        if (!isW8ForestHorizonOwner({
            worldSeedHash: generator.worldSeedHash,
            chunkX,
            chunkZ,
          })) continue;
        owners.push([chunkX, chunkZ]);
      }
    }
    const trees = [];
    let payloadBytes = 0;
    for (const [chunkX, chunkZ] of owners) {
      const manifest = await generator.generateForestHorizonManifest(chunkX, chunkZ);
      payloadBytes += JSON.stringify(manifest).length;
      trees.push(...manifest.presentationLayers.natural.vegetation);
    }
    assert.equal(owners.length, 231);
    assert.equal(trees.length, 1_675);
    assert.equal(new Set(trees.map(tree => tree.candidateId)).size, trees.length);
    // The full visual coverage includes the 5x5 active set; the distant query
    // omits those 25 already-loaded owners and therefore reports 251.
    assert.equal(exactOwners.length, 276);
    const coverageTrees = [...trees];
    for (const [chunkX, chunkZ] of exactOwners) {
      const manifest = await generator.generateForestHorizonManifest(chunkX, chunkZ);
      coverageTrees.push(...manifest.presentationLayers.natural.vegetation);
    }
    assert.equal(
      new Set(coverageTrees.map(tree => tree.candidateId)).size,
      coverageTrees.length,
    );
    const legacyHorizonScale = 2.84;
    const crowns = coverageTrees.map(tree => {
      const visual = resolveW8NaturalCandidateVisual(tree);
      return {
        x: tree.worldPosition.x,
        z: tree.worldPosition.z,
        radius: Math.max(visual.widthMeters, visual.depthMeters) * legacyHorizonScale / 2,
      };
    });
    let maximumNearestTreeCenterMeters = 0;
    let maximumNearestCanopyEdgeMeters = 0;
    let maximumPoint = null;
    let maximumCoreCanopyEdgeMeters = 0;
    for (let worldZ = center.z - 296; worldZ <= center.z + 296; worldZ += 4) {
      for (let worldX = center.x - 296; worldX <= center.x + 296; worldX += 4) {
        const radius = Math.hypot(worldX - center.x, worldZ - center.z);
        if (radius < 140 || radius > 296) continue;
        let nearestCenter = Infinity;
        let nearestCanopyEdge = Infinity;
        for (const crown of crowns) {
          const centerDistance = Math.hypot(crown.x - worldX, crown.z - worldZ);
          nearestCenter = Math.min(nearestCenter, centerDistance);
          nearestCanopyEdge = Math.min(nearestCanopyEdge, Math.max(0, centerDistance - crown.radius));
        }
        maximumNearestTreeCenterMeters = Math.max(
          maximumNearestTreeCenterMeters,
          nearestCenter,
        );
        if (nearestCanopyEdge > maximumNearestCanopyEdgeMeters) {
          maximumNearestCanopyEdgeMeters = nearestCanopyEdge;
          maximumPoint = { worldX, worldZ, radius };
        }
        if (radius >= 156 && radius <= 284) {
          maximumCoreCanopyEdgeMeters = Math.max(
            maximumCoreCanopyEdgeMeters,
            nearestCanopyEdge,
          );
        }
      }
    }
    t.diagnostic(JSON.stringify({
      ownerCount: owners.length,
      exactOwnerCount: exactOwners.length,
      treeCount: trees.length,
      coverageTreeCount: coverageTrees.length,
      payloadBytes,
      maximumNearestTreeCenterMeters: q6(maximumNearestTreeCenterMeters),
      maximumNearestCanopyEdgeMeters: q6(maximumNearestCanopyEdgeMeters),
      maximumCoreCanopyEdgeMeters: q6(maximumCoreCanopyEdgeMeters),
      maximumPoint,
    }));
    assert.equal(maximumNearestCanopyEdgeMeters < 22.5, true,
      `maximum nearest canopy edge ${maximumNearestCanopyEdgeMeters}m`);
    assert.equal(payloadBytes < 650_000, true);
  } finally {
    await generator.shutdown();
  }
});
