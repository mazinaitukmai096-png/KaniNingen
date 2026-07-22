# W3 Milestone — Formal Natural Details

## Outcome

W3 integrates deterministic formal Vegetation and Rock Candidates into the W2 infinite natural terrain runtime. It keeps Settlement, roads, buildings, and Gameplay disconnected. Candidate identity and West/North boundary ownership reuse the fixed Legacy WorldGen contracts. Rock classification and identity reuse the exact Legacy G6-D implementation.

## Contracts

- Generator: `worldgen-v300.0.0`
- Chunk schema: `w3-formal-natural-detail-chunk-data-1`
- Terrain/Biome/edge payload: byte-for-byte equal to the W2 source Chunk
- Vegetation proposal grid: 2 m, maximum 64 formal Candidates per Chunk
- Rock proposal grid: 2 m, maximum 64 formal Candidates per Chunk
- Formal Candidate schema: `detail-candidate-1`
- Candidate ownership: exact Legacy West/North boundary rule
- Candidate output ordering: lexical Stable ID order
- Persistent runtime index: 65,536 Chunk summaries in the production sandbox; survives data-cache eviction and runtime shutdown when retained by the owner
- W3 does not use disk persistence. Durable save storage remains a W6 contract.

## Legacy provenance

Seven files are copied byte-for-byte from Legacy commit `4210c069314a084b528d97e3d5a5e1345d38ad94`. `W3-PROVENANCE.json` records each Git blob and SHA-256. The copied set contains the formal Detail Candidate identity/ownership chain and G6-D Rock redistribution. Imports are not adjusted.

Legacy G6-C Vegetation redistribution remains outside W3 because it directly imports the old river and developed-biome pipeline. W3 Vegetation instead uses the exact Legacy Candidate identity/ownership contract with W2 natural Biome inputs, preventing premature Settlement or river-system coupling.

## Determinism and boundaries

- Isolated, reverse-order, and parallel generation are identical.
- Fixed W3 Chunk hash and first-Candidate Stable ID goldens are recorded for `(0,0)` and `(1,-1)`.
- Adjacent Chunk terrain, Biome, and edge content remain exactly W2.
- Every Candidate is owned exactly once, and adjacent active Chunks contain no duplicate Stable IDs.
- Formal Rock bounds cannot overlap formal Vegetation bounds.
- The persistent index rejects changed Chunk content and cross-Chunk Stable ID collisions.

## Runtime and resource verification

Standalone 48-crossing benchmark on 2026-07-22:

- Initial 25-Chunk activation: 409.681 ms
- Generation: p50 10.991 ms, p95 13.681 ms, max 45.206 ms
- Crossing: p50 89.095 ms, p95 171.677 ms, max 176.464 ms
- Performance warnings: 0
- Cache high-water: 81 / 81
- Active data high-water: 25 / 25
- Rendered Scene objects high-water: 9 / 9
- Indexed Chunk summaries: 249
- Indexed formal Candidate IDs: 4,028
- Revisited indexed Chunks: 162
- Persistent-index evictions: 0

The real render adapter additionally keeps nine live Chunk groups and nine live Chunk-owned terrain geometries throughout sustained streaming. Shutdown disposes every Chunk-owned geometry and all shared Geometry/Material resources. No Web Worker or LOD was introduced because the measured runtime remains within the current warning thresholds.

## Test record

- Finite World checkpoint suite: 193 / 193
- W1A: 16 / 16
- W1B: 6 / 6
- W2: 7 / 7
- W3: 9 / 9
- Combined Infinite World phase suite after W3: 38 / 38
- Full worktree suite after W3: 232 / 232
- Runtime smoke/import resolution: pass
- `git diff --check`: pass

## Remaining risk

Candidate generation increases crossing cost relative to W2. The current p95 remains below the runtime warning threshold, so Worker/LOD work is still deferred as required. W4 may increase cost when one RURAL Settlement is connected; the same benchmark and stop condition must be applied again.
