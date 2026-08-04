export const SETTLEMENT_ROAD_GATEWAY_HANDOFF_SCHEMA =
  'settlement-road-gateway-handoff-1';

const GATEWAY_BINDING_MODES = new Set(['edge-owned', 'directional-shared-gateway']);

const requiredString = (value, label) => {
  if (typeof value !== 'string' || !value) throw new TypeError(`${label} is required`);
  return value;
};

export function validateSettlementRoadGatewayHandoff(handoff) {
  const errors = [];
  if (handoff?.schemaVersion !== SETTLEMENT_ROAD_GATEWAY_HANDOFF_SCHEMA) {
    errors.push('invalid gateway handoff schema');
  }
  for (const key of [
    'gatewayStableId',
    'connectivityEdgeId',
    'settlementId',
    'targetSettlementId',
    'arterialRoadStableId',
  ]) {
    if (typeof handoff?.[key] !== 'string' || !handoff[key]) {
      errors.push(`${key} is required`);
    }
  }
  if (handoff?.coordinateSpace !== 'logical-world-meters') {
    errors.push('gateway handoff must use logical-world-meters');
  }
  if (![handoff?.logicalPosition?.x, handoff?.logicalPosition?.z].every(Number.isFinite)) {
    errors.push('gateway handoff logical position is invalid');
  }
  if (handoff?.settlementRoadAuthority !== 'road-graph-v1') {
    errors.push('invalid Settlement road authority');
  }
  if (handoff?.majorRoadAuthority !== 'w8-canonical-major-road') {
    errors.push('invalid MAJOR road authority');
  }
  if (!GATEWAY_BINDING_MODES.has(handoff?.bindingMode)) {
    errors.push('invalid gateway binding mode');
  }
  if (typeof handoff?.gatewaySourceConnectivityEdgeId !== 'string'
    || !handoff.gatewaySourceConnectivityEdgeId) {
    errors.push('gatewaySourceConnectivityEdgeId is required');
  }
  return Object.freeze({ valid: errors.length === 0, errors: Object.freeze(errors) });
}

export function createSettlementRoadGatewayHandoff({
  gatewayStableId,
  connectivityEdgeId,
  settlementId,
  targetSettlementId,
  arterialRoadStableId,
  logicalPosition,
  bindingMode = 'edge-owned',
  gatewaySourceConnectivityEdgeId = connectivityEdgeId,
} = {}) {
  const handoff = Object.freeze({
    schemaVersion: SETTLEMENT_ROAD_GATEWAY_HANDOFF_SCHEMA,
    gatewayStableId: requiredString(gatewayStableId, 'gatewayStableId'),
    connectivityEdgeId: requiredString(connectivityEdgeId, 'connectivityEdgeId'),
    settlementId: requiredString(settlementId, 'settlementId'),
    targetSettlementId: requiredString(targetSettlementId, 'targetSettlementId'),
    arterialRoadStableId: requiredString(arterialRoadStableId, 'arterialRoadStableId'),
    coordinateSpace: 'logical-world-meters',
    logicalPosition: Object.freeze({
      x: logicalPosition?.x,
      z: logicalPosition?.z,
    }),
    settlementRoadAuthority: 'road-graph-v1',
    majorRoadAuthority: 'w8-canonical-major-road',
    bindingMode,
    gatewaySourceConnectivityEdgeId: requiredString(
      gatewaySourceConnectivityEdgeId,
      'gatewaySourceConnectivityEdgeId',
    ),
  });
  const validation = validateSettlementRoadGatewayHandoff(handoff);
  if (!validation.valid) {
    throw new TypeError(`invalid Settlement road gateway handoff: ${validation.errors.join('; ')}`);
  }
  return handoff;
}

export function resolveSettlementRoadGatewayHandoff({
  handoffs = [],
  connectivityEdgeId,
  settlementId,
} = {}) {
  if (!Array.isArray(handoffs)) throw new TypeError('gateway handoffs must be an array');
  requiredString(connectivityEdgeId, 'connectivityEdgeId');
  requiredString(settlementId, 'settlementId');
  const matches = handoffs.filter(handoff => (
    handoff?.connectivityEdgeId === connectivityEdgeId
      && handoff?.settlementId === settlementId
  ));
  if (matches.length > 1) {
    throw new Error(`duplicate Settlement road gateway handoff: ${connectivityEdgeId}:${settlementId}`);
  }
  if (matches.length === 0) return null;
  const validation = validateSettlementRoadGatewayHandoff(matches[0]);
  if (!validation.valid) {
    throw new TypeError(`invalid Settlement road gateway handoff: ${validation.errors.join('; ')}`);
  }
  return matches[0];
}

export function resolveDirectionalSettlementRoadGatewayHandoff({
  handoffs = [],
  connectivityEdgeId,
  settlementId,
  targetSettlementId,
  settlementCenter,
  targetCenter,
} = {}) {
  if (!Array.isArray(handoffs)) throw new TypeError('gateway handoffs must be an array');
  requiredString(connectivityEdgeId, 'connectivityEdgeId');
  requiredString(settlementId, 'settlementId');
  requiredString(targetSettlementId, 'targetSettlementId');
  if (![settlementCenter?.x, settlementCenter?.z, targetCenter?.x, targetCenter?.z]
    .every(Number.isFinite)) {
    throw new TypeError('Settlement and target centers are required');
  }
  const targetAngle = Math.atan2(
    targetCenter.z - settlementCenter.z,
    targetCenter.x - settlementCenter.x,
  );
  const candidates = handoffs.filter(handoff => handoff?.settlementId === settlementId)
    .map(handoff => {
      const angle = Math.atan2(
        handoff.logicalPosition.z - settlementCenter.z,
        handoff.logicalPosition.x - settlementCenter.x,
      );
      let angleError = Math.abs(angle - targetAngle) % (Math.PI * 2);
      if (angleError > Math.PI) angleError = Math.PI * 2 - angleError;
      return { handoff, angleError };
    })
    .sort((left, right) => (
      left.angleError - right.angleError
        || left.handoff.gatewayStableId.localeCompare(right.handoff.gatewayStableId)
    ));
  const selected = candidates[0]?.handoff;
  if (!selected) return null;
  return createSettlementRoadGatewayHandoff({
    gatewayStableId: selected.gatewayStableId,
    connectivityEdgeId,
    settlementId,
    targetSettlementId,
    arterialRoadStableId: selected.arterialRoadStableId,
    logicalPosition: selected.logicalPosition,
    bindingMode: 'directional-shared-gateway',
    gatewaySourceConnectivityEdgeId: selected.connectivityEdgeId,
  });
}
