# Infinite World Migration — W1B Milestone Record

## Status

W1B Chunk Size Benchmark and Runtime Stabilization is complete. The active render chunk remains 4096 units after an automated 4096/2048 comparison. Logical chunks remain 16 meters.

## Automated render-size decision

Both candidates were compared with 500,000 coordinate projections per round across 11 rounds.

| Candidate | Units/m | Projection p50 | Projection p95 | 3×3 logical view | 5×5 logical prefetch | Debug crossings/s | 160m settlement span |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 4096 | 256 | 3.470ms | 11.342ms | 48m | 80m | 2 | 10 chunks |
| 2048 | 128 | 3.459ms | 6.136ms | 48m | 80m | 2 | 10 chunks |

The p50 difference was approximately 0.3%, and coordinate projection is not a streaming bottleneck. Geometry count, material count, scene-object count, draw-call structure, generated data count, boundary-crossing frequency, logical display distance, and future settlement chunk span are identical.

4096 was selected because Floating Origin already bounds render-root magnitude, while changing to 2048 would change the W1A `renderChunkSize` field, content hashes, and established visual scale without a material runtime benefit. The 2048 profile remains supported for controlled diagnostics but is not active.

## Stabilization changes

- Deterministic processing order after parallel ChunkData generation
- Coalescing/accounting for duplicate queued center transitions
- Bounded 4096-entry default identity audit independent of the 81-entry data cache
- Regeneration guard for changed Chunk ID or content hash after cache eviction
- Runtime duplicate Chunk ID and Stable ID checks across the active 5×5 set
- Runtime adjacent terrain-edge hash and content validation
- Hard invariants for 25 active data chunks, 9 rendered chunks, cache cap, and render/data containment
- High-water counters for cache, active data, and rendered scene objects
- Render adapter support for both benchmark candidates with profile-derived units/meter
- Sandbox startup benchmark and HUD display of the selected profile

## Stabilized streaming performance

Recorded 2026-07-22 on Windows 10.0.26100, Node v26.5.0, Intel Core i7-10700K. The run performed 65 initialized/crossing states, generated 425 chunks, retained an 81-entry cache and 253 identity records, and never exceeded 9 render objects or 25 active data records.

| Metric (ms) | Samples | p50 | p95 | Max |
|---|---:|---:|---:|---:|
| Generation | 425 | 4.446 | 21.644 | 28.169 |
| Projection (static adapter) | 369 | 0.000 | 0.001 | 0.020 |
| Load (static adapter) | 369 | 0.001 | 0.002 | 0.021 |
| Unload (static adapter) | 360 | 0.000 | 0.002 | 0.019 |
| Rebase (static adapter) | 64 | 0.001 | 0.002 | 0.016 |
| Crossing | 64 | 5.093 | 7.000 | 8.416 |

Warnings: none. Browser frame/GPU metrics remain instrumented in the HUD and are not fabricated by the static harness.

## Verification

- Finite World suite at the formal checkpoint: 193/193 passed
- W1A suite: 16/16 passed
- W1B suite: 6/6 passed
- Combined Infinite branch suite: 216/216 passed
- Moving-HEAD regression guard repaired independently in commit `736fe57`; finite files remain compared to `f8bc9f80c2af417bb585bff26c99522c4229ab8e`
- 128-direction-change stress: cache ≤81, identity audit ≤512, active data exactly 25, rendered/live groups exactly 9
- Duplicate queued transition test: one real transition, four coalesced, no regeneration or scene growth
- Post-eviction changed-content injection: rejected by identity audit
- W1A identity guard: Chunk ID, content hash, and proxy Stable IDs unchanged by benchmarking
- Finite Gameplay World: unchanged and retained as regression baseline
- External libraries/packages, Worker, and LOD: not introduced

## Residual risk carried into W2

- Real browser GPU/frame behavior requires manual observation through the existing HUD.
- The W1A flat terrain and sandbox proxies remain temporary; W2 must replace terrain without connecting settlements or Gameplay.
- W2 must introduce its own generator version/schema so W1A golden outputs stay queryable and unchanged.
