# Infinite World runtime entry

The official KaniNingen full-experience runtime is `infinite-world-sandbox.html`.
W8 wraps deterministic W5 terrain and Settlement distribution with the fixed
finite-World presentation, controls, combat, Boss, effects, procedural audio,
and schema-v4 save migration. The W5 source ChunkData and content hash remain intact.

The finite World remains byte-for-byte protected at `index.html` and continues to
serve as the regression entry pinned to commit
`f8bc9f80c2af417bb585bff26c99522c4229ab8e`.

Controls: WASD moves camera-relative, Shift sprints, Space jumps, mouse controls
the camera, wheel zooms, and left/right/both mouse buttons drive the corresponding
claw commands. A charged both-button release while airborne at Max Scale triggers
Atomic. H hides the HUD and Escape opens settings.

1/2/3, Q/F, P/L, Tab diagnostics, manual save/load, Scale controls, and manual Boss
are accepted only while Developer Tools is enabled in settings. Developer Tools is
off by default.

W8 saves use schema version 4. Previous W8 schema version 3 and historical W7
schema version 2 remain readable, with read compatibility with W6 saves. Validation and
migration complete in a temporary candidate before the existing live World State is changed.
