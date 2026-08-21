import {
  SETTLEMENT_BUILDING_COMPOSITIONS,
  SETTLEMENT_BUILDING_TYPES,
  selectSettlementBuildingType,
} from '../settlement-building-visuals.js';

const EPSILON = 1e-9;
const buildingGenerationCheckpointLeases = new Map();

export async function acquireW8SettlementBuildingGenerationCheckpoint({
  townId,
  checkpoint,
} = {}) {
  if (typeof townId !== 'string' || townId.length === 0) {
    throw new TypeError('Settlement Building checkpoint townId is required');
  }
  if (checkpoint !== null && typeof checkpoint !== 'function') {
    throw new TypeError('Settlement Building checkpoint must be a function or null');
  }
  let leaseState = buildingGenerationCheckpointLeases.get(townId);
  if (!leaseState) {
    leaseState = {
      active: null,
      pendingCount: 0,
      tail: Promise.resolve(),
    };
    buildingGenerationCheckpointLeases.set(townId, leaseState);
  }
  const previous = leaseState.tail;
  let releaseTurn;
  leaseState.tail = new Promise(resolve => { releaseTurn = resolve; });
  leaseState.pendingCount += 1;
  await previous;
  const registration = Object.freeze({ checkpoint });
  leaseState.active = registration;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (leaseState.active === registration) leaseState.active = null;
    leaseState.pendingCount -= 1;
    releaseTurn();
    if (leaseState.pendingCount === 0
      && buildingGenerationCheckpointLeases.get(townId) === leaseState) {
      buildingGenerationCheckpointLeases.delete(townId);
    }
  };
}

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
  const generationCheckpoint = buildingGenerationCheckpointLeases
    .get(townId)?.active?.checkpoint ?? null;
  const sequence = [];
  const counts = composition
    ? Object.fromEntries(SETTLEMENT_BUILDING_TYPES.map(type => [type, 0])) : null;
  return buildingIndex => {
    generationCheckpoint?.({
      site: `cooperative-migrated-settlement-building:${townId}:${buildingIndex}`,
    });
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
