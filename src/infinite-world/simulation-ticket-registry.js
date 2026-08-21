function freezeMetadata(metadata) {
  if (metadata === null || metadata === undefined) return null;
  if (typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new TypeError('simulation ticket metadata must be an object when provided');
  }
  return Object.freeze({ ...metadata });
}

function sameTicket(left, right) {
  return left?.ticketId === right?.ticketId
    && left?.kind === right?.kind
    && left?.centerX === right?.centerX
    && left?.centerZ === right?.centerZ
    && left?.radiusMeters === right?.radiusMeters
    && left?.priority === right?.priority
    && left?.ownerStableId === right?.ownerStableId
    && left?.persistent === right?.persistent;
}

export class SimulationTicketRegistry {
  constructor({ coverageResolver } = {}) {
    if (typeof coverageResolver !== 'function') {
      throw new TypeError('SimulationTicketRegistry coverageResolver is required');
    }
    this.coverageResolver = coverageResolver;
    this.tickets = new Map();
    this.revision = 0;
    this.counts = {
      acquired: 0,
      updated: 0,
      released: 0,
      coverageQueries: 0,
    };
  }

  acquire({
    ticketId,
    kind = 'generic',
    centerX,
    centerZ,
    radiusMeters,
    priority = 'required',
    ownerStableId = null,
    persistent = false,
    metadata = null,
  } = {}) {
    if (typeof ticketId !== 'string' || !ticketId) {
      throw new TypeError('simulation ticketId is required');
    }
    if (typeof kind !== 'string' || !kind) throw new TypeError('simulation ticket kind is required');
    if (![centerX, centerZ, radiusMeters].every(Number.isFinite) || radiusMeters < 0) {
      throw new TypeError('simulation ticket requires finite center and non-negative radius');
    }
    if (typeof priority !== 'string' || !priority) {
      throw new TypeError('simulation ticket priority is required');
    }
    if (ownerStableId !== null && (typeof ownerStableId !== 'string' || !ownerStableId)) {
      throw new TypeError('simulation ticket ownerStableId must be null or a non-empty string');
    }
    if (typeof persistent !== 'boolean') throw new TypeError('simulation ticket persistent must be boolean');

    const prior = this.tickets.get(ticketId) ?? null;
    const nextBase = {
      schemaVersion: 'simulation-ticket-1',
      ticketId,
      kind,
      centerX,
      centerZ,
      radiusMeters,
      priority,
      ownerStableId,
      persistent,
    };
    if (prior && sameTicket(prior, nextBase)) return prior;
    const ticket = Object.freeze({
      ...nextBase,
      revision: ++this.revision,
      metadata: freezeMetadata(metadata),
    });
    this.tickets.set(ticketId, ticket);
    if (prior) this.counts.updated += 1;
    else this.counts.acquired += 1;
    return ticket;
  }

  release(ticketId) {
    if (typeof ticketId !== 'string' || !ticketId) return false;
    const removed = this.tickets.delete(ticketId);
    if (removed) {
      this.revision += 1;
      this.counts.released += 1;
    }
    return removed;
  }

  get(ticketId) {
    return this.tickets.get(ticketId) ?? null;
  }

  coverage(ticketId) {
    const ticket = this.get(ticketId);
    if (!ticket) return null;
    const coordinates = this.coverageResolver(
      ticket.centerX,
      ticket.centerZ,
      ticket.radiusMeters,
    );
    if (!Array.isArray(coordinates)) {
      throw new TypeError('simulation ticket coverageResolver must return an array');
    }
    this.counts.coverageQueries += 1;
    return Object.freeze({
      ticket,
      coordinates: Object.freeze([...coordinates]),
      chunkKeys: Object.freeze(coordinates.map(value => value.key)),
    });
  }

  clear() {
    const count = this.tickets.size;
    if (count === 0) return 0;
    this.tickets.clear();
    this.revision += 1;
    this.counts.released += count;
    return count;
  }

  snapshot() {
    const tickets = [...this.tickets.values()]
      .sort((a, b) => a.ticketId.localeCompare(b.ticketId))
      .map(ticket => Object.freeze({ ...ticket }));
    return Object.freeze({
      schemaVersion: 'simulation-ticket-registry-snapshot-1',
      revision: this.revision,
      ticketCount: tickets.length,
      tickets: Object.freeze(tickets),
      counts: Object.freeze({ ...this.counts }),
    });
  }
}
