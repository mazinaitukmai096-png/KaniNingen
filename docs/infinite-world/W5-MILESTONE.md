# W5 Milestone - Infinite Settlement Distribution

## Outcome

W5 replaces the single W4 pilot with deterministic, unbounded RURAL, TOWN, and CITY distribution while preserving the W3 natural world and the current finite-World Settlement contracts. There is no fixed town or Settlement total. The normal Infinite World sandbox now starts at the nearest deterministic Settlement and continues to stream nature and Settlements in every direction.

Gameplay, destruction state, save persistence, Growth, Wanted, Threat, Nation, Worker, and LOD remain disconnected. These are W6 concerns.

## Distribution contract

- Candidate identity is derived from the World Seed and Macro Region coordinate.
- Macro Region size is 768 logical meters.
- Candidate centers use deterministic in-region jitter.
- Terrain suitability uses Legacy Macro Terrain slope and W2 natural Biome membership.
- Urbanization uses two smooth deterministic regional fields.
- Type thresholds produce RURAL, TOWN, and CITY without a fixed global count.
- Minimum spacing is 640 m for RURAL, 960 m for TOWN, and 1,536 m for CITY; conflicts use the larger participant distance.
- Deterministic local priority selects one Candidate when spacing conflicts occur.
- Candidate and accepted-result caches have explicit LRU bounds.

A 41 by 41 Macro Region probe produced 453 accepted Settlements: 249 RURAL, 181 TOWN, and 23 CITY. The closest accepted pair was 643.016 m apart against a required 640 m minimum; no spacing violations were found.

## Migrated Settlement contract

- RURAL uses the existing residential, military, and suburb profiles.
- TOWN uses the existing church_town and school_town profiles.
- CITY uses the existing Capital Civic Core and CITY road contract.
- Existing road hierarchy, Frontage, Lot, building composition, building visual, and 40 finite-units-per-meter scale modules are reused.
- Human Production scale remains 1.75 logical meters.
- Building-placement shortages remain explicit; no Frontage, Lot, or collision rule was weakened.
- CITY template search is bounded while retaining the formal requested count and shortage diagnostics.

The golden distribution seed yields 96 Settlements in a 21 by 21 Macro Region probe: 58 RURAL, 28 TOWN, and 10 CITY.

## Chunk integration

- Generator: `worldgen-v500.0.0`
- Chunk schema: `w5-distributed-settlement-chunk-data-1`
- W3 terrain, Biome, and edge data remain unchanged.
- Natural Vegetation and Rock Candidates are removed only when their bounds conflict with a projected road or building.
- Roads are clipped into deterministic per-Chunk projections.
- Buildings retain exact West/North point ownership.
- Every projected feature has a Stable ID, and the persistent Chunk index rejects collisions.
- The W5 transitive content envelope commits the W3 source hash, retained natural Candidate IDs, Settlement references, Settlement features, identity, and generation proof.
- A Chunk contains at most one Settlement reference under the formal spacing and influence contracts.

Isolated, reverse-order, parallel, and boundary generation are identical. Fixed distributor, review-spawn, Chunk ID, content-hash, Settlement ID, and feature-ID golden vectors are recorded.

## Runtime and resource verification

Standalone 48-crossing benchmark on 2026-07-22, starting at a distributed Settlement:

- Generator factory: 11.650 ms
- Initial 25-Chunk activation: 628.978 ms
- Generation: p50 11.621 ms, p95 16.872 ms, max 204.368 ms
- Crossing: p50 72.241 ms, p95 92.554 ms, max 108.300 ms
- Performance warnings: 0
- Cache high-water: 81 / 81
- Active data high-water: 25 / 25
- Rendered Scene objects high-water: 9 / 9
- Indexed Chunk summaries: 314
- Indexed Candidate/Settlement feature IDs: 4,805
- Persistent-index evictions: 0
- Settlement template cache: 1 / 128 in the traversal
- Distributor raw cache: 79 / 8,192
- Distributor accepted cache: 9 / 4,096

The isolated generation maximum contains first-use Settlement template construction; generation p95 and crossing max remain below runtime warning thresholds. Worker and LOD introduction is therefore not justified by current measurements.

Settlement Geometry and RURAL/TOWN/CITY Materials are allocated lazily and shared. Sustained streaming keeps nine live Chunk groups and nine live Chunk-owned terrain geometries. Shutdown returns both counts to zero, balances created/disposed Chunk geometry, and disposes shared resources.

## Test record

- Finite World checkpoint suite: 193 / 193
- Fixed-checkpoint mutation guard: 1 / 1
- W1A: 16 / 16
- W1B: 6 / 6
- W2: 7 / 7
- W3: 9 / 9
- W4: 8 / 8
- W5: 10 / 10
- Combined Infinite World phase suite after W5: 56 / 56
- Full worktree suite after W5: 250 / 250
- Runtime smoke/import resolution: pass
- Determinism: pass
- Chunk boundaries: pass
- Stable ID collision check: pass
- Resource lifecycle: pass
- `git diff --check`: pass

## Project Owner review gate

W5 is the first planned intermediate review point. The Project Owner should inspect the Infinite World sandbox for the overall alternation of natural space and continuously generated RURAL, TOWN, and CITY Settlements. Numerical tuning and small visual differences do not block W6, but any required change to current Gameplay, scale, or Settlement specifications must be decided before W6.

## Remaining risk

- Browser GPU/frame behavior still requires the planned Project Owner visual review; the automated runtime harness covers CPU generation, streaming bounds, and resource ownership.
- Current finite Frontage/Lot collision rules intentionally leave building shortages, especially for the bounded CITY template search. Diagnostics remain visible rather than silently changing the finite Settlement specification.
- W6 must still connect nearby-Chunk-only Gameplay simulation, Stable-ID destruction diffs, save/revisit persistence, and the official runtime cutover while retaining the finite World regression entry.
