# W7B Milestone - Camera, Input, and HUD Parity

## Outcome

W7B connects the finite World camera and input conventions to the existing W6
runtime. Camera pitch, distance, near plane, movement, jump, attack radius, and
scale switching continue to read the protected Tiny, Mid, and Max contracts;
the Shell does not duplicate those values.

The normal view now exposes the production-style HP, damage score, Scale,
compass, crosshair, optional FPS, pause/settings, title, and help UI. Infinite
World diagnostics are hidden during normal play and available through the Tab
debug overlay. Boss and nuclear UI elements remain explicitly inactive until
W7D and have no dummy gameplay state.

The Shell is a read-only adapter over the existing `InfiniteWorldState` and
`InfiniteGameplayRuntime` snapshots. It adds no gameplay state, entity registry,
or save system.

## Controls

- Pointer lock with mouse yaw/pitch and wheel zoom.
- Camera-relative WASD, protected-stage jump, and Shift sprint.
- Mouse or Q/F single/double attack routes to the existing W6 attack API.
- 1/2/3 Scale, P/L save/load, H HUD visibility, Tab debug, and pause/settings.
- Title return and logical review-spawn reset without rebuilding the World.

## Verification

- Finite World checkpoint suite: 194 / 194.
- Infinite World W1A-W7B suite: 90 / 90.
- Full worktree suite: 284 / 284, skip 0.
- Browser-equivalent boot and recursive HTTP module graph: pass.
- JavaScript syntax, local imports, and `git diff --check`: pass.
- Chrome: World rendered with one canvas; start, normal HUD, debug overlay,
  pause/resume, inactive W7D shells, 9/9 rendered/simulated Chunks, and 25/25
  prefetched ChunkData confirmed.
- W7A fixed-condition performance remains below the 33 ms p95 continuation
  gate; W7B introduces no Geometry, Material, or Chunk-owned GPU resources.
