# W7A Milestone - Production Visual Asset Adapter

## Outcome

W7A replaces the Infinite World proxy Player, natural-detail, building, Human,
Tank, and Boss render paths with shared low-poly production assets extracted only
from finite World baseline commit
`f8bc9f80c2af417bb585bff26c99522c4229ab8e`. The finite World files were not
edited or imported as a runtime monolith.

The renderer consumes the existing W5/W6 positions, dimensions, types, Stable
IDs, and owner Chunks. Multipart visuals remain Chunk-owned InstancedMesh
projections; every part of one logical feature is hidden by the same destruction
record. No Settlement, Terrain, Biome, road, or natural placement was regenerated.

Factory, Military Base, Grass, Flower, and Street Object are `REFERENCE_ONLY`
because those logical feature types are not present in the W5/W6 projection.
Their absence did not add new World data. Full per-asset source and destination
hashes are recorded in `W7-VISUAL-PROVENANCE.json`.

## Resource and performance record

Chrome measurement used a fixed Seed, fixed logical position/camera, a
1920 by 1080 drawing buffer, ten seconds of excluded warm-up, and thirty seconds
of visible foreground sampling.

- Steady frame: p50 6.10 ms, p95 12.10 ms, max 248.50 ms.
- Chunk-crossing frame: p50 12.10 ms, p95 12.30 ms, max 1018.20 ms.
- Crossing generation: p50 15.50 ms, p95 18.30 ms, max 20.70 ms.
- Projection: p50 1.80 ms, p95 2.90 ms, max 3.20 ms.
- Load: p95 0.10 ms; unload: p95 0.10 ms.
- Representative steady resources: 89 draw calls, 14 WebGL geometries,
  26 shared materials, and 146 Scene objects.
- After 22 Chunk crossings: 9 rendered, 25 active data, cache 81/81,
  43 draw calls, 12 WebGL geometries, 26 shared materials, and 84 Scene objects.

The p95 gate is below 33 ms. No Worker, LOD, external package, or performance
workaround was introduced.

## Verification

- Full finite and Infinite test worktree: 279 / 279, skip 0.
- Fixed baseline provenance and destination SHA-256: pass.
- Chunk unload/revisit visual identity and destruction fan-out: pass.
- Chunk-owned geometry/resource lifecycle: pass.
- Browser Ready, production Player and natural assets visible: pass.
- JavaScript syntax, local imports, HTTP module graph, and diff check: pass.
