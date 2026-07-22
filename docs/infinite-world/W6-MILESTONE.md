# W6 Milestone - Gameplay, Persistence, and Runtime Cutover

## Outcome

W6 connects the protected Tiny, Mid, and Max Gameplay contracts to the Infinite
World without changing W5 ChunkData or the finite World. The official runtime is
`infinite-world-sandbox.html`; `index.html` remains the byte-protected finite
regression entry pinned to `f8bc9f80c2af417bb585bff26c99522c4229ab8e`.

Only the nine rendered Chunks participate in Gameplay simulation. The surrounding
5 by 5 ChunkData set remains prefetch-only. W5 Settlement distribution, the
768-meter Macro Region, Terrain, Biome, boundary, and Stable ID contracts are
unchanged.

## Gameplay connection

- Tiny, Mid, and Max are imported from the existing scale module; Max remains the
  initial stage.
- Player HP, movement, attack cooldown, single/double damage, attack radii, and
  camera scale derive from the protected finite Gameplay constants.
- Human HP/radius/score and Production 0.50 visual scale remain unchanged.
- Tank HP/radius/score, Production 1.35 visual scale, and existing movement/range
  constants remain unchanged.
- Boss HP/radius/score and existing slither/rage movement constants remain
  unchanged.
- Humans belong to deterministic building owner Chunks. Military Settlement
  centers own Tanks, and CITY centers own Bosses.
- Gameplay entities use the existing `wf1` Stable ID format and deterministic
  parent identities; cross-Chunk collisions are fatal.

## Destruction and persistence

- Vegetation, Rocks, Settlement buildings, Humans, Tanks, and Bosses retain
  Stable-ID keyed HP or destruction state.
- Instanced natural/building rendering applies destruction without allocating
  replacement Geometry or Material resources.
- Entity HP, alive state, logical position, orientation, AI state, and AI clock
  survive unload and deterministic revisit.
- The seed-specific save payload includes player/scale, feature damage, destroyed
  Stable IDs, and visited entity states.
- Save payloads use the protected save version and a canonical SHA-256 checksum.
  Invalid JSON, version, seed, duplicate Stable ID, invalid values, and checksum
  corruption are rejected before live state mutation.

## Runtime and resources

Chrome runtime record on 2026-07-22:

- Initial activation: 563.80 ms for 25 generated, 9 rendered, and 9 simulated
  Chunks.
- Generation: p50 15.50 ms, p95 17.40 ms, max 157.40 ms.
- Projection: p50 2.40 ms, p95 3.90 ms, max 3.90 ms.
- Load: p50 0.00 ms, p95 0.10 ms, max 0.10 ms.
- Frame: p50 18.10 ms, p95 24.20 ms; the 618.10 ms maximum is the startup frame.
- Runtime performance warnings: 0.
- Chrome page/console errors: 0; request failures: 0 (with the recursive HTTP
  module graph also returning successful JavaScript responses).

Automated streaming keeps exactly nine Gameplay Chunk groups live. Unload/revisit
cycles retain logical state while Scene entities return to the same bounded live
set. Shutdown returns Chunk groups and entity meshes to zero and disposes all
shared Gameplay Geometry and Material resources. Measurements do not justify a
Worker or LOD implementation.

## Test record

- Finite World checkpoint suite: 194 / 194.
- Infinite World W1A-W6 suite: 81 / 81.
- Full worktree suite: 275 / 275.
- Skipped tests: 0.
- JavaScript syntax: pass.
- Local import and HTTP module graph: pass.
- Browser-equivalent boot: pass.
- Determinism and Stable ID collision guards: pass.
- Terrain/Feature Chunk boundaries and W5 Golden vectors: pass.
- Destruction unload/revisit and save/load round trip: pass.
- Corrupt-save rejection without state mutation: pass.
- Resource lifecycle and `git diff --check`: pass.

## Chrome final runtime check

The official entry reached W6 Ready with one canvas, World rendering, 9/9
rendered and simulated Chunks, and 25/25 prefetched ChunkData. WASD changed the
logical World position, 1/2/3 changed Scale, and P/L completed save/load. A Max
attack destroyed ten nearby Stable-ID targets and produced score 650; after save
and page reload, both the destruction count and score restored exactly. No
startup failure, performance warning, or Chrome error log was present.

## Deferred systems

Growth, Wanted, Threat, Nation, public opinion, fall progress, Worker, and LOD
remain outside the Infinite World migration. They were not added in W6.
