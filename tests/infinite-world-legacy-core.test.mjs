import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { canonicalizeJson } from '../src/infinite-world/legacy-core/g0/canonical-json.js';
import { createChunkId } from '../src/infinite-world/legacy-core/g0/chunk-id.js';
import { createDeterministicRandom, deriveLocalSeed64 } from '../src/infinite-world/legacy-core/g0/deterministic-random.js';
import { parseGeneratorVersion, validateGeneratorVersion } from '../src/infinite-world/legacy-core/g0/generator-version.js';
import { hashWorldSeed, normalizeWorldSeed } from '../src/infinite-world/legacy-core/g0/seed.js';
import { createFeatureEdgeId, createWorldFeatureId } from '../src/infinite-world/legacy-core/g0/stable-id.js';

const repoRoot = resolve(import.meta.dirname, '..');
const provenancePath = resolve(repoRoot, 'src/infinite-world/legacy-core/PROVENANCE.json');

test('Legacy Core provenance records the fixed source commit and exact destination hashes', () => {
  const provenance = JSON.parse(readFileSync(provenancePath, 'utf8'));
  assert.equal(provenance.sourceCommit, '4210c069314a084b528d97e3d5a5e1345d38ad94');
  assert.equal(provenance.files.length, 9);
  for (const file of provenance.files) {
    assert.equal(file.importsAdjusted, false);
    const bytes = readFileSync(resolve(repoRoot, file.destination));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256, file.destination);
  }
});

test('Legacy world-seed SHA-256 golden vectors remain fixed', async () => {
  const vectors = [
    ['', '', 'e3b0c44298fc1c14', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['abc', 'abc', 'ba7816bf8f01cfea', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
    [' 123 ', '123', 'a665a45920422f9d', 'a665a45920422f9d417e4867efdc4fb8a04a1f3fff1fa07e998e86f7f7a27ae3'],
    [' e\u0301 ', 'é', '4a99557e4033c353', '4a99557e4033c3539de2eb65472017cad5f9557f7a0625a09f1c3f6e2ba69c4c'],
  ];
  for (const [input, normalized, seed64, digest] of vectors) {
    assert.equal(normalizeWorldSeed(input), normalized);
    assert.deepEqual(await hashWorldSeed(normalized), {
      worldSeedHash: `sha256:${digest}`,
      seed64,
    });
  }
});

test('Legacy canonical JSON, random, version, chunk ID, and Stable ID goldens remain fixed', async () => {
  assert.equal(
    canonicalizeJson({ z: 1, a: 'x', arr: [true, null, 2] }),
    '{"a":"x","arr":[true,null,2],"z":1}',
  );
  const { worldSeedHash } = await hashWorldSeed('abc');
  const localA = await deriveLocalSeed64({ worldSeedHash, namespace: 'terrain', semanticKey: 'chunk:0:-2' });
  const localB = await deriveLocalSeed64({ worldSeedHash, namespace: 'terrain', semanticKey: 'chunk:0:-2' });
  assert.equal(localA, localB);
  const random = createDeterministicRandom('ba7816bf8f01cfea');
  assert.equal(await random.uint64('a'), await random.uint64('a'));
  assert.notEqual(await random.uint64('a'), await random.uint64('b'));
  assert.deepEqual(parseGeneratorVersion('1.2.3'), { major: 1, minor: 2, patch: 3, id: '1.2.3' });
  assert.equal(validateGeneratorVersion({ major: 1, minor: 2, patch: 3, id: '1.2.3' }).valid, true);
  assert.equal(
    createChunkId({ worldSeedHash, generatorMajor: 1, chunkCoordinate: { x: -0, z: -2 } }),
    'chunk-v1:1:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad:0:-2',
  );
  const featureInput = {
    stableIdSchema: 'wf1', worldSeedHash, generatorMajor: 1,
    featureType: 'river', parentStableId: '', purposeKey: 'main-river', semanticLocalKey: 'primary',
  };
  assert.equal(
    (await createWorldFeatureId(featureInput)).stableId,
    'wf1:river:e5b308af544c74187d7533169276ccc7',
  );
  const edgeInput = {
    stableIdSchema: 'we1', worldSeedHash, generatorMajor: 1, relationType: 'connectsTo',
    from: { featureId: 'wf1:river:e5b308af544c74187d7533169276ccc7', portId: 'a' },
    to: { featureId: 'wf1:storm-drain:00000000000000000000000000000000', portId: 'b' },
    semanticLocalKey: 'river-drain',
  };
  assert.equal(
    (await createFeatureEdgeId(edgeInput)).stableId,
    'we1:connectsTo:04309597fac8bf75e84c0b74ca80556b',
  );
  assert.equal(
    (await createFeatureEdgeId({ ...edgeInput, from: edgeInput.to, to: edgeInput.from })).stableId,
    'we1:connectsTo:04309597fac8bf75e84c0b74ca80556b',
  );
});
