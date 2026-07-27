import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { createFiniteGameplayHudAdapter } from '../src/infinite-world/finite-gameplay-hud.js';
import { W7_NUCLEAR_CONTRACT } from '../src/infinite-world/gameplay-contract.js';

const sandboxHtml = readFileSync(resolve(import.meta.dirname, '..', 'infinite-world-sandbox.html'), 'utf8');

function element() {
  const classes = new Set();
  return {
    style: {}, textContent: '',
    classList: {
      toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); },
      contains(name) { return classes.has(name); },
    },
  };
}

function createElements() {
  return {
    score: element(), hp: element(), hpFill: element(), atomicLabel: element(),
    boss: element(), bossFill: element(), bossDamage: element(), bossTitle: element(),
    charge: element(), chargeFill: element(), chargeLabel: element(),
  };
}

function snapshot({ hp = 100, maxHp = 100, score = 0, stage = 'MAX', cooldownMs = 0, boss = null } = {}) {
  return { state: { player: { hp, maxHp, score }, activeScaleStageId: stage, nuclearCooldownMs: cooldownMs, manualBoss: boss } };
}

test('sandbox has one finite normal HUD DOM and no W8 duplicate scale or lag HUD', () => {
  assert.equal((sandboxHtml.match(/id="ui"/g) ?? []).length, 1);
  assert.match(sandboxHtml, /id="hp-bar-container"/);
  assert.match(sandboxHtml, /id="atomic-cd-label"/);
  assert.match(sandboxHtml, /id="charge-bar-container"/);
  assert.doesNotMatch(sandboxHtml, /id="scale-line"/);
  assert.doesNotMatch(sandboxHtml, /id="hp-bar-lag"/);
  assert.doesNotMatch(sandboxHtml, /id="charge-bar"/);
});

test('finite HUD adapter formats official W8 HP and damage total without mutating runtime state', () => {
  let now = 0;
  const elements = createElements();
  const adapter = createFiniteGameplayHudAdapter({ elements, globalObject: { performance: { now: () => now } } });
  const current = snapshot({ hp: 150, maxHp: 200, score: 300 });
  const before = structuredClone(current);
  adapter.render({ gameplaySnapshot: current });
  assert.deepEqual(current, before);
  assert.equal(elements.score.textContent, '$3,000,000');
  assert.equal(elements.hp.textContent, 150);
  assert.equal(elements.hpFill.style.width, '75%');
  now = 1;
  adapter.render({ gameplaySnapshot: snapshot({ hp: 24, score: 301 }) });
  assert.equal(elements.score.textContent, '$3,010,000');
  assert.equal(elements.hpFill.style.background, 'linear-gradient(90deg, #ff0000, #ff3300)');
});

test('finite HUD adapter reproduces Atomic locked, ready, charging, charged, and cooldown presentation', () => {
  let now = 0;
  const elements = createElements();
  const adapter = createFiniteGameplayHudAdapter({ elements, globalObject: { performance: { now: () => now } } });
  adapter.render({ gameplaySnapshot: snapshot({ stage: 'TINY' }) });
  assert.equal(elements.atomicLabel.textContent, 'SCALE SANDBOX: LOCKED');
  adapter.render({ gameplaySnapshot: snapshot() });
  assert.equal(elements.atomicLabel.textContent, 'READY');
  now = 249;
  assert.equal(adapter.render({ gameplaySnapshot: snapshot(), chargeStartedAt: 0 }).chargeVisible, false);
  now = W7_NUCLEAR_CONTRACT.chargeThresholdMs + 251;
  assert.equal(adapter.render({ gameplaySnapshot: snapshot(), chargeStartedAt: 0, grounded: true }).chargeVisible, true);
  assert.equal(elements.charge.classList.contains('ready'), true);
  assert.equal(elements.chargeLabel.textContent, '\u26a0\ufe0f JUMP TO DETONATE! \u26a0\ufe0f');
  adapter.render({ gameplaySnapshot: snapshot(), chargeStartedAt: 0, grounded: false });
  assert.equal(elements.chargeLabel.textContent, '\u2622\ufe0f READY TO DROP!\u2622\ufe0f\n(RELEASE MOUSE) ');
  adapter.render({ gameplaySnapshot: snapshot({ cooldownMs: 1_001 }) });
  assert.equal(elements.atomicLabel.textContent, 'COOLDOWN (2s)');
});

test('finite HUD adapter applies finite Boss state and bars across Tiny, Mid, and Max', () => {
  let now = 0;
  const elements = createElements();
  const adapter = createFiniteGameplayHudAdapter({ elements, globalObject: { performance: { now: () => now } } });
  for (const stage of ['TINY', 'MID', 'MAX']) {
    const inactive = adapter.render({ gameplaySnapshot: snapshot({ stage }) });
    assert.equal(inactive.bossActive, false);
    assert.equal(elements.atomicLabel.textContent, stage === 'MAX' ? 'READY' : 'SCALE SANDBOX: LOCKED');
  }
  const activeBoss = { alive: true, hp: 100, maxHp: 100 };
  assert.equal(adapter.render({ gameplaySnapshot: snapshot({ boss: activeBoss }) }).bossActive, true);
  now = 100;
  adapter.render({ gameplaySnapshot: snapshot({ boss: { ...activeBoss, hp: 50 } }) });
  assert.equal(elements.bossFill.style.width, '50%');
  assert.equal(elements.bossDamage.style.width, '100%');
  now = 601;
  adapter.render({ gameplaySnapshot: snapshot({ boss: { ...activeBoss, hp: 50 } }) });
  assert.equal(elements.bossDamage.style.width, '50%');
  assert.equal(elements.bossTitle.textContent, '\u30ae\u30ac\u30fb\u30df\u30df\u30ba');
  assert.equal(adapter.render({ gameplaySnapshot: snapshot({ boss: { ...activeBoss, alive: false } }) }).bossActive, false);
});
