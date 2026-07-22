import { createChunkKey } from './chunk-coordinates.js';

function candidateCollections(chunkData) {
  return [
    ...(chunkData.vegetationCandidates ?? chunkData.vegetationProxies ?? []),
    ...(chunkData.rockCandidates ?? chunkData.rockProxies ?? []),
  ];
}

function candidateId(candidate) {
  return candidate?.candidateId ?? candidate?.stableId;
}

export class PersistentChunkIndex {
  constructor({ capacity = 65_536 } = {}) {
    if (!Number.isSafeInteger(capacity) || capacity < 25) {
      throw new RangeError('Persistent Chunk index capacity must be an integer of at least 25');
    }
    this.capacity = capacity;
    this.entries = new Map();
    this.candidateOwners = new Map();
    this.accessTick = 0;
    this.counts = { registered: 0, revisited: 0, evicted: 0 };
  }

  registerChunk(chunkData) {
    if (!chunkData || !Number.isSafeInteger(chunkData.chunkX) || !Number.isSafeInteger(chunkData.chunkZ)) {
      throw new TypeError('valid ChunkData is required by the persistent index');
    }
    if (typeof chunkData.chunkId !== 'string' || typeof chunkData.contentHash !== 'string') {
      throw new TypeError('ChunkData identity is required by the persistent index');
    }
    const key = createChunkKey(chunkData.chunkX, chunkData.chunkZ);
    const candidates = candidateCollections(chunkData);
    const ids = candidates.map(candidateId);
    if (ids.some(id => typeof id !== 'string' || !id) || new Set(ids).size !== ids.length) {
      throw new Error(`invalid or duplicate Stable ID inside chunk ${key}`);
    }
    const existing = this.entries.get(key);
    if (existing && (existing.chunkId !== chunkData.chunkId
      || existing.contentHash !== chunkData.contentHash
      || existing.candidateIds.length !== ids.length
      || existing.candidateIds.some((id, index) => id !== ids[index]))) {
      throw new Error(`persistent Chunk index mismatch on revisit: ${key}`);
    }
    for (const id of ids) {
      const owner = this.candidateOwners.get(id);
      if (owner && owner !== key) throw new Error(`Stable ID collision across ${owner} and ${key}: ${id}`);
    }
    if (existing) {
      this.entries.delete(key);
      const revisited = Object.freeze({ ...existing, lastUsed: ++this.accessTick });
      this.entries.set(key, revisited);
      this.counts.revisited += 1;
      return revisited;
    }
    const entry = Object.freeze({
      key,
      chunkX: chunkData.chunkX,
      chunkZ: chunkData.chunkZ,
      chunkId: chunkData.chunkId,
      contentHash: chunkData.contentHash,
      candidateIds: Object.freeze([...ids]),
      vegetationCount: (chunkData.vegetationCandidates ?? chunkData.vegetationProxies ?? []).length,
      rockCount: (chunkData.rockCandidates ?? chunkData.rockProxies ?? []).length,
      lastUsed: ++this.accessTick,
    });
    this.entries.set(key, entry);
    for (const id of ids) this.candidateOwners.set(id, key);
    this.counts.registered += 1;
    this.#evictOldest();
    return entry;
  }

  #evictOldest() {
    while (this.entries.size > this.capacity) {
      const [key, entry] = this.entries.entries().next().value;
      this.entries.delete(key);
      for (const id of entry.candidateIds) {
        if (this.candidateOwners.get(id) === key) this.candidateOwners.delete(id);
      }
      this.counts.evicted += 1;
    }
  }

  getChunk(chunkX, chunkZ) {
    return this.entries.get(createChunkKey(chunkX, chunkZ)) ?? null;
  }

  getCandidateOwner(id) {
    return this.candidateOwners.get(id) ?? null;
  }

  snapshot() {
    return Object.freeze({
      schemaVersion: 'w3-persistent-chunk-index-1',
      size: this.entries.size,
      capacity: this.capacity,
      candidateCount: this.candidateOwners.size,
      counts: Object.freeze({ ...this.counts }),
    });
  }
}
