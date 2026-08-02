import {
  SETTLEMENT_BUILDING_COMPOSITIONS,
  SETTLEMENT_BUILDING_TYPES,
  selectSettlementBuildingType,
} from '../settlement-building-visuals.js';

const EPSILON = 1e-9;

function stableCompositionHash(parts) {
  const text = parts.join('|');
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/**
 * W8-only cached view of the protected finite-World building type sequence.
 * Selection authority remains in settlement-building-visuals.js so Infinite
 * World cannot drift from the finite composition or deterministic tie-breaks.
 */
export function createW8SettlementBuildingTypeSelector({ settlementType, townId }) {
  const composition = SETTLEMENT_BUILDING_COMPOSITIONS[settlementType];
  const sequence = [];
  const counts = composition
    ? Object.fromEntries(SETTLEMENT_BUILDING_TYPES.map(type => [type, 0])) : null;
  return buildingIndex => {
    if (!composition || !Number.isInteger(buildingIndex) || buildingIndex < 1) {
      return selectSettlementBuildingType({ settlementType, townId, buildingIndex });
    }
    while (sequence.length < buildingIndex) {
      const sequenceIndex = sequence.length + 1;
      let selectedType = SETTLEMENT_BUILDING_TYPES[0];
      let selectedScore = -Infinity;
      let selectedTie = -Infinity;
      for (const type of SETTLEMENT_BUILDING_TYPES) {
        const score = sequenceIndex * composition[type] / 100 - counts[type];
        const tie = stableCompositionHash([
          townId,
          settlementType,
          sequenceIndex,
          type,
          'composition',
        ]);
        if (score > selectedScore + EPSILON
          || (Math.abs(score - selectedScore) <= EPSILON && tie > selectedTie)) {
          selectedType = type;
          selectedScore = score;
          selectedTie = tie;
        }
      }
      counts[selectedType] += 1;
      sequence.push(selectedType);
    }
    return sequence[buildingIndex - 1];
  };
}
