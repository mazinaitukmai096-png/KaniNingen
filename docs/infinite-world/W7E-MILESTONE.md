# W7E Milestone - Save Migration and Full Experience Cutover

## Outcome

W7E extends the existing `InfiniteWorldState` and `InfiniteWorldSaveStore`; it
does not create a second Gameplay state, entity registry, player record, or save
system. The Infinite World save payload is now explicit schema version 2 and
contains the logical World Seed, Player position/Scale/HP, score, damaged and
destroyed Stable IDs, damaged entity records, manual Boss, Nuclear cooldown,
HUD visibility, and settings.

Original W6 saves and the W7D-era W6 payload are accepted through the old
envelope. They are cloned into a temporary version-2 candidate, validated in
full, and only then applied to the live World State. Original natural Boss
records are removed during migration; a W7D manual Boss is retained only when
its Stable ID resolves to the matching Boss record. Invalid JSON, envelope,
checksum, schema, actual Seed, Scale, Stable ID, numeric range, settings, or
manual-Boss reference leaves the live state unchanged.

`infinite-world-sandbox.html` is the official full-experience entry and now
reports `W7 / FULL EXPERIENCE` throughout its module bridge and boot stages.
The protected finite regression entry remains `index.html`.

## Verification

- Finite World checkpoint suite: 194 / 194.
- Infinite World W1A-W7E suite: 112 / 112.
- Full worktree suite: 306 / 306, skip 0.
- W6 original-save migration, W7D manual-Boss migration, complete v2 round-trip,
  corruption rejection, cross-registry Stable-ID collision rejection, and
  no-partial-apply behavior: pass.
- JavaScript syntax, local imports, recursive HTTP module graph,
  browser-equivalent boot, deterministic generation, Chunk boundaries,
  unload/revisit persistence, resource lifecycle, and `git diff --check`: pass.
- Chrome fresh entry: Ready, one canvas, World drawn, 9/9 rendered and simulated,
  25/25 prefetched, Atomic ready, manual Boss, Tiny restore, HUD restore, and
  P/L save status confirmed without a runtime failure HUD.
- Chrome legacy fixture: an existing W6 browser save loaded successfully into
  the W7E runtime with 406 persisted destruction records.

## Performance and resources

The fixed W7 production-asset protocol remains the performance gate: 1920 by
1080, fixed Seed/logical position/camera, ten-second warm-up excluded, and
thirty-second foreground samples.

- Steady frame: p50 6.10 ms, p95 12.10 ms, max 248.50 ms.
- Chunk-crossing frame: p50 12.10 ms, p95 12.30 ms, max 1018.20 ms.
- Crossing generation: p50 15.50 ms, p95 18.30 ms, max 20.70 ms.
- Projection: p50 1.80 ms, p95 2.90 ms, max 3.20 ms.
- Load and unload: p95 0.10 ms each.
- Representative steady resources: 89 draw calls, 14 WebGL geometries,
  26 shared materials, and 146 Scene objects.
- After 22 crossings: 9 rendered, 25 active data, cache 81/81, 43 draw calls,
  12 WebGL geometries, 26 shared materials, and 84 Scene objects.

The 33 ms p95 continuation gate passes. W7E adds no renderer resource and no
Worker, LOD, external library, Growth, Wanted, Threat, Nation, public opinion,
or fall-state system.
