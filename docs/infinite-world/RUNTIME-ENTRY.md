# Infinite World runtime entry

The official KaniNingen full-experience runtime is `infinite-world-sandbox.html`.
It boots deterministic Infinite World terrain, the W5 Settlement distribution,
production visual assets, nearby-Chunk Gameplay simulation, Stable-ID destruction,
Human/Tank combat, manual Boss and Nuclear gameplay, and versioned save migration.

The finite World remains byte-for-byte protected at `index.html` and continues to
serve as the regression entry pinned to commit
`f8bc9f80c2af417bb585bff26c99522c4229ab8e`.

Controls: WASD moves, Shift sprints, mouse controls the camera, wheel zooms,
1/2/3 selects Tiny/Mid/Max, Space jumps, Q/F use the protected single/double
attack contracts, and P/L saves or loads the current seed-specific Infinite World
state. H hides the HUD, Tab opens diagnostics and the manual Boss control, and
Escape opens settings. A charged left+right mouse release while airborne at Max
Scale triggers the protected Nuclear attack.

W7 saves use schema version 2 and retain read compatibility with W6 saves. Save
validation and migration complete before the existing live World State is changed.
