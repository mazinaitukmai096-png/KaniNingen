export const PRESENTATION_MANIFEST_CACHE_SCHEMA = 'presentation-manifest-cache-1';

function assertPositiveCapacity(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError('presentation manifest cache capacity must be a positive safe integer');
  }
}

function assertKeyPart(value, name) {
  if (typeof value !== 'string' || !value) throw new TypeError(`${name} is required`);
}

function defaultCanonicalIdentity(canonical) {
  const chunkId = canonical?.chunkId;
  const contentHash = canonical?.contentHash ?? canonical?.sourceChunkData?.contentHash;
  if (typeof chunkId !== 'string' || typeof contentHash !== 'string') {
    throw new TypeError('canonical source must expose chunkId and contentHash');
  }
  return `${chunkId}:${contentHash}`;
}

/**
 * Stores immutable manifests derived from canonical owner sources. Mutable
 * gameplay state is deliberately applied after lookup, on every request.
 */
export function createPresentationManifestCache({
  capacity = 320,
  canonicalIdentity = defaultCanonicalIdentity,
} = {}) {
  assertPositiveCapacity(capacity);
  if (typeof canonicalIdentity !== 'function') {
    throw new TypeError('presentation manifest canonicalIdentity is required');
  }

  const entries = new Map();
  let closed = false;
  const counts = {
    requests: 0,
    hits: 0,
    misses: 0,
    pendingDedupeHits: 0,
    builds: 0,
    completed: 0,
    failures: 0,
    evictions: 0,
    stateApplications: 0,
  };

  const touch = (key, entry) => {
    entries.delete(key);
    entries.set(key, entry);
  };
  const trim = protectedKey => {
    while (entries.size > capacity) {
      const candidate = [...entries].find(([key, entry]) => (
        key !== protectedKey && entry.pending === false
      ));
      if (!candidate) break;
      entries.delete(candidate[0]);
      counts.evictions += 1;
    }
  };

  const getOrCreate = async ({
    manifestKind,
    ownerKey,
    sourceRevision,
    loadCanonical,
    build,
    applyState = value => value,
  } = {}) => {
    if (closed) throw new Error('presentation manifest cache is closed');
    assertKeyPart(manifestKind, 'manifestKind');
    assertKeyPart(ownerKey, 'manifest ownerKey');
    assertKeyPart(sourceRevision, 'manifest sourceRevision');
    if (typeof loadCanonical !== 'function') throw new TypeError('loadCanonical is required');
    if (typeof build !== 'function') throw new TypeError('manifest build is required');
    if (typeof applyState !== 'function') throw new TypeError('manifest applyState is required');

    counts.requests += 1;
    const canonical = await loadCanonical();
    const identity = canonicalIdentity(canonical);
    assertKeyPart(identity, 'canonical identity');
    const key = `${manifestKind}\u0000${sourceRevision}\u0000${ownerKey}\u0000${identity}`;
    let entry = entries.get(key);
    if (entry) {
      counts.hits += 1;
      if (entry.pending) counts.pendingDedupeHits += 1;
      touch(key, entry);
    } else {
      counts.misses += 1;
      counts.builds += 1;
      entry = { pending: true, promise: null };
      entry.promise = Promise.resolve().then(() => build(canonical)).then(manifest => {
          if (manifest === null || manifest === undefined) {
            throw new Error(`manifest build returned no value for ${manifestKind}:${ownerKey}`);
          }
          entry.pending = false;
          counts.completed += 1;
          if (!closed && entries.get(key) === entry) {
            touch(key, entry);
            trim(key);
          }
          return manifest;
        }).catch(error => {
          counts.failures += 1;
          if (entries.get(key) === entry) entries.delete(key);
          throw error;
        });
      entries.set(key, entry);
      trim(key);
    }
    const manifest = await entry.promise;
    counts.stateApplications += 1;
    return applyState(manifest);
  };

  return Object.freeze({
    schemaVersion: PRESENTATION_MANIFEST_CACHE_SCHEMA,
    getOrCreate,
    clear() { entries.clear(); },
    close() {
      if (closed) return;
      closed = true;
      entries.clear();
    },
    snapshot: () => Object.freeze({
      schemaVersion: PRESENTATION_MANIFEST_CACHE_SCHEMA,
      capacity,
      size: entries.size,
      pendingCount: [...entries.values()].filter(entry => entry.pending).length,
      closed,
      counts: Object.freeze({ ...counts }),
    }),
  });
}
