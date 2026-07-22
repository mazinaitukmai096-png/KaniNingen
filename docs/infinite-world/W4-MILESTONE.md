# W4 Milestone — Single Deterministic RURAL Settlement

## Outcome

W4 connects exactly one deterministic RURAL Settlement to the W3 natural world. The Settlement uses the current finite World's unchanged RURAL road, Frontage, Lot, building-composition, and building-visual modules. TOWN, CITY, Gameplay, Growth, Wanted, Threat, Nation, Worker, and LOD systems remain disconnected.

## Scale migration

The migration adapter makes the existing finite scale explicit without changing it:

- Finite World scale: 40 units per logical meter
- Current Human model height: 140 finite units
- Current Production Human visual scale: 0.5
- Migrated Production Human height: 1.75 m
- RURAL LOCAL width: 55 finite units = 1.375 m
- RURAL ALLEY width: 40 finite units = 1.0 m
- RURAL radius: 3,510 finite units = 87.75 m
- RURAL core radius: 1,950 finite units = 48.75 m

This adapter addresses the earlier perceived-size concern by giving every migrated asset a single real-world conversion instead of resizing unrelated systems independently.

## Settlement contract

- Settlement type: RURAL
- Town type: residential
- Center: logical `(8 m, 8 m)`
- One LOCAL spine, three LOCAL branches, three ALLEY routes
- 25 road segments: 16 LOCAL and 9 ALLEY
- Six junctions, eight dead ends, zero omitted routes
- Current building opportunity formula: 106
- Safely accepted formal Frontage/Lot buildings for the milestone seed: 8

W4 intentionally records the current placement shortage instead of weakening collision, Frontage, or Lot rules. Gameplay population and dynamic entities are a W6 contract. W5 must preserve the same diagnostics while distributing all Settlement types.

## Chunk integration

- Generator: `worldgen-v400.0.0`
- Chunk schema: `w4-single-rural-chunk-data-1`
- W3 terrain, Biome, edge data, and source hash remain unchanged.
- Road segments are clipped into deterministic per-Chunk projections.
- Buildings use exact West/North point ownership.
- Road projections have per-Chunk Stable IDs and retain their global source Stable ID.
- Natural Vegetation/Rock Candidates are removed only where their bounds conflict with a Settlement road or building.
- The persistent Chunk index now includes Settlement feature projections and rejects collisions.

W4 uses a transitive content envelope: the W3 source hash commits the complete natural Chunk, while W4 hashes filtered Candidate IDs, Settlement references/features, identity, and generation proof. This avoids hashing the large terrain arrays a second time without weakening generated-content coverage.

## Determinism and boundaries

- Isolated, reverse-order, and parallel generation are identical.
- Fixed Settlement, road, building, Chunk ID, and Chunk hash goldens are recorded.
- Multi-Chunk road projections share exact boundary endpoints.
- Per-Chunk projection Stable IDs are globally unique.
- No TOWN or CITY output exists in W4.

## Runtime and resource verification

Standalone 48-crossing benchmark on 2026-07-22:

- One-time Settlement template construction: 155.105 ms
- Initial 25-Chunk activation: 354.210 ms
- Generation: p50 10.973 ms, p95 13.280 ms, max 22.305 ms
- Crossing: p50 89.361 ms, p95 169.427 ms, max 172.882 ms
- Performance warnings: 0
- Cache high-water: 81 / 81
- Active data high-water: 25 / 25
- Rendered Scene objects high-water: 9 / 9
- Indexed Chunk summaries: 249
- Indexed Candidate/Settlement feature IDs: 3,735
- Persistent-index evictions: 0

Settlement Geometry and Materials are allocated lazily and shared. Sustained streaming keeps nine live Chunk groups and nine live Chunk-owned terrain geometries; shutdown returns both counts to zero and disposes shared resources.

## Test record

- Finite World checkpoint suite: 193 / 193
- W1A: 16 / 16
- W1B: 6 / 6
- W2: 7 / 7
- W3: 9 / 9
- W4: 8 / 8
- Combined Infinite World phase suite after W4: 46 / 46
- Full worktree suite after W4: 240 / 240
- Runtime smoke/import resolution: pass
- `git diff --check`: pass

## Remaining risk

The single RURAL pilot exposes a high building-opportunity shortage because current Frontage/Lot collision rules accept only a small safe subset on this compact road topology. No rule was relaxed. W5 can proceed because its contract is distribution and world continuity, but it must keep the shortage visible for the W5 Project Owner world review rather than silently changing Settlement specifications.
