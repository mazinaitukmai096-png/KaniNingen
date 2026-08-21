function nonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

export function createSettlementStreamingSnapshotCache() {
  let entry = null;
  let lastReadReused = false;
  const counts = {
    requests: 0,
    materialized: 0,
    reused: 0,
  };

  return Object.freeze({
    read({
      frameSequence,
      generationEpoch = null,
      presentationRevision = null,
      renderDistanceRevision,
      featureDamageRevision = null,
      stateRevision = null,
      ownerRevision = 0,
      materialize,
    } = {}) {
      const frame = nonNegativeInteger(frameSequence, 'frameSequence');
      const generation = nonNegativeInteger(
        generationEpoch ?? presentationRevision,
        'generationEpoch',
      );
      const renderDistance = nonNegativeInteger(
        renderDistanceRevision,
        'renderDistanceRevision',
      );
      const featureDamage = nonNegativeInteger(
        featureDamageRevision ?? stateRevision,
        'featureDamageRevision',
      );
      const owner = nonNegativeInteger(ownerRevision, 'ownerRevision');
      if (typeof materialize !== 'function') throw new TypeError('materialize is required');
      counts.requests += 1;
      if (entry
        && entry.generationEpoch === generation
        && entry.renderDistanceRevision === renderDistance
        && entry.featureDamageRevision === featureDamage
        && entry.ownerRevision === owner) {
        counts.reused += 1;
        lastReadReused = true;
        return entry.value;
      }
      lastReadReused = false;
      const value = materialize();
      if (!Object.isFrozen(value)) {
        throw new Error('Settlement streaming snapshot must be immutable');
      }
      entry = Object.freeze({
        // frameSequence is evidence about when the immutable snapshot was
        // first materialized. It is deliberately not part of the cache key:
        // generation, render-distance, canonical-owner and feature-damage
        // revisions are the complete content-affecting inputs.
        frameSequence: frame,
        generationEpoch: generation,
        renderDistanceRevision: renderDistance,
        featureDamageRevision: featureDamage,
        ownerRevision: owner,
        value,
      });
      counts.materialized += 1;
      return value;
    },
    invalidate() {
      entry = null;
      lastReadReused = false;
    },
    snapshot() {
      return Object.freeze({
        schemaVersion: 'settlement-streaming-snapshot-cache-1',
        cached: entry !== null,
        frameSequence: entry?.frameSequence ?? null,
        generationEpoch: entry?.generationEpoch ?? null,
        // Compatibility diagnostic aliases; cache identity is named after
        // the exact content source above rather than the general World state.
        presentationRevision: entry?.generationEpoch ?? null,
        renderDistanceRevision: entry?.renderDistanceRevision ?? null,
        featureDamageRevision: entry?.featureDamageRevision ?? null,
        stateRevision: entry?.featureDamageRevision ?? null,
        ownerRevision: entry?.ownerRevision ?? null,
        counts: Object.freeze({ ...counts }),
      });
    },
    get lastReadReused() { return lastReadReused; },
  });
}

export function isSettlementStreamingSnapshotCurrent(snapshot, {
  generationEpoch = null,
  presentationRevision = null,
  renderDistanceRevision,
  featureDamageRevision = null,
  stateRevision = null,
  ownerRevision = 0,
} = {}) {
  if (!snapshot || typeof snapshot !== 'object') return false;
  const generation = generationEpoch ?? presentationRevision;
  const featureDamage = featureDamageRevision ?? stateRevision;
  return (snapshot.generationEpoch ?? snapshot.presentationRevision) === generation
    && snapshot.renderDistanceRevision === renderDistanceRevision
    && (snapshot.featureDamageRevision ?? snapshot.stateRevision) === featureDamage
    && (snapshot.ownerRevision ?? 0) === ownerRevision;
}
