import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const repoRoot = resolve(import.meta.dirname, '..');
const html = readFileSync(resolve(repoRoot, 'infinite-world-sandbox.html'), 'utf8');

function occurrenceCount(source, pattern) {
  return [...source.matchAll(pattern)].length;
}

test('Debug and Settings share one panel theme without Debug-specific color or placement overrides', () => {
  assert.match(html, /id="settings-modal" class="overlay"><div class="panel">/);
  assert.match(html, /id="debug-modal" class="overlay"><div class="panel">/);
  assert.doesNotMatch(html, /#debug-modal\s*\{/);
  assert.doesNotMatch(html, /#debug-modal\s+\.panel\s*\{/);
  for (const variable of [
    '--panel-overlay-color', '--panel-surface-color', '--panel-border-color',
    '--panel-text-color', '--panel-heading-color', '--panel-focus-color',
    '--panel-divider-color', '--panel-radius', '--panel-padding',
  ]) {
    assert.match(html, new RegExp(`var\\(${variable}\\)`), variable);
  }
  assert.match(html, /\.menu-btn:focus-visible, \.panel-btn:focus-visible/);
  assert.match(html, /id="debug-close-btn" class="panel-btn"/);
});

test('Debug panel is bounded and scrollable at low resolution with wrapping diagnostics', () => {
  assert.match(html, /max-height:\s*min\(90vh, calc\(100dvh - 28px\)\); overflow: auto/);
  assert.match(html, /scrollbar-color:\s*var\(--panel-border-color\)/);
  assert.match(html, /\.panel::-webkit-scrollbar-thumb/);
  assert.match(html, /\.debug-stats[^}]*overflow-wrap:\s*anywhere[^}]*word-break:\s*break-word/s);
  assert.match(html, /\.debug-runtime-details[^}]*max-height:\s*42vh[^}]*overflow:\s*auto/s);
  assert.match(html, /@media \(max-width: 600px\), \(max-height: 520px\)/);
  assert.match(html, /\.setting-row, \.debug-row \{ align-items: stretch; flex-direction: column/);
  assert.match(html, /id="debug-runtime-details" class="debug-stats debug-runtime-details"/);
  assert.match(html, /#gameplay-diagnostics-hud[^}]*position:\s*fixed[^}]*pointer-events:\s*none/s);
  assert.match(html, /#gameplay-diagnostics-hud[^}]*overflow-x:\s*hidden[^}]*overflow-wrap:\s*anywhere/s);
  assert.match(html, /body\.boss-active #gameplay-diagnostics-hud[^}]*top:\s*140px/s);
  assert.match(html, /@media \(max-width: 900px\)[\s\S]*#gameplay-diagnostics-hud/);
});

test('Debug DOM keeps one instance of every interactive and diagnostic target', () => {
  for (const id of [
    'debug-modal', 'debug-summary', 'debug-runtime-details', 'debug-close-btn',
    'gameplay-diagnostics-hud',
    'debug-gameplay-diagnostics-off-btn', 'debug-gameplay-diagnostics-on-btn',
    'set-tree-lod-overlay',
    'debug-tree-lod-overlay-off-btn', 'debug-tree-lod-overlay-on-btn',
    'debug-spawn-boss-btn',
  ]) {
    assert.equal(occurrenceCount(html, new RegExp(`id="${id}"`, 'g')), 1, id);
  }
  assert.doesNotMatch(html, /body\.experience-ready\.debug-open\s+#hud/);
  assert.match(html, /<details class="debug-details"><summary>FULL RUNTIME DIAGNOSTICS<\/summary>/);
  assert.match(html, /プレイ中診断HUD/);
  assert.match(html, /Tree LOD Overlay/);
});

test('playing diagnostics use the compact data path while full diagnostics remain modal-only', () => {
  const boot = readFileSync(resolve(repoRoot, 'src/infinite-world/sandbox-boot.js'), 'utf8');
  assert.match(boot, /experienceSnapshot\.gameplayDiagnosticsHudEnabled === true/);
  assert.match(boot, /if \(!debugDetailsEnabled\) \{[\s\S]*experienceShell\.renderHud/);
  assert.match(boot, /treeLodDiagnosticsAvailable:\s*\n\s*typeof distantPresentation\.setTreeLodDiagnosticsEnabled === 'function'/);
  assert.match(boot, /setTreeLodDiagnosticsEnabled\?\.\(enabled === true\)/);
  assert.match(boot, /fullDiagnosticHtml/);
});
