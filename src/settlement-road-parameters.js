import { SETTLEMENT_TYPES } from './settlement-type.js';

const ROAD_PATTERNS = new Set(['GRID', 'SEMI_GRID', 'ORGANIC']);
const ROAD_KINDS = new Set(['MAJOR', 'LOCAL', 'ALLEY', 'START_APPROACH']);
const REQUIRED_KEYS = [
  'settlementType',
  'roadPattern',
  'majorWidth',
  'localWidth',
  'alleyWidth',
  'startApproachWidth',
  'localSpineCount',
  'localBranchCount',
  'alleyCount',
  'junctionSpacingMultiplier',
  'preferredBranchAngleMin',
  'preferredBranchAngleMax',
  'hardBranchAngleMin',
  'hardBranchAngleMax',
  'localCurvature',
  'alleyCurvature',
  'majorCurvature',
  'gridBias',
  'deadEndBias',
  'densityMultiplier',
  'centerConnectionBias',
  'outerRoadBias',
  'roadLengthMultiplier',
  'sampleSpacing',
  'roadSurfaceOverlap',
];

function freezeParameters(parameters) {
  return Object.freeze(parameters);
}

export const SETTLEMENT_ROAD_PARAMETERS = Object.freeze({
  [SETTLEMENT_TYPES.CITY]: freezeParameters({
    settlementType: SETTLEMENT_TYPES.CITY,
    roadPattern: 'GRID',
    majorWidth: 105,
    localWidth: 74,
    alleyWidth: 48,
    startApproachWidth: 60,
    localSpineCount: 2,
    localBranchCount: 6,
    alleyCount: 2,
    junctionSpacingMultiplier: 1.0,
    preferredBranchAngleMin: 85,
    preferredBranchAngleMax: 95,
    hardBranchAngleMin: 75,
    hardBranchAngleMax: 105,
    localCurvature: 0.03,
    alleyCurvature: 0.05,
    majorCurvature: 0.02,
    gridBias: 0.92,
    deadEndBias: 0.18,
    densityMultiplier: 1.25,
    centerConnectionBias: 0.9,
    outerRoadBias: 0.6,
    roadLengthMultiplier: 1.02,
    sampleSpacing: 48,
    roadSurfaceOverlap: 0,
  }),
  [SETTLEMENT_TYPES.TOWN]: freezeParameters({
    settlementType: SETTLEMENT_TYPES.TOWN,
    roadPattern: 'SEMI_GRID',
    majorWidth: 95,
    localWidth: 66,
    alleyWidth: 45,
    startApproachWidth: 57,
    localSpineCount: 1,
    localBranchCount: 5,
    alleyCount: 1,
    junctionSpacingMultiplier: 1.1,
    preferredBranchAngleMin: 75,
    preferredBranchAngleMax: 105,
    hardBranchAngleMin: 60,
    hardBranchAngleMax: 120,
    localCurvature: 0.07,
    alleyCurvature: 0.1,
    majorCurvature: 0.04,
    gridBias: 0.58,
    deadEndBias: 0.35,
    densityMultiplier: 1.02,
    centerConnectionBias: 0.65,
    outerRoadBias: 0.65,
    roadLengthMultiplier: 1.0,
    sampleSpacing: 52,
    roadSurfaceOverlap: 0,
  }),
  [SETTLEMENT_TYPES.RURAL]: freezeParameters({
    settlementType: SETTLEMENT_TYPES.RURAL,
    roadPattern: 'ORGANIC',
    majorWidth: 85,
    localWidth: 55,
    alleyWidth: 40,
    startApproachWidth: 52,
    localSpineCount: 1,
    localBranchCount: 3,
    alleyCount: 3,
    junctionSpacingMultiplier: 1.4,
    preferredBranchAngleMin: 60,
    preferredBranchAngleMax: 120,
    hardBranchAngleMin: 50,
    hardBranchAngleMax: 130,
    localCurvature: 0.13,
    alleyCurvature: 0.16,
    majorCurvature: 0.07,
    gridBias: 0.12,
    deadEndBias: 0.68,
    densityMultiplier: 0.68,
    centerConnectionBias: 0.38,
    outerRoadBias: 0.85,
    roadLengthMultiplier: 0.92,
    sampleSpacing: 60,
    roadSurfaceOverlap: 0,
  }),
});

export function getSettlementRoadParameters(settlementType) {
  return SETTLEMENT_ROAD_PARAMETERS[settlementType] ?? null;
}

