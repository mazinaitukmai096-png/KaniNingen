import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

export function verifyOptionalLegacySource({ provenance, file, repoRoot }) {
  const externalRoot = process.env.KANI_LEGACY_SOURCE_REPO;
  if (!externalRoot) return Object.freeze({ verified: false, reason: 'local-extraction-authoritative' });
  assert.equal(existsSync(externalRoot), true, 'KANI_LEGACY_SOURCE_REPO does not exist');
  const blob = execFileSync('git', [
    '-C', externalRoot, 'rev-parse', `${provenance.sourceCommit}:${file.source}`,
  ], { cwd: repoRoot, encoding: 'utf8' }).trim();
  assert.equal(blob, file.gitBlob);
  return Object.freeze({ verified: true, reason: 'external-source-verified' });
}
