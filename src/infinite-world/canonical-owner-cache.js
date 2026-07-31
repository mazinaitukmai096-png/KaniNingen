export const CANONICAL_OWNER_CACHE_SCHEMA = 'canonical-owner-cache-1';

function assertPositiveCapacity(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
}

function assertKeyPart(value, name) {
  if (typeof value !== 'string' || !value) throw new TypeError(`${name} is required`);
}

function defaultIdentityOf(value) {
  if (typeof value?.chunkId !== 'string' || typeof value?.contentHash !== 'string') return null;
  return Object.freeze({ chunkId: value.chunkId, contentHash: value.contentHash });
}

function sameIdentity(left, right) {
  return left?.chunkId === right?.chunkId && left?.contentHash === right?.contentHash;
}

/**
 * Bounded cache for immutable canonical owner sources. Pending entries are
 * shared and never evicted; only settled entries participate in LRU eviction.
 */
export function createCanonicalOwnerCache({
  capacity = 256,
  identityAuditCapacity = Math.max(4096, capacity),
  identityOf = defaultIdentityOf,
} = {}) {
  assertPositiveCapacity(capacity, 'canonical owner cache capacity');
  assertPositiveCapacity(identityAuditCapacity, 'canonical owner identity audit capacity');
  if (identityAuditCapacity < capacity) {
    throw new RangeError('canonical owner identity audit capacity must be at least cache capacity');
  }
  if (typeof identityOf !== 'function') throw new TypeError('canonical owner identityOf is required');

  const entries = new Map();
  const identityAudit = new Map();
  let closed = false;
  const counts = {
    requests: 0,
    hits: 0,
    misses: 0,
    pendingDedupeHits: 0,
    loads: 0,
    completed: 0,
    failures: 0,
    evictions: 0,
    identityAuditEvictions: 0,
    identityMismatches: 0,
  };

  const compositeKey = (ownerKey, sourceRevision) => {
    assertKeyPart(ownerKey, 'canonical ownerKey');
    assertKeyPart(sourceRevision, 'canonical sourceRevision');
    return `${sourceRevision}\u0000${ownerKey}`;
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
  const auditIdentity = (key, value) => {
    const identity = identityOf(value);
    if (identity === null || identity === undefined) return;
    if (typeof identity !== 'object'
      || typeof identity.chunkId !== 'string'
      || typeof identity.contentHash !== 'string') {
      throw new TypeError('canonical owner identity must expose chunkId and contentHash');
    }
    const previous = identityAudit.get(key);
    if (previous && !sameIdentity(previous, identity)) {
      counts.identityMismatches += 1;
      throw new Error(`canonical owner identity changed for ${key.split('\u0000').at(-1)}`);
    }
    if (previous) identityAudit.delete(key);
    identityAudit.set(key, Object.freeze({ ...identity }));
    while (identityAudit.size > identityAuditCapacity) {
      identityAudit.delete(identityAudit.keys().next().value);
      counts.identityAuditEvictions += 1;
    }
  };

  const getOrCreate = ({ ownerKey, sourceRevision, load } = {}) => {
    if (closed) throw new Error('canonical owner cache is closed');
    if (typeof load !== 'function') throw new TypeError('canonical owner loader is required');
    const key = compositeKey(ownerKey, sourceRevision);
    counts.requests += 1;
    const existing = entries.get(key);
    if (existing) {
      counts.hits += 1;
      if (existing.pending) counts.pendingDedupeHits += 1;
      touch(key, existing);
      return existing.promise;
    }

    counts.misses += 1;
    counts.loads += 1;
    const entry = { ownerKey, sourceRevision, pending: true, value: undefined, promise: null };
    let loaded;
    try {
      // Generation starts in the caller's turn so existing pending/backlog
      // diagnostics keep their pre-cache timing semantics.
      loaded = load();
    } catch (error) {
      counts.failures += 1;
      return Promise.reject(error);
    }
    entry.promise = Promise.resolve(loaded).then(value => {
        if (value === null || value === undefined) {
          throw new Error(`canonical owner loader returned no value for ${ownerKey}`);
        }
        if (!closed) auditIdentity(key, value);
        entry.value = closed ? undefined : value;
        entry.pending = false;
        counts.completed += 1;
        if (!closed && entries.get(key) === entry) {
          touch(key, entry);
          trim(key);
        }
        return value;
      }).catch(error => {
        counts.failures += 1;
        if (entries.get(key) === entry) entries.delete(key);
        throw error;
      });
    entries.set(key, entry);
    trim(key);
    return entry.promise;
  };

  const peek = ({ ownerKey, sourceRevision } = {}) => {
    const key = compositeKey(ownerKey, sourceRevision);
    const entry = entries.get(key);
    if (!entry || entry.pending) return null;
    touch(key, entry);
    return entry.value;
  };

  return Object.freeze({
    schemaVersion: CANONICAL_OWNER_CACHE_SCHEMA,
    getOrCreate,
    peek,
    has({ ownerKey, sourceRevision } = {}) {
      return entries.has(compositeKey(ownerKey, sourceRevision));
    },
    delete({ ownerKey, sourceRevision } = {}) {
      return entries.delete(compositeKey(ownerKey, sourceRevision));
    },
    clear() { entries.clear(); },
    close() {
      if (closed) return;
      closed = true;
      entries.clear();
      identityAudit.clear();
    },
    snapshot: () => Object.freeze({
      schemaVersion: CANONICAL_OWNER_CACHE_SCHEMA,
      capacity,
      size: entries.size,
      pendingCount: [...entries.values()].filter(entry => entry.pending).length,
      identityAuditCapacity,
      identityAuditSize: identityAudit.size,
      closed,
      counts: Object.freeze({ ...counts }),
    }),
  });
}
