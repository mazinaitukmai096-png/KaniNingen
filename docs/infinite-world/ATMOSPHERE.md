# Atmosphere and colour grading

Why the Infinite World's fog, sky and lights hold the values they do, and what they were
measured against. The goal was to bring this world's mood closer to the finite game
(`index.html` / `src/game.js`), whose ground reads bright yellow-green and whose distance
loses saturation into haze, where this world's green had gone saturated and its distance
had gone pale.

Both applications run THREE **r0.160.0**, so nothing here is a renderer-version difference.

## Where the values live

`W8_ATMOSPHERE` in `sandbox-boot.js` is the only source for the rig. `fogColorHex` is not a
value there but a reference to `W8_RENDER_FOG_COLOR_HEX`, because two shaders fog themselves
against that same constant - see "The horizon is one colour" below.

The light values are asserted as literals in `infinite-world-w5-sandbox-boot.test.mjs`.
That is deliberate and differs from how fog is asserted: fog is checked *through* its shared
constant because several places must agree with it, while the light rig has exactly one
source and what needs catching is the value changing unnoticed. Changing the rig means
changing those numbers in the test too.

## The two rigs, side by side

| | finite game | Infinite World (now) | before `e03b68b` |
| --- | --- | --- | --- |
| fog type | `Fog` linear | `Fog` linear | `Fog` linear |
| fog colour | `0x5dade2` | `0x5dade2` | `0x5dade2` |
| fog near | 3,000 | 3,000 (finite units) | same |
| fog far | 12,000 / 9,000 / 6,500 | 12,000 / 8,727 / 6,545 | same |
| tone mapping | none, exposure 1.0 | ACESFilmic, exposure 1.15 | none |
| output colour space | sRGB (r152+ default) | sRGB (explicit) | sRGB |
| hemisphere sky | `0xffcfa0` | `0xffcfa0` | `0xffcfa0` |
| hemisphere ground | `0x4a5c2e` | `0x4a5c2e` | `0x4a5c2e` |
| hemisphere intensity | 1.3 | 1.0 | 1.3 |
| sun colour | `0xffeb3b` | `0xffefa8` | `0xffeb3b` |
| sun intensity | 1.2 | 1.35 | 1.2 |
| fill light | none | `0x9ab8d6` @ 0.3 | none |
| sky | flat `0x5dade2` | gradient `0x2f74b4` → `0x79b0da` → `0xd9e7ef` | flat `0x5dade2` |
| ground albedo | `0x7d8f4f` / `0x5c6b38` / `0x8fae4f` | identical | identical |

Fog distances are compared in finite units: the Infinite World's are in render units and
`FINITE_TO_INFINITE_RENDER_SCALE` is 256/40 = 6.4.

**The ground albedo is identical in both.** `src/game.js:837-839` and
`w8-surface-policy.js:40-42` hold the same three colours. The difference in how the ground
reads was never the terrain colour; it was entirely lighting and tone mapping. Anyone
reaching for the terrain palette to change the mood is about to fix the wrong thing.

## Why each light value is what it is

Everything in the rig changed in one commit, `e03b68b`. Before it, fog, sky and lights were
identical to the finite game and there was no tone mapping.

- **Hemisphere colours are the finite game's, exactly.** The warm peach sky and olive earth
  bounce are what tilt the ground yellow-green. Switching them was tried one at a time
  against the live world, and the ground colour followed the hemisphere ground bounce, not
  the sun - the previous `0x5c4a30` brown was the single largest contributor to the
  saturated look.
- **The sun is not the finite game's.** `0xffeb3b` is strongly yellow, and warm skylight plus
  a yellow key add up rather than averaging. With the hemisphere already warm, the finite
  sun made the whole frame too yellow. `0xffefa8` sits between the two rigs: the red channel
  is `ff` in every candidate, so the blue channel is what sets the yellowness -
  `3b` (finite) … `a8` (chosen) … `cf` (previous).
- **Intensities stay at this world's values** (hemisphere 1.0, sun 1.35). The finite game's
  1.3 and 1.2 were balanced against a flat sky and no fill light; this world has a gradient
  sky and a fill light, so its own intensities remain correct.
- **The fill light stays.** The finite game has none. It lifts silhouettes off the sky here
  and was not part of what read wrong.
- **Tone mapping stays** ACESFilmic at 1.15. The pale distance turned out to be the fog
  colour, not the curve, so there was no reason to touch it.

## The horizon is one colour

Scene fog once held its own `0xd7e6ee` while two layers fogged themselves toward
`W8_RENDER_FOG_COLOR_HEX` = `0x5dade2` with scene fog switched off:

- distant Natural, in its own shader at 0.88 strength (`w8NaturalFogColor`)
- remote Settlement silhouettes, at 0.72 rising to 0.96
  (`settlement-presentation-policy.js`) - and only at the `current` render distance, where
  `remoteEnabled` is true

So the world hazed to two colours at once: ground and sky toward near-white, the Trees and
Buildings standing on them toward blue. At 0.96 blend a distant silhouette resolved to
`#5ca8db` against a `#d7e6ee` background, when sharing the scene's colour would have put it
at `#d1dfe6` - it separated from the horizon instead of dissolving into it.

`W8_ATMOSPHERE.fogColorHex` now references that constant rather than copying its value.
The boot test asserted the literal too, which is how the two drifted apart with nothing
failing; it now asserts through the constant.

## Unresolved: the sky's lowest stop no longer meets the fog

`skyHorizonCss` is `#d9e7ef`. Scene fog is `#5dade2`. Measured off the generated sky
texture, the gap is **R +124 / G +58 / B +13**.

Before `e03b68b` the sky was flat `0x5dade2` and matched the fog exactly, so no seam
existed. The gradient sky introduced the mismatch, and pointing fog back at the shared
constant left the sky behind.

It is currently invisible: a band of Trees covers the horizon in the terrain seen so far.
It should be expected to show wherever Trees do not grow - badlands, water, or any view down
from height. If it does, the fix is to bring the gradient's lowest stop to the fog colour so
the sequence runs deep blue → mid blue → fog, rather than changing the fog.

## How this was measured

A temporary `__w8Atmosphere` console hook switched each element independently against the
running world, then was removed once the values were settled: with the rig now sharing one
source, leaving a runtime switch for half of it would reopen the hole that sharing closed.
The finite game's values are recorded in the table above so the comparison does not have to
be rebuilt to repeat the exercise.
