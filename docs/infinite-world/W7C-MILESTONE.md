# W7C Milestone - Core Combat Gameplay Parity

## Outcome

W7C extends the existing W6 `InfiniteWorldState`, entity registry, active-Chunk
simulation, Stable-ID damage records, and save API. It does not create a second
gameplay state, player record, entity registry, or persistence path.

- Human flee/idle and Tank engage/fire AI run only in the nine Simulation
  Chunks. Tank projectiles are transient and are removed with their owner Chunk.
- Tank fire interval, projectile speed/life/radius/damage, attack damage and
  cooldown, entity HP, score, camera shake, and building hit-stop values come
  from the protected finite gameplay contracts.
- Player HP, healing, Score, feature damage, and entity damage mutate the one
  World State. Stable-ID state survives unload/revisit.
- Building destruction uses 32/65 ms finite hit-stop, protected shake behavior,
  shared low-poly impact/destruction visuals, and no per-effect GPU resource.
- Zero HP enters Game Over. Retry resets the existing World State and refreshes
  the current registry/render projection; it does not construct a parallel
  runtime.
- The existing knockback path updates the same logical player record and is
  ready for the protected Boss forces in W7D.

## Verification

- Finite World checkpoint suite: 194 / 194.
- Infinite World W1A-W7C suite: 97 / 97.
- Full worktree suite: 291 / 291, skip 0.
- Tank damage is absent with no active Simulation Chunk and resumes only after
  deterministic entity revisit.
- Projectile/effect render sets return to zero on unload/shutdown.
- Building destruction, score, healing, death, Retry, and hit-stop tests: pass.
- Browser-equivalent boot, recursive HTTP graph, syntax, imports, boundary,
  determinism, resource lifecycle, and `git diff --check`: pass.
- Chrome: one canvas, 9/9 rendered/simulated Chunks, 25/25 prefetched data,
  attack/destruction and HUD Score updates confirmed. Representative active-play
  frame p95 was 12.20 ms with no runtime performance warning.
