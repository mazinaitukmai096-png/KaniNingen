import { selectSettlementBuildingType } from '../settlement-building-visuals.js';

/**
 * W8-only cached view of the protected finite-World building type sequence.
 * Selection authority remains in settlement-building-visuals.js so Infinite
 * World cannot drift from the finite composition or deterministic tie-breaks.
 */
export function createW8SettlementBuildingTypeSelector({ settlementType, townId }) {
  const sequence = [];
  return buildingIndex => {
    if (!Number.isInteger(buildingIndex) || buildingIndex < 1) {
      return selectSettlementBuildingType({ settlementType, townId, buildingIndex });
    }
    while (sequence.length < buildingIndex) {
      const nextBuildingIndex = sequence.length + 1;
      sequence.push(selectSettlementBuildingType({
        settlementType,
        townId,
        buildingIndex: nextBuildingIndex,
      }));
    }
    return sequence[buildingIndex - 1];
  };
}
