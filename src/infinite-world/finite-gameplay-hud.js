import { W7_NUCLEAR_CONTRACT } from './gameplay-contract.js';

const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
const finiteDamageTotal = score => `$${(Number(score) * 10_000).toLocaleString('en-US')}`;
const finiteNow = globalObject => globalObject?.performance?.now?.() ?? Date.now();

export const FINITE_HUD_CHARGE_DELAY_MS = 250;

/** Read-only bridge from the W8 runtime snapshot to the finite gameplay HUD. */
export function createFiniteGameplayHudAdapter({ elements, globalObject = globalThis } = {}) {
  if (!elements) throw new TypeError('Finite gameplay HUD requires elements');
  const boss = { lastHpPercent: 100, damagePercent: 100, damageTargetPercent: 100, damageDelayUntil: 0 };

  const setChargeLabel = ({ text, color, opacity }) => {
    if (!elements.chargeLabel) return;
    elements.chargeLabel.textContent = text;
    if (elements.chargeLabel.style) {
      elements.chargeLabel.style.color = color;
      elements.chargeLabel.style.opacity = opacity;
    }
  };
  const resetBoss = () => {
    boss.lastHpPercent = 100;
    boss.damagePercent = 100;
    boss.damageTargetPercent = 100;
    boss.damageDelayUntil = 0;
  };

  function render({ gameplaySnapshot, chargeStartedAt = null, grounded = true, now = finiteNow(globalObject) } = {}) {
    const runtimeState = gameplaySnapshot?.state;
    if (!runtimeState?.player) throw new TypeError('Finite gameplay HUD requires a runtime player snapshot');
    const player = runtimeState.player;
    const hpPercent = player.maxHp > 0 ? clamp(player.hp / player.maxHp * 100, 0, 100) : 0;
    if (elements.score) elements.score.textContent = finiteDamageTotal(player.score);
    if (elements.hp) elements.hp.textContent = Math.max(0, Math.ceil(player.hp));
    if (elements.hpFill?.style) {
      elements.hpFill.style.width = `${hpPercent}%`;
      if (hpPercent < 25) {
        elements.hpFill.style.background = 'linear-gradient(90deg, #ff0000, #ff3300)';
        elements.hpFill.style.boxShadow = '0 0 8px rgba(255,0,0,0.8) inset';
      } else {
        elements.hpFill.style.background = 'linear-gradient(90deg, #39ff14, #00e5ff)';
        elements.hpFill.style.boxShadow = '0 0 8px rgba(0,255,100,0.8) inset';
      }
    }

    const cooldownMs = Math.max(0, runtimeState.nuclearCooldownMs ?? 0);
    const nuclearAllowed = runtimeState.activeScaleStageId === W7_NUCLEAR_CONTRACT.allowedScaleStageId;
    if (elements.atomicLabel) {
      if (!nuclearAllowed) {
        elements.atomicLabel.textContent = 'SCALE SANDBOX: LOCKED';
        elements.atomicLabel.style.color = '#888888';
      } else if (cooldownMs > 0) {
        elements.atomicLabel.textContent = `COOLDOWN (${Math.ceil(cooldownMs / 1000)}s)`;
        elements.atomicLabel.style.color = '#ff3300';
      } else {
        elements.atomicLabel.textContent = 'READY';
        elements.atomicLabel.style.color = '#39ff14';
      }
    }

    const activeBoss = runtimeState.manualBoss?.alive === true ? runtimeState.manualBoss : null;
    if (activeBoss) {
      const hp = activeBoss.maxHp > 0 ? clamp(activeBoss.hp / activeBoss.maxHp * 100, 0, 100) : 0;
      if (hp > boss.lastHpPercent) {
        boss.damagePercent = hp;
        boss.damageTargetPercent = hp;
      } else if (hp < boss.lastHpPercent) {
        boss.damageTargetPercent = hp;
        boss.damageDelayUntil = now + 500;
      }
      if (now >= boss.damageDelayUntil) boss.damagePercent = boss.damageTargetPercent;
      boss.lastHpPercent = hp;
      if (elements.bossFill?.style) elements.bossFill.style.width = `${hp}%`;
      if (elements.bossDamage?.style) elements.bossDamage.style.width = `${boss.damagePercent}%`;
      if (elements.bossTitle) elements.bossTitle.textContent = '\u30ae\u30ac\u30fb\u30df\u30df\u30ba';
    } else resetBoss();

    const charging = chargeStartedAt !== null && nuclearAllowed && cooldownMs <= 0;
    const chargeElapsedMs = charging ? Math.max(0, now - chargeStartedAt) : 0;
    const chargeVisible = charging && chargeElapsedMs >= FINITE_HUD_CHARGE_DELAY_MS;
    if (elements.chargeFill?.style) {
      elements.chargeFill.style.width = `${clamp(chargeElapsedMs / W7_NUCLEAR_CONTRACT.chargeThresholdMs * 100, 0, 100)}%`;
    }
    if (elements.charge?.classList) {
      elements.charge.classList.toggle('ready', charging && chargeElapsedMs > W7_NUCLEAR_CONTRACT.chargeThresholdMs);
    }
    if (charging && chargeElapsedMs > W7_NUCLEAR_CONTRACT.chargeThresholdMs) {
      setChargeLabel(grounded
        ? { text: '\u26a0\ufe0f JUMP TO DETONATE! \u26a0\ufe0f', color: '#ff3300', opacity: Math.sin(now * 0.015) > 0 ? '1.0' : '0.2' }
        : { text: '\u2622\ufe0f READY TO DROP!\u2622\ufe0f\n(RELEASE MOUSE) ', color: '#39ff14', opacity: Math.sin(now * 0.03) > 0 ? '1.0' : '0.4' });
    } else setChargeLabel({ text: 'ATOMIC CHARGING...', color: '#ffdd88', opacity: '1.0' });

    return Object.freeze({ bossActive: activeBoss !== null, nuclearAllowed, chargeVisible, charging, damageTotal: finiteDamageTotal(player.score) });
  }

  return Object.freeze({ render });
}
