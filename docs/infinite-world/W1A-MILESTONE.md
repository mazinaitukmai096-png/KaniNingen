# Infinite World Migration — W1A Milestone Record

## Status

W1A Deterministic Chunk Runtime Foundation is implemented in the isolated Infinite World worktree. The finite Gameplay World remains the unchanged regression baseline.

## Git and provenance

- Worktree: `C:\KaniNingen-InfiniteSandbox`
- Branch: `feature/infinite-chunk-sandbox-w1a`
- Baseline: `f8bc9f80c2af417bb585bff26c99522c4229ab8e`
- Legacy source commit: `4210c069314a084b528d97e3d5a5e1345d38ad94`
- Migrated pure-core files: 9
- Migrated file hashes: verified against `src/infinite-world/legacy-core/PROVENANCE.json`
- Phase commit: this record is contained in the W1A phase commit

## Runtime contract

- Logical chunk: 16 meters
- W1A render chunk: 4096 units
- Conversion: 256 render units per meter
- Render set: 3×3 / 9 chunk groups
- Data/prefetch set: 5×5 / 25 ChunkData records
- Same-session LRU cache: 81 ChunkData records
- One-axis boundary crossing: 5 newly generated data chunks, 3 render loads, 3 render unloads
- Immediate revisit while cached: 0 newly generated chunks
- Boundary ownership: West/North, including negative coordinates and normalized `-0`
- Floating Origin: logical coordinates, Chunk IDs, Stable IDs, and content hashes remain unchanged
- Terrain: flat W1A placeholder with deterministic four-edge data
- Tree proxies: exactly 4 per chunk
- Rock proxies: deterministic 0–2 per chunk
- Proxy metadata: `sandboxProxy: true`, `formalCandidate: false`
- Formal G6 vegetation/rock, settlements, roads, buildings, and Gameplay: not connected in W1A

## Render resource ownership

- Shared geometries: 4
- Shared materials: 4
- Per rendered chunk: one Group with Terrain Mesh, Tree InstancedMesh, Rock InstancedMesh, and boundary LineSegments
- Chunk unload: removes and clears only chunk-owned scene objects
- Shared geometry/material disposal: Sandbox shutdown only
- Repeated load/unload test: no live group or shared resource growth

## Verification

- W1A tests: 16/16 passed
- Full suite: 209/209 passed (193 finite-world regression tests + 16 W1A tests)
- Runtime smoke: static Node import/type/lifecycle smoke passed
- Determinism: isolated, reverse-order, and parallel generation passed
- Boundary checks: negative ownership and adjacent terrain edges passed
- Stable IDs: sorted and unique across the tested 5×5 set
- Resource lifecycle: repeated projection/load/unload/shutdown passed
- Protected finite-world files: content-equal to the exact baseline after line-ending normalization
- Browser automation: not used

## Performance record

Recorded 2026-07-22 on Windows 10.0.26100, Node v26.5.0, Intel Core i7-10700K, 16 logical CPUs. The harness traversed 48 chunk boundaries, generated 209 unique/reloaded chunks under the 81-entry cache cap, and retained 9 rendered / 25 active data chunks.

| Metric (ms) | Samples | Latest | p50 | p95 | Max |
|---|---:|---:|---:|---:|---:|
| Generation | 209 | 3.667 | 3.485 | 24.884 | 27.953 |
| Projection (static adapter) | 153 | 0.000 | 0.000 | 0.002 | 0.029 |
| Load (static adapter) | 153 | 0.000 | 0.001 | 0.002 | 0.016 |
| Unload (static adapter) | 144 | 0.000 | 0.000 | 0.002 | 0.033 |
| Rebase (static adapter) | 48 | 0.001 | 0.001 | 0.003 | 0.007 |
| Crossing | 48 | 3.879 | 3.720 | 4.240 | 4.555 |
| Node event-loop frame sample | 240 | 0.003 | 0.003 | 0.009 | 0.103 |

Warnings: none. Generation p95 is below 100ms, load p95 is below 100ms, and crossing max is below 200ms.

The projection/load/unload and frame rows are static harness measurements, not browser GPU measurements. The Sandbox HUD records real browser frame, generation, projection, load, unload, rebase, and crossing distributions for manual runtime review.

## Manual launch

```powershell
cd C:\KaniNingen-InfiniteSandbox
npx http-server . -p 8020 -c-1 -o
```

Open `http://127.0.0.1:8020/infinite-world-sandbox.html` and use WASD plus Shift for accelerated boundary crossing.

## Residual risk carried into W1B

- 4096 is a W1A initial render scale, not a final selection.
- Real browser GPU/frame behavior still needs manual observation; instrumentation is present.
- W1A terrain and object proxies are intentionally temporary and must not be treated as W2/W3 formal outputs.
