function normalizeError(error) {
  return Object.freeze({
    name: error?.name ?? 'Error',
    message: error?.message ?? String(error),
    stack: typeof error?.stack === 'string' ? error.stack : null,
  });
}

export function createRuntimeFaultLedger({ capacity = 64, clock = () => Date.now() } = {}) {
  if (!Number.isSafeInteger(capacity) || capacity <= 0) {
    throw new RangeError('runtime fault ledger capacity must be a positive safe integer');
  }
  if (typeof clock !== 'function') throw new TypeError('runtime fault ledger clock is required');

  const records = new Array(capacity);
  const quarantinedSubsystems = new Set();
  let start = 0;
  let count = 0;
  let sequence = 0;

  const record = ({
    subsystem,
    stage,
    error,
    action,
    frameSequence = null,
    generation = null,
    ownerKey = null,
    quarantine = false,
  }) => {
    if (typeof subsystem !== 'string' || !subsystem
      || typeof stage !== 'string' || !stage
      || typeof action !== 'string' || !action) {
      throw new TypeError('runtime fault records require subsystem, stage, and action');
    }
    const entry = Object.freeze({
      schemaVersion: 'runtime-fault-record-1',
      sequence: ++sequence,
      atMs: clock(),
      subsystem,
      stage,
      frameSequence: Number.isSafeInteger(frameSequence) ? frameSequence : null,
      generation: Number.isSafeInteger(generation) ? generation : null,
      ownerKey: typeof ownerKey === 'string' && ownerKey ? ownerKey : null,
      action,
      error: normalizeError(error),
    });
    const writeIndex = (start + count) % capacity;
    records[writeIndex] = entry;
    if (count < capacity) count += 1;
    else start = (start + 1) % capacity;
    if (quarantine) quarantinedSubsystems.add(subsystem);
    return entry;
  };

  return Object.freeze({
    record,
    isQuarantined: subsystem => quarantinedSubsystems.has(subsystem),
    runObserver({ subsystem, stage, frameSequence, generation, ownerKey, action = 'observer-quarantined' }, callback, fallback = null) {
      if (typeof callback !== 'function') throw new TypeError('runtime observer callback is required');
      if (quarantinedSubsystems.has(subsystem)) return fallback;
      try {
        return callback();
      } catch (error) {
        record({
          subsystem,
          stage,
          error,
          action,
          frameSequence,
          generation,
          ownerKey,
          quarantine: true,
        });
        return fallback;
      }
    },
    snapshot() {
      const ordered = [];
      for (let index = 0; index < count; index += 1) {
        ordered.push(records[(start + index) % capacity]);
      }
      return Object.freeze({
        schemaVersion: 'runtime-fault-ledger-1',
        capacity,
        count,
        totalCount: sequence,
        quarantinedSubsystems: Object.freeze([...quarantinedSubsystems].sort()),
        records: Object.freeze(ordered),
      });
    },
  });
}
