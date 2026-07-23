import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const repoRoot = resolve(import.meta.dirname, '..');
const manifest = JSON.parse(readFileSync(
  resolve(repoRoot, 'docs/infinite-world/W8-FINITE-PARITY-PROVENANCE.json'),
  'utf8',
));
const sha256 = content => createHash('sha256').update(content).digest('hex');

test('W8 finite parity manifest pins the protected baseline and every extracted source', () => {
  assert.equal(manifest.sourceCommit, 'f8bc9f80c2af417bb585bff26c99522c4229ab8e');
  for (const [path, expected] of Object.entries(manifest.sourceHashes)) {
    assert.equal(sha256(readFileSync(resolve(repoRoot, path))), expected, path);
  }
  assert.ok(manifest.extractions.some(value => value.area === 'renderer'));
  assert.ok(manifest.extractions.some(value => value.area === 'input-and-combat'));
  assert.ok(manifest.extractions.some(value => value.area === 'models-and-world-language'));
  assert.ok(manifest.extractions.some(value => value.area === 'audio'));
});
