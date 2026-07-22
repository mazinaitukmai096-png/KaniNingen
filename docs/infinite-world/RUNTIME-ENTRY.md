# Infinite World runtime entry

The official KaniNingen runtime is `infinite-world-sandbox.html` from W6 onward.
It boots deterministic Infinite World terrain, the W5 Settlement distribution,
nearby-Chunk Gameplay simulation, Stable-ID destruction persistence, and save/load.

The finite World remains byte-for-byte protected at `index.html` and continues to
serve as the regression entry pinned to commit
`f8bc9f80c2af417bb585bff26c99522c4229ab8e`.

Controls: WASD moves, Shift sprints, 1/2/3 selects Tiny/Mid/Max, Space and F use
the protected single/double attack contracts, and P/L saves or loads the current
seed-specific Infinite World state.
