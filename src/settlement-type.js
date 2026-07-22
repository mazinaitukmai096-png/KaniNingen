export const SETTLEMENT_TYPES = Object.freeze({
  CITY: 'CITY',
  TOWN: 'TOWN',
  RURAL: 'RURAL',
});

const TOWN_TYPE_SETTLEMENT_TYPES = Object.freeze({
  capital: SETTLEMENT_TYPES.CITY,
  church_town: SETTLEMENT_TYPES.TOWN,
  school_town: SETTLEMENT_TYPES.TOWN,
  residential: SETTLEMENT_TYPES.RURAL,
  military: SETTLEMENT_TYPES.RURAL,
  suburb: SETTLEMENT_TYPES.RURAL,
});

export function getSettlementTypeForTownType(townType) {
  return TOWN_TYPE_SETTLEMENT_TYPES[townType] ?? null;
}
