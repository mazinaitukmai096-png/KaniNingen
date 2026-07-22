# W7D Milestone - Nuclear Attack and Manual Boss Parity

## Outcome

W7D extends the W6/W7C runtime and its one World State. It does not add a
parallel target registry or save path.

The nuclear attack uses the protected charge, cooldown, damage, radius, push,
and screen-shake values. It enumerates every logical Chunk whose bounds
intersect the 45-meter damage circle, obtains ChunkData from the same
distributed generator used by streaming, projects the same Stable IDs and owner
rules, and only then applies damage to the existing World State. Unrendered
Chunks are never loaded into the Scene.

The manual Boss is available only through Debug. Natural CITY Boss generation
has been removed. One Boss at a time is stored in the existing entity registry,
uses a `wf1:boss` Stable ID, the protected 75-meter debug spawn distance,
slither/charge speeds, contact/charge damage and knockback values, and follows
deterministic Chunk ownership as it moves. A second spawn is rejected until the
first Boss is defeated. HP, position, AI clock/state, owner, sequence, and
nuclear cooldown use the existing save/load path.

## Determinism and lifecycle

- Active-zero and active-one Simulation configurations return identical nuclear
  queried-Chunk lists and identical sorted hit Stable-ID lists.
- A failed ChunkData query leaves the complete World State byte-equivalent to
  its pre-attack save snapshot.
- Nuclear damage outside the rendered/simulated set persists and appears on
  later visit without Scene-loading the target Chunk at attack time.
- Manual Boss render ownership is a single shared-resource object; death and
  shutdown return it to zero. No Boss is connected to Settlement or Biome
  distribution.

## Verification

- Finite World checkpoint suite: 194 / 194.
- Infinite World W1A-W7D suite: 105 / 105.
- Full worktree suite: 299 / 299, skip 0.
- Recursive HTTP graph, browser-equivalent boot, syntax, local imports,
  determinism, Stable-ID collision guards, boundaries, save round-trip,
  resource lifecycle, and `git diff --check`: pass.
- Chrome: Ready, 9/9 rendered/simulated, 25/25 prefetched, Atomic READY,
  Debug-only Boss spawn, Boss HP/news UI, save status, and no runtime HUD error.
  Representative Boss-active frame p95 remained below 33 ms.
