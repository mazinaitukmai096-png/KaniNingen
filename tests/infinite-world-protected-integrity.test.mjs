import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const BASELINE_COMMIT = 'f8bc9f80c2af417bb585bff26c99522c4229ab8e';
const repoRoot = resolve(import.meta.dirname, '..');
const protectedFiles = [
  'index.html',
  'src/game.js',
  'src/constants.js',
  'src/road-town-structure.js',
  'src/building-frontage.js',
  'src/building-lot.js',
  'src/capital-civic-core.js',
  'src/civic-space.js',
  'src/settlement-building-visuals.js',
  'src/settlement-life-details.js',
  'src/settlement-road-parameters.js',
  'src/settlement-type.js',
];

function normalizedText(value) {
  return value.replace(/\r\n/g, '\n');
}

test('the finite Gameplay World and protected settlement/civic modules equal the exact baseline', () => {
  for (const path of protectedFiles) {
    const current = normalizedText(readFileSync(resolve(repoRoot, path), 'utf8'));
    const baseline = normalizedText(execFileSync('git', ['show', `${BASELINE_COMMIT}:${path}`], { cwd: repoRoot, encoding: 'utf8' }));
    assert.equal(current, baseline, path);
  }
});

test('every committed and worktree change stays inside the Infinite World allowlist', () => {
  const committed = execFileSync('git', ['-c', 'core.quotepath=false', 'diff', '--name-only', `${BASELINE_COMMIT}..HEAD`], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).trimEnd().split(/\r?\n/).filter(Boolean);
  const status = execFileSync('git', ['-c', 'core.quotepath=false', 'status', '--porcelain=v1', '--untracked-files=all'], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).trimEnd().split(/\r?\n/).filter(Boolean);
  const changedPaths = [...new Set([
    ...committed,
    ...status.map(line => line.slice(3).replaceAll('\\', '/')),
  ])];
  assert.ok(changedPaths.length > 0);
  for (const path of changedPaths) {
    const allowed = path === 'tests/destruction-feel-regression.test.mjs'
      || path === 'ゲーム起動.bat'
      || path === 'infinite-world-sandbox.html'
      || path.startsWith('src/infinite-world/')
      || path.startsWith('tests/infinite-world-')
      || path.startsWith('docs/infinite-world/');
    assert.equal(allowed, true, `out-of-scope Infinite World branch change: ${path}`);
  }
});
