# Infinite World Migration — W2 Milestone Record

## Status

W2 Infinite Terrain and Natural Biome Foundation is complete in the isolated Infinite World runtime. Settlement, roads, buildings, Gameplay, formal vegetation, and formal rocks are not connected.

## Legacy WorldGen reuse

Two pure modules were acquired with `git show` from fixed Legacy commit `4210c069314a084b528d97e3d5a5e1345d38ad94`. Dirty Legacy working-tree content was not read.

| Source | Destination | SHA-256 | Import changes |
|---|---|---|---|
| `g3/biome-terrain.js` | `legacy-core/g3/biome-terrain.js` | `5f05e87e24eda1d41ba53894d1793645563ad9a2921f896da6bca48e76b647a5` | none |
| `g5/macro-terrain.js` | `legacy-core/g5/macro-terrain.js` | `22abf1a22fb4d7874e5137a493ad6ac88f5569930f246356f0d75963376f9cb2` | none |

Git blob identity and SHA-256 are recorded in `src/infinite-world/legacy-core/W2-PROVENANCE.json` and verified by tests. W2 calls the Legacy G5 world-coordinate Macro Terrain evaluator. Anthropogenic G3 terrain helpers remain present only as an unchanged static dependency and are not called by the W2 generator.

## W2 Chunk contract

- Schema: `w2-natural-chunk-data-1`
- Generator version: `200.0.0`
- Logical chunk: 16 meters
- Terrain: 33×33 vertices at 0.5-meter spacing
- Height unit: 0.001 meter
- Height field: globally addressable Legacy G5 Macro Terrain with hills, ridges, valleys, domain warp, and local detail
- Slopes: centered world-space derivative with one-sample halo
- Materials: grass, dry soil, wet soil, sand, rock
- Natural climate: deterministic temperature, moisture, and woodland patch fields
- Natural Biomes: temperate grassland, mixed woodland, wetland, rocky highland
- Biome field: 5×5 boundary-inclusive samples plus normalized chunk averages
- Water bodies: none in W2
- Vegetation and rock outputs: empty; formal integration is reserved for W3
- Chunk ID/content hash: generator-major 200 with two fixed golden coordinate vectors

All terrain and climate samples use world coordinates. Heights, slopes, material weights, moisture, rockiness, biome memberships, and edge hashes match exactly at east/west and north/south Chunk boundaries, including negative coordinates.

## Rendering and resource ownership

- W1A flat terrain remains supported for regression.
- W2 creates one 33×33 vertex-colored BufferGeometry per rendered Chunk.
- Natural terrain Material is shared globally.
- Chunk-owned terrain Geometry is disposed on unload.
- Shared proxy/border geometry and all shared materials are disposed only at Sandbox shutdown.
- Sustained streaming test: 9 live Chunk groups and 9 live Chunk-owned geometries at every transition; 0 after shutdown.
- Formal Tree/Rock meshes are not populated in W2.

## Performance record

Recorded 2026-07-22 on Windows 10.0.26100, Node v26.5.0, Intel Core i7-10700K. The stabilized run generated 315 ChunkData records across 48 boundary crossings with an 81-entry data cache.

| Metric (ms) | Samples | p50 | p95 | Max |
|---|---:|---:|---:|---:|
| Generation | 315 | 6.637 | 9.111 | 22.167 |
| Projection (static adapter) | 281 | 0.001 | 0.002 | 0.021 |
| Load (static adapter) | 281 | 0.001 | 0.002 | 0.013 |
| Unload (static adapter) | 272 | 0.000 | 0.003 | 0.022 |
| Rebase (static adapter) | 48 | 0.001 | 0.002 | 0.005 |
| Crossing | 48 | 49.049 | 68.931 | 69.619 |

- Initial 25-Chunk population: 234.079ms
- Performance warnings: none
- Crossing max remains below the 200ms stall warning.
- Browser GPU/frame values remain instrumented in the runtime HUD; browser automation was not used.

## Verification

- W2 tests: 7/7 passed
- Infinite W1A/W1B/W2 tests: 29/29 passed
- Combined Infinite branch suite: 223/223 passed
- W1A generator identity/content remains unchanged after W2 activation.
- Legacy blob and SHA-256 provenance passed.
- Isolated, reverse-order, and parallel-equivalent W2 generation passed.
- Boundary terrain, slope, material, climate, and Biome equality passed.
- All four natural Biomes appear as deterministic primary regions in the coverage fixture.
- Resource lifecycle and repeated streaming passed.
- Finite World source, fixture, and historical regression baseline remain protected at `f8bc9f80c2af417bb585bff26c99522c4229ab8e`.

## Residual risk carried into W3

- W2 does not generate rivers or water surfaces; wetland is a climate/terrain Biome only.
- W2 has no formal vegetation or rock candidates; W3 must derive them from stable world-space fields and persistent Chunk indexes.
- Browser GPU/frame performance requires manual HUD observation, while static streaming measurements are within the current limits.
