# P1 Chunk Streaming Stabilization — Stage 1

## Fixed reproduction

- Defect: player movement hitches and feels briefly blocked while crossing a logical Chunk boundary.
- World seed: `KaniNingen Infinite Natural World`
- Quality: `high`
- Scale: `TINY`, `MID`, and `MAX`
- Movement: straight and diagonal, with and without Sprint
- Crossings: 12 logical Chunk boundaries per run
- Save: one run without an autosave and one run with an autosave request during movement

## Stage 1 scope

Prepare the next target 5×5 data set and 3×3 render set from the player velocity before the boundary. The matching boundary commit may only attach prepared data/projections; distant synchronization, diagnostics, and non-essential Gameplay presentation are scheduled after that commit.

Chunk size, active/render set dimensions, movement speed, generator schema, World content, fog, Settlement, Boss, and Save schema are out of scope.