export function validateSettlementRoadParameters(parameters) {
  if (!parameters || typeof parameters !== 'object') {
    throw new TypeError('Settlement road parameters must be an object.');
  }

  for (const key of REQUIRED_KEYS) {
    if (!(key in parameters)) throw new TypeError(`Missing settlement road parameter: ${key}`);
  }

  if (!Object.values(SETTLEMENT_TYPES).includes(parameters.settlementType)) {
    throw new RangeError('Settlement road parameters require a known settlementType.');
  }
  if (!ROAD_PATTERNS.has(parameters.roadPattern)) {
    throw new RangeError('Settlement road parameters require a known roadPattern.');
  }

  const expectedPattern = {
    [SETTLEMENT_TYPES.CITY]: 'GRID',
    [SETTLEMENT_TYPES.TOWN]: 'SEMI_GRID',
    [SETTLEMENT_TYPES.RURAL]: 'ORGANIC',
  }[parameters.settlementType];
  if (parameters.roadPattern !== expectedPattern) {
    throw new RangeError('roadPattern must match settlementType.');
  }

  const positiveNumbers = [
    'majorWidth', 'localWidth', 'alleyWidth', 'startApproachWidth',
    'junctionSpacingMultiplier', 'densityMultiplier', 'roadLengthMultiplier', 'sampleSpacing',
  ];
  for (const key of positiveNumbers) {
    if (!Number.isFinite(parameters[key]) || parameters[key] <= 0) {
      throw new RangeError(`${key} must be a positive finite number.`);
    }
  }

  if (!(parameters.majorWidth >= parameters.localWidth && parameters.localWidth >= parameters.alleyWidth)) {
    throw new RangeError('Road widths must satisfy majorWidth >= localWidth >= alleyWidth.');
  }

  for (const key of ['localSpineCount', 'localBranchCount', 'alleyCount']) {
    if (!Number.isInteger(parameters[key]) || parameters[key] < 1) {
      throw new RangeError(`${key} must be a positive integer.`);
    }
  }

  const angles = [
    'preferredBranchAngleMin', 'preferredBranchAngleMax', 'hardBranchAngleMin', 'hardBranchAngleMax',
  ];
  for (const key of angles) {
    if (!Number.isFinite(parameters[key]) || parameters[key] < 0 || parameters[key] > 180) {
      throw new RangeError(`${key} must be within 0..180.`);
    }
  }
  if (!(parameters.preferredBranchAngleMin < parameters.preferredBranchAngleMax)) {
    throw new RangeError('Preferred branch angle range must be ordered.');
  }
  if (!(parameters.hardBranchAngleMin < parameters.hardBranchAngleMax)) {
    throw new RangeError('Hard branch angle range must be ordered.');
  }
  if (parameters.hardBranchAngleMin > parameters.preferredBranchAngleMin
    || parameters.hardBranchAngleMax < parameters.preferredBranchAngleMax) {
    throw new RangeError('Hard branch angle range must include the preferred range.');
  }

  for (const key of ['localCurvature', 'alleyCurvature', 'majorCurvature', 'gridBias', 'deadEndBias', 'centerConnectionBias', 'outerRoadBias']) {
    if (!Number.isFinite(parameters[key]) || parameters[key] < 0 || parameters[key] > 1) {
      throw new RangeError(`${key} must be within 0..1.`);
    }
  }
  if (!Number.isFinite(parameters.roadSurfaceOverlap) || parameters.roadSurfaceOverlap < 0) {
    throw new RangeError('roadSurfaceOverlap must be a non-negative finite number.');
  }

  return true;
}

export function getRoadKindParameters(settlementType, roadKind) {
  if (!ROAD_KINDS.has(roadKind)) return null;

  const parameters = getSettlementRoadParameters(settlementType);
  if (!parameters) return null;

  const kinds = {
    MAJOR: { width: parameters.majorWidth, curvature: parameters.majorCurvature },
    LOCAL: { width: parameters.localWidth, curvature: parameters.localCurvature },
    ALLEY: { width: parameters.alleyWidth, curvature: parameters.alleyCurvature },
    START_APPROACH: { width: parameters.startApproachWidth, curvature: 0 },
  };
  return Object.freeze(kinds[roadKind]);
}

for (const parameters of Object.values(SETTLEMENT_ROAD_PARAMETERS)) {
  validateSettlementRoadParameters(parameters);
}
