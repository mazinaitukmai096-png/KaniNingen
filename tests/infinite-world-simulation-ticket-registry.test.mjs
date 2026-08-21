import test from 'node:test';
import assert from 'node:assert/strict';
import { SimulationTicketRegistry } from '../src/infinite-world/simulation-ticket-registry.js';

const coverageResolver = (x, z, radius) => Object.freeze([
  Object.freeze({ chunkX: Math.floor(x / 16), chunkZ: Math.floor(z / 16), key: `${Math.floor(x / 16)},${Math.floor(z / 16)}` }),
  ...(radius > 16 ? [Object.freeze({ chunkX: Math.floor(x / 16) + 1, chunkZ: Math.floor(z / 16), key: `${Math.floor(x / 16) + 1},${Math.floor(z / 16)}` })] : []),
]);

test('SimulationTicketRegistry keeps world activity independent from player/render ownership', () => {
  const registry = new SimulationTicketRegistry({ coverageResolver });
  const first = registry.acquire({
    ticketId: 'projectile:tnt-1', kind: 'projectile', centerX: 320, centerZ: -64,
    radiusMeters: 24, ownerStableId: 'tnt-1', persistent: false,
  });
  assert.equal(first.ticketId, 'projectile:tnt-1');
  assert.deepEqual(registry.coverage(first.ticketId).chunkKeys, ['20,-4', '21,-4']);
  assert.equal(registry.snapshot().ticketCount, 1);

  const unchanged = registry.acquire({
    ticketId: 'projectile:tnt-1', kind: 'projectile', centerX: 320, centerZ: -64,
    radiusMeters: 24, ownerStableId: 'tnt-1', persistent: false,
  });
  assert.equal(unchanged, first);

  const moved = registry.acquire({
    ticketId: 'projectile:tnt-1', kind: 'projectile', centerX: 336, centerZ: -64,
    radiusMeters: 24, ownerStableId: 'tnt-1', persistent: false,
  });
  assert.notEqual(moved.revision, first.revision);
  assert.deepEqual(registry.coverage(moved.ticketId).chunkKeys, ['21,-4', '22,-4']);
  assert.equal(registry.release(moved.ticketId), true);
  assert.equal(registry.snapshot().ticketCount, 0);
});
