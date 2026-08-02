import { logicalWorldToOwnedChunk } from './chunk-coordinates.js';

export const NATURAL_COVERAGE_KEY_SCHEMA = 'natural-coverage-key-1';
export const WORLD_STREAMING_PUBLICATION_CONTEXT_SCHEMA =
  'world-streaming-publication-context-1';
export const NATURAL_RESOURCE_BAND_REVISION = 1;

const q6 = value => Math.round(value * 1e6) / 1e6;

function nonNegativeSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function finite(value, label) {
  if (!Number.isFinite(value)) throw new TypeError(`${label} must be finite`);
  return value;
}

function nonEmptyString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function nullableString(value, label) {
  if (value !== null && (typeof value !== 'string' || value.length === 0)) {
    throw new TypeError(`${label} must be null or a non-empty string`);
  }
  return value;
}

function stringOrNull(value, label) {
  if (value !== null && typeof value !== 'string') {
    throw new TypeError(`${label} must be null or a string`);
  }
  return value;
}

export function resolveNaturalCorridorEndpoint({
  player,
  velocity = { x: 0, z: 0 },
  velocityPrefetch,
} = {}) {
  const playerX = finite(player?.x, 'player.x');
  const playerZ = finite(player?.z, 'player.z');
  const velocityX = finite(velocity?.x, 'velocity.x');
  const velocityZ = finite(velocity?.z, 'velocity.z');
  const enabled = velocityPrefetch?.enabled === true;
  const leadSeconds = enabled
    ? finite(velocityPrefetch.leadSeconds, 'velocityPrefetch.leadSeconds') : 0;
  const maximumDistanceMeters = enabled
    ? finite(
      velocityPrefetch.maximumDistanceMeters,
      'velocityPrefetch.maximumDistanceMeters',
    ) : 0;
  if (leadSeconds < 0 || maximumDistanceMeters < 0) {
    throw new RangeError('Natural velocity prefetch bounds must be non-negative');
  }
  const speedMetersPerSecond = Math.hypot(velocityX, velocityZ);
  const distanceMeters = Math.min(
    speedMetersPerSecond * leadSeconds,
    maximumDistanceMeters,
  );
  const durationSeconds = speedMetersPerSecond > 0
    ? distanceMeters / speedMetersPerSecond : 0;
  return Object.freeze({
    x: q6(playerX + velocityX * durationSeconds),
    z: q6(playerZ + velocityZ * durationSeconds),
  });
}

export function createNaturalCoverageKey({
  policyRegistryVersion,
  renderDistancePreset,
  player,
  velocity = { x: 0, z: 0 },
  velocityPrefetch,
  naturalResourceBandRevision = NATURAL_RESOURCE_BAND_REVISION,
  settlementContentHash = null,
  runtimeCoverageSignature,
} = {}) {
  const registryVersion = nonNegativeSafeInteger(
    policyRegistryVersion,
    'policyRegistryVersion',
  );
  const resourceBandRevision = nonNegativeSafeInteger(
    naturalResourceBandRevision,
    'naturalResourceBandRevision',
  );
  const preset = nonEmptyString(renderDistancePreset, 'renderDistancePreset');
  const endpoint = resolveNaturalCorridorEndpoint({ player, velocity, velocityPrefetch });
  const playerOwnerKey = logicalWorldToOwnedChunk(
    finite(player?.x, 'player.x'),
    finite(player?.z, 'player.z'),
  ).key;
  const corridorEndpointOwnerKey = logicalWorldToOwnedChunk(endpoint.x, endpoint.z).key;
  const settlementHash = nullableString(settlementContentHash, 'settlementContentHash');
  const runtimeSignature = nonEmptyString(
    runtimeCoverageSignature,
    'runtimeCoverageSignature',
  );
  // This signature contains only scalar invalidation inputs. It deliberately
  // never materializes owner arrays or presentation state.
  const signature = [
    registryVersion,
    preset,
    playerOwnerKey,
    corridorEndpointOwnerKey,
    resourceBandRevision,
    settlementHash ?? '-',
    runtimeSignature,
  ].join('|');
  return Object.freeze({
    schemaVersion: NATURAL_COVERAGE_KEY_SCHEMA,
    policyRegistryVersion: registryVersion,
    renderDistancePreset: preset,
    playerOwnerKey,
    corridorEndpointOwnerKey,
    naturalResourceBandRevision: resourceBandRevision,
    settlementContentHash: settlementHash,
    runtimeCoverageSignature: runtimeSignature,
    signature,
  });
}

export function sameNaturalCoverageKey(left, right) {
  return left?.schemaVersion === NATURAL_COVERAGE_KEY_SCHEMA
    && right?.schemaVersion === NATURAL_COVERAGE_KEY_SCHEMA
    && left.signature === right.signature;
}

export function createWorldStreamingPublicationContext({
  sequence,
  generatedAtMs,
  stateRevision = 0,
  destructionRevision = null,
  originGeneration = 0,
} = {}) {
  const publicationSequence = nonNegativeSafeInteger(sequence, 'sequence');
  if (publicationSequence < 1) {
    throw new RangeError('sequence must be a positive safe integer');
  }
  return Object.freeze({
    schemaVersion: WORLD_STREAMING_PUBLICATION_CONTEXT_SCHEMA,
    sequence: publicationSequence,
    generatedAtMs: finite(generatedAtMs, 'generatedAtMs'),
    stateRevision: nonNegativeSafeInteger(stateRevision, 'stateRevision'),
    destructionRevision: stringOrNull(destructionRevision, 'destructionRevision'),
    originGeneration: nonNegativeSafeInteger(originGeneration, 'originGeneration'),
  });
}
