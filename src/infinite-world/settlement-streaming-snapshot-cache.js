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
      presentationRevision,
      renderDistanceRevision,
      stateRevision,
      materialize,
    } = {}) {
      const frame = nonNegativeInteger(frameSequence, 'frameSequence');
      const presentation = nonNegativeInteger(
        presentationRevision,
        'presentationRevision',
      );
      const renderDistance = nonNegativeInteger(
        renderDistanceRevision,
        'renderDistanceRevision',
      );
      const state = nonNegativeInteger(stateRevision, 'stateRevision');
      if (typeof materialize !== 'function') throw new TypeError('materialize is required');
      counts.requests += 1;
      if (entry
        && entry.frameSequence === frame
        && entry.presentationRevision === presentation
        && entry.renderDistanceRevision === renderDistance
        && entry.stateRevision === state) {
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
        frameSequence: frame,
        presentationRevision: presentation,
        renderDistanceRevision: renderDistance,
        stateRevision: state,
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
        presentationRevision: entry?.presentationRevision ?? null,
        renderDistanceRevision: entry?.renderDistanceRevision ?? null,
        stateRevision: entry?.stateRevision ?? null,
        counts: Object.freeze({ ...counts }),
      });
    },
    get lastReadReused() { return lastReadReused; },
  });
}

export function isSettlementStreamingSnapshotCurrent(snapshot, {
  presentationRevision,
  renderDistanceRevision,
  stateRevision,
} = {}) {
  if (!snapshot || typeof snapshot !== 'object') return false;
  return snapshot.presentationRevision === presentationRevision
    && snapshot.renderDistanceRevision === renderDistanceRevision
    && snapshot.stateRevision === stateRevision;
}
