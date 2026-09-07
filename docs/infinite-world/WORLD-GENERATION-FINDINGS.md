# World generation findings

What the Infinite World generator actually does, measured rather than read off the
parameter tables. Recorded from two surveys: one of the biome / terrain / water
fields, and one of why Settlements are built at 5-15% of their own requested
building count.

Nothing here is a defect list. These are the facts that were surprising enough to
send an investigation down the wrong path once, and the measurements a future
change should start from instead of re-deriving.

All figures use the default seed `KaniNingen Infinite Natural World` unless noted.
The measurement scripts were throwaway; the method is described well enough to
rebuild each one.

## Read this before designing anything on top of biomes

**Biomes are not tiles. They are a four-component weight vector, and every point in
the world is mid-transition.** `natural-biome-field.js` evaluates all four of
`NATURAL_BIOME_ORDER` at every position and normalizes them to 1; `primaryBiomeId`
is just the argmax. There is no boundary, no adjacency table, and no transition
code, because none is needed.

Over 263,169 samples on a 16 m grid across 8.2 km:

| | primary | mean membership |
| --- | --- | --- |
| `temperate-grassland` | 71.16% | 38.80% |
| `mixed-woodland` | 17.71% | 32.92% |
| `rocky-highland` | 9.80% | 20.82% |
| `wetland` | 1.33% | 7.46% |

**The largest second-place membership observed anywhere was 0.462.** No point in the
world is dominated by a single biome. Any design that assumes "you are in biome X"
has to define its own threshold, and that threshold will never be satisfied by a
clean margin.

**`rocky-highland` is not a region, it is slope noise.** Contiguous primary-biome run
lengths along 24 east-west scanlines at 8 m sampling:

| | median | mean | p90 | max |
| --- | --- | --- | --- | --- |
| `temperate-grassland` | 88 m | 180 m | 464 m | 1856 m |
| `mixed-woodland` | 64 m | 98 m | 208 m | 824 m |
| `wetland` | 32 m | 71 m | 136 m | 416 m |
| `rocky-highland` | 16 m | 24 m | 56 m | 216 m |

A 16 m median is two terrain samples wide. Walking never produces the experience of
"being in the highlands". Of the four biomes, one is already not functioning as a
region.

The field is driven by three noise layers - temperature at 1536 m spacing / 3
octaves, moisture at 768 m / 3, forestPatch at 224 m / 2 - mixed with elevation,
slope, ridge and valley from `G5_MACRO_TERRAIN`.

### `NATURAL_BIOME_DEFINITIONS.displayColor` is dead data

Nothing reads it. Ground colour comes from `materialWeights` through
`w8TerrainColorFromWeights` and `W8_PRESENTATION_TERRAIN_PALETTE` (five entries:
grass / drySoil / wetSoil / sand / rock). Changing `displayColor` changes nothing.

### Ambient decoration ignores biomes entirely

`createAmbientDetails` in `w8-parity-chunk-generator.js` places Grass, Flower and
Bush on a flat `roll > 0.72` per 2 m cell, with a `0.66 / 0.88` type split. It never
samples the biome field. Only *formal* vegetation - Trees, and the shrub candidates
from `chooseVegetationSubtype` - responds to biome, through `habitatUpperBound` in
`formal-natural-chunk-generator.js` and `habitatScore` in
`w8-natural-presentation-policy.js`.

So "make the woodland denser" is two separate changes in two unrelated files, and
the one that dominates what the player sees at close range is the one with no biome
input at all.

## There is no sea level, and the whole world is 6.4 m tall

`seaLevel`, `waterLevel` and `ocean` appear nowhere in the source.

Natural ground height is `0.4 m + macro.offsetMm / 1000`, and `offsetMm` is clamped
to `±G5_MACRO_TERRAIN.maximumOffsetMm` = ±3200 mm. The entire infinite world
therefore lives between -2.8 m and +3.6 m. Measured:

```
min -2.036   p01 -0.637   p50 1.121   p99 2.729   max 3.600   (metres)
samples below y=0: 7.42%
```

**y = 0 is not a water plane.** It is 40 cm below the nominal ground datum, and 7.42%
of the world is already below it as dry land.

Existing water is two kinds of decorative quad placed at terrain height, with no
volume, shore, buoyancy or underwater rendering:

- **River** - one infinite straight line for the whole world
  (`slope 0.37, intercept 3.2`, width 1.5 m, depth 4 cm). It does have a proper
  `clearanceRadiusMeters` mechanism for detouring around Settlements.
- **Wetland** - 0.5 m terrain cells where `moisture >= 0.64` and the cell is flatter
  than 0.42 m, capped at 24 per chunk. **Near-only**: `w8-distant-presentation.js`
  projects `waterType === 'river'` and nothing else.

### Why a sea is not a local change

The amplitude budget is the reason. `natural-biome-field.js` divides by those same
amplitudes - `ridgesMm / 1450`, `valleysMm / 820`, `(elevationMeters - 0.85) / 2.1`.
Enlarging the vertical range to fit an ocean re-scores every biome membership in the
world. It is not possible to add depth without redistributing biomes.

### The natural height formula exists in four places

This is the same shape as the `fpsCap` and fog-colour bugs: a value defined on one
side with nothing consuming it on the other.

- `natural-chunk-generator.js:117` - `400 + macro.offsetMm`
- `render/w8-distant-presentation.js:3087` - `0.4 + macro.offsetMm * 0.001`
- `render/w8-distant-presentation.js:3374` - `400 + macroEvaluator.evaluate(...)`
- `natural-biome-field.js:135` - `0.4 + macroSample.offsetMm * 0.001`, for its own
  elevation term

Anything that changes the ground datum has to change all four, and missing one
produces "the distance has no sea" rather than an error.

## Settlements: the size classes exist, the buildings do not

Village / town / city is already fully written down - three `SETTLEMENT_TYPES`, six
`townType` roles, and per-class tables for road parameters (22 fields), profiles,
building composition, palettes and tower limits. What is missing is buildings.

Measured with the production configuration (`road-graph-v3` + `settlement-lot-v2`) -
TOWN and RURAL from the 43 Settlements within 3 km of the origin, CITY from all 18
within 15,744 m, since the origin neighbourhood contains none.

**These are the figures before the slot-pitch fix below**; the whole section describes
the state that motivated it. Post-fix numbers are in "Effect".

| | n | built (min/med/max) | requested | built / requested |
| --- | --- | --- | --- | --- |
| CITY | 18 | 9 / 13 / 31 | 203 | 8.4% |
| TOWN | 24 | 9 / 15 / 47 | 123 | 15.0% |
| RURAL | 19 | 6 / 11 / 38 | 90-106 | 12.4% |

Every class is equally empty, which is exactly why the size difference does not read
on screen.

### `requestedBuildingCount` is measured in area; placement is measured in length

```js
requestedBuildingCount = Math.round(town.coreRadius ** 2 / 36_000)
```

`coreRadius` is in finite units (40 per metre), so this is `r_metres² / 22.5`, i.e.
**one building per 70.7 m² of core area** - a building every 8.4 m in both
directions. It is inherited verbatim from the finite game (`src/game.js:2601`).

Placement is frontage-based. Its supply is a length: road metres divided by a slot
pitch. Area grows as r², frontage as r. **The two numbers can never agree, and the
gap widens as Settlements get bigger** - which is why CITY has the worst ratio.

**`buildingShortageCount` is therefore the difference between two quantities of
different dimension, and does not mean "buildings that failed to be placed".** It is
`requestedBuildingCount - buildings.length`, reported in the template, the chunk
data and the sandbox HUD as `Buildings: 29/203`. A large value there is the expected
output of an area formula meeting a length-limited placer; it is not evidence that
anything was rejected. Read the slot funnel below instead. Until `requested` is
re-derived from supply, this diagnostic cannot be used as a regression signal in
either direction.

### Where the buildings are actually lost

`SETTLEMENT_LOT_V2_FALLBACK_PARAMETERS` is `slotSpacingMeters: 12`,
`junctionClearanceMeters: 8`. Measured funnels:

**TOWN / church_town** - requested 123, built 13

```
28 road segments, 7 routes, 294 m frontage-eligible
  -> 42 raw slot positions        floor(routeLength / 12) per route, x 2 sides
  -> 20 slots                     8 m junction clearance removes 52%
  -> 10 placed
+  1 closed block -> 4 lots -> 3 buildings (1 lot left empty)
= 13
```

**CITY / capital** - requested 203, attempted 64, built 11

```
22 road segments, 5 routes
  -> 34 raw slot positions
  -> 16 slots                     junction clearance removes 53%
  ->  8 placed
+  6 lots -> 3 buildings (3 lots left empty)
= 11
```

**RURAL / residential** - requested 106, built 13. RURAL takes a different path
entirely (`buildDeterministicRuralFrontageFallbackBuildingsV2`), which already
publishes its own funnel in `validation`:

```
192 m frontage-eligible -> 138 m usable after 5 m junction clearance
  -> 27 raw candidates            5.5 / 9 / 20 m intervals by road class and core band
  -> 21 viable                    6 rejected ROAD_OVERLAP
  -> 13 selected                  8 rejected by candidate conflict
```

**No rejection reason is the bottleneck.** In the non-RURAL fallback,
`FRONTAGE_SPOT_CONFLICT` accounts for 89-99% of *slot evaluations*, but that is a
loop artefact: the outer loop retries all 123 building indexes against all 20 slots,
so once 10 slots are taken every later evaluation conflicts. The number that matters
is slots -> placed, which is 20 -> 10 and 16 -> 8. Roughly half the supply converts,
and the supply is 20.

### The slot pitch was more than twice what the frontage rule requires (fixed)

`getFrontagePairGaps` in `building-frontage.js` gives `house|house` a minimum
separation of `90 + 90 + 35` = 215 finite units = **5.375 m** radially, and
`90 + 90 + 20` = 200 = 5.0 m along the route. The fallback laid slots every **12 m**,
then deleted those within 8 m of a junction. On routes that are 22-36 m long - which
is most of them - the junction clearance ate both ends.

Both values are now derived rather than literal; see "Deriving the fallback slot
pitch" below.

For comparison, the legacy finite-game path (`createMigratedSettlementTemplate`)
places 49-52 buildings in a CITY across roughly 219 m of internal road: 23 per 100 m,
against `road-graph-v3` + lot-v2's 4.4 per 100 m. The legacy layout is denser because
it is smaller - its RURAL road network is a 24 x 30 m cluster with a maximum radius of
18.9 m inside an 87.75 m Settlement, while road-graph-v3 spans the declared radius
(130 x 88 m bounding box). road-graph-v3 spreads a similar building count over
roughly three times the area.

### RURAL has no blocks because its road graph is a tree

`blocks = 0, lots = 0` for RURAL is not a failure. Blocks are the bounded faces of a
planar graph, so their count equals the cycle rank. `road-graph-v3` sets

```js
requestedLoops = settlementType === TOWN
  ? 1 + (roll > deadEndBias + 0.35 ? 1 : 0)
  : (roll > deadEndBias ? 1 : 0)
```

with `deadEndBias` 0.68 for RURAL, so a RURAL village gets a loop 32% of the time and
is otherwise a tree with cycle rank 0. Measured: **15 of 19 RURAL Settlements had zero
blocks** (79%), against 2 of 24 TOWN. The class validation in `road-graph-v3.js`
enforces this - `RURAL cycle rank must be within 0..1`.

Measured cycle rank and block count agree exactly: RURAL 0/0, TOWN 1/1, CITY 2/2.

**RURAL does not need blocks.** 218 of 240 RURAL buildings (91%) came from
`buildDeterministicRuralFrontageFallbackBuildingsV2`, which places along road-graph
edges directly and never looks at a block. Only the 4 RURAL Settlements that happened
to draw a loop reach the Lot path at all, and those take the *non*-RURAL fallback,
because the branch is on `closedBlockCount === 0` before it is on settlement type.
Chasing `blocks = 0` for RURAL would be work on a path that is not the one building
the village.

### The CITY cap of 64 is a generation-cost bound, not a design statement

```js
const attemptedBuildingCount = town.settlementType === SETTLEMENT_TYPES.CITY
  ? Math.min(requestedBuildingCount, 64)
  : requestedBuildingCount;
```

It appears in three places (`single-rural-settlement.js:256`,
`lot-building-adapter-v1.js:283`, `settlement-lot-v2.js:823`), introduced in `4a666c8`
alongside `anchorSearchLimit = Math.min(anchors.length, 16)` - both CITY-only, both
added in the same commit. `W5-MILESTONE.md` states the intent plainly: "CITY template
search is bounded while retaining the formal requested count and shortage
diagnostics", and "current finite Frontage/Lot collision rules intentionally leave
building shortages, especially for the bounded CITY template search."

**No test asserts 64 and no document explains the value.** It is currently inert -
CITY supply is 16 slots plus 6 lots - but it becomes a live constraint the moment
supply is raised, and at that point it would make a CITY (64) smaller than a TOWN
(123). Both numbers should be derived from the same supply figure rather than one
being an area formula and the other a magic constant.

## Deriving the fallback slot pitch

`SETTLEMENT_LOT_V2_FALLBACK_PARAMETERS` no longer holds two literals:

```js
slotSpacingMeters:      Math.ceil(HOUSE_PAIR_MINIMUM_SEPARATION_METERS)  // 5.375 -> 6
junctionClearanceMeters: FALLBACK_SLOT_SPACING_METERS                    // one slot pitch
```

Was 12 m and 8 m. This is not a loosening of any rule: `frontageSpotsConflict` still
rejects everything it rejected before, and the road-overlap, Lot-overlap and
closed-block-overlap tests in the placement loop are untouched. What changed is that
the slot lattice stopped being coarser than the rule it feeds.

**6 m is a measured floor for the clearance, not a preference.** At 5 m the CITY/TOWN
fixtures in `infinite-world-lot-v2.test.mjs` start failing the frontage-direction
assertion: a building placed that close to a corner ends up nearer the perpendicular
road than the road it faces, and the test allows at most 30 degrees of error. 6, 7 and
8 all hold it; 6 is the smallest, and tying it to the slot pitch means it scales if the
pitch is ever re-derived.

### Effect

Per-stage, on the default seed:

| | TOWN church_town | CITY capital | RURAL residential |
| --- | --- | --- | --- |
| frontage-eligible road | 294 m | 248 m | 192 m |
| raw slot positions | 42 → **90** | 34 → **76** | n/a |
| slots after junction clearance | 20 → **58** | 16 → **48** | n/a |
| placed by frontage fallback | 10 → **27** | 8 → **18** | 13 → 13 |
| placed from Lots | 3 → 3 | 3 → 3 | 0 → 0 |
| **total** | **13 → 30** | **11 → 21** | **13 → 13** |

Across whole populations - TOWN and RURAL within 3 km of the origin, CITY all 18
within 15,744 m:

| | n | built before | built after | of requested | median |
| --- | --- | --- | --- | --- | --- |
| CITY | 18 | 307 | **565** | 8.4% → **15.5%** | 13 → 27 (max 31 → 49) |
| TOWN | 24 | 444 | **780** | 15.0% → **26.4%** | 15 → 31 |
| RURAL | 19 | 240 | **273** | 12.4% → **14.1%** | 11 → 11 |

**RURAL barely moves, and that is correct.** A zero-block RURAL Settlement - 79% of
them - runs `buildDeterministicRuralFrontageFallbackBuildingsV2`, which has its own
interval table (collector 5.5 m, local 9 m, dead-end 20 m) and its own 5 m clearance.
Those were already at the Frontage rule when they were written. The 12 m pitch was
only ever in the non-RURAL path, so the RURAL path is the evidence that 6 m is the
right order of magnitude, not a casualty of the change. The RURAL gain comes from the
4 of 19 villages that drew a loop and therefore take the non-RURAL fallback.

**CITY still does not reach its 64 cap**: 0 of 18, maximum 49. The cap remains inert.
For scale, the legacy finite path builds 49-52 in the same Settlements, so
`road-graph-v3` + lot-v2 now reaches it at the top of the range and sits at roughly
half its density in the median.

### Placement safety after the change

Independently of the test suite, across **48 Settlements / 1,218 buildings**:

```
building footprint pairs overlapping : 0
building footprint / road overlaps   : 0
Lot rectangle pairs overlapping      : 0
minimum building centre spacing      : 5.240 m   (a house|tower pair, minimum 4.925 m)
```

And against the rule itself - every pair compared to its own
`radius + radius + passageGap`, over **18,244 pairs**: **0 closer than permitted**.
The tightest pair is a `church|tower` at 6.395 m against a 6.375 m minimum, i.e. 2 cm
of slack. That is the intended outcome: the placer now works at the rule's limit
rather than at 2.2x it.

### One test assertion was removed

`infinite-world-lot-v2.test.mjs` asserted
`metricRows.every(row => row.v2BuildingCount < row.v1BuildingCount)` - that lot-v2,
which uses only Lots and validated frontage placement, always builds fewer than lot-v1,
which pads with unvalidated legacy scatter. On the six CITY/TOWN fixtures v2 went
16/15/10/15/31/18 to 33/30/23/33/49/37 against an unchanged v1 of 46/39/46/41/43/41,
so one row now exceeds v1. The inequality described the shortage rather than a property
worth keeping, and the ratio does not separate the two regimes cleanly enough to become
a bound (before 0.22-0.72, after 0.50-1.14).

It was replaced by `v2LotBuildingCount === v1LotBuildingCount` - both modes share the
Lot stage, so its yield must be identical - and by a new test that asserts the pitch
derivation directly: at least the `house|house` minimum, below twice it, and clearance
equal to the pitch.

Two pinned chunk content hashes in `infinite-world-road-generation-tail-latency.test.mjs`
also moved, because chunk content now contains more Buildings:

```
REPORTED_OWNER_CONTENT_HASH    sha256:d3f2838c... -> sha256:f1a20096...
ROAD_HEAVY_OWNER_CONTENT_HASH  sha256:9dd3b8a2... -> sha256:98308c3e...
```

The properties those tests assert - isolated / repeated / adjacent-order Worker
reproduction, and diagnostics-on equalling diagnostics-off - all still hold: every
path produced the same new hash. Only the anchor was stale.

## The Settlement radius is a scale knob, not a lever

After the slot-pitch fix, CITY still built a median 27 against a legacy 49-52, and
the remaining gap is road length. The obvious next question - add road, or shrink the
radius? - has a measured answer: **neither, because road length is downstream of the
radius.**

`road-graph-v3` emits a **fixed segment count per class** and scales its geometry to
whatever radius it is handed. Regenerating the same Settlement at several radii:

```
CITY     60.8 m  22 segs  158 m  13.6 km/km2      TOWN   47.3 m  28 segs  172 m  24.5
         85.0 m  22 segs  221 m   9.7                    66.2 m  28 segs  240 m  17.5
        121.5 m  22 segs  316 m   6.8                    94.5 m  28 segs  343 m  12.2
        157.9 m  22 segs  410 m   5.2                   122.8 m  28 segs  446 m   9.4
```

Road length is exactly proportional to radius, so density goes as 1/radius. Running
the whole placement pipeline at scaled radii:

```
factor  radius   road  density  slots  built  requested  built/requested
CITY
  0.60   72.9    189    11.3      48      8      73        11.0%
  1.00  121.5    316     6.8      82     21     203        10.3%
  1.25  151.9    395     5.4     102     31     316         9.8%
TOWN
  0.60   56.7    206    20.4      58     11      44        25.0%
  1.00   94.5    343    12.2      98     30     123        24.4%
  1.25  118.1    429     9.8     122     38     191        19.9%
```

**Shrinking a CITY to 0.6x turns 21 buildings into 8** while the ratio barely moves,
because `requested` goes as radius^2 and supply as radius^1. The shape of the problem
is invariant under the radius. Do not reach for it.

### Street density is inverted by class

```
CITY   radius 121.5 m   29 segments   411 m    8.9 km/km2   27 buildings
TOWN   radius  94.5 m   28 segments   352 m   12.5 km/km2   29 buildings
RURAL  radius  87.8 m   16 segments   237 m   10.2 km/km2   11 buildings
```

**The capital has the sparsest street network of the three**, and CITY (29 segments)
and TOWN (28) generate essentially the same number of streets - the CITY just spreads
them over 1.65x the area. Share of the disc within 12 m of any road: CITY **13.6%**,
TOWN 26.8%, RURAL 23.9%.

### The outer half of every Settlement cannot be built on

Split the disc at radius/sqrt(2), which gives two equal-area halves. The outer one:

| | road out there | frontage-eligible | buildings |
| --- | --- | --- | --- |
| CITY | 50 m, **100% arterial** | **0 m** | **0%** |
| TOWN | 40 m, **100% arterial** | **0 m** | **0%** |
| RURAL | 53 m, 69% arterial / 31% local | 16 m | 0% |

**Every one of the 95 arterial segments across all 48 Settlements carries
`frontageEligible: false`.** In CITY and TOWN the outer half contains nothing but
arterials, so it has zero buildable frontage by construction. Half the declared
Settlement area is empty because of the road class that reaches it, not because the
radius is too large.

### Three road parameters are unread on the production path

Declared in `SETTLEMENT_ROAD_PARAMETERS`, consumed by `road-graph-v1`,
`road-graph-v2` and the finite game's `road-town-structure.js` - and referenced
**zero times** by `road-graph-v3`, which is the production generator:

| | value | v3 references |
| --- | --- | --- |
| `alleyCount` | CITY 2 / TOWN 1 / RURAL 3 | 0 |
| `roadLengthMultiplier` | CITY 1.02 | 0 |
| `sampleSpacing` | CITY 48 | 0 |

Measured: **0 alley segments across all 48 Settlements.** `ROAD_GRAPH_CLASSES.ALLEY`
exists and `roadWidths()` derives a width for it; only the generation side is missing.
Same shape as `fpsCap` and the fog colour. Alleys are the class that subdivides a
block, which is exactly what raises density.

### A connected CITY is emptier than an isolated one

```
mode                    n  segs  eligible segs  eligible len  routes  raw slots  slots  built
ISOLATED_FALLBACK       5    20        20           412 m       5       136      106     47
CONNECTIVITY_GATEWAYS  13    29        26           295 m       6        98       52     25
```

Two losses compound. Buildable road drops 412 -> 295 m (-28%) because the arterial
gateways are ineligible, and splitting 26 eligible segments across 6 routes shortens
every route, so junction-clearance survival falls from 106/136 (78%) to 52/98 (53%).
**A CITY that is connected to its neighbours builds about half as much as one that is
isolated.**

### How the legacy path fills the same radius

The earlier note that the legacy layout is "a 24 x 30 m cluster" is true of its
*internal* roads and misleading about its buildings:

```
CITY legacy   internal road  115 / 110 /   0 /   0  m   (0-30 / 30-60 / 60-90 / 90-125 m)
              buildings       18 /  19 /   6 /   8
CITY v3       road            83 / 116 /  73 /  44  m
              buildings        5 /  12 /   4 /   0
```

Legacy puts 14 of its 51 buildings beyond 60 m, where it has no internal road at all.
They front the **594 m of MAJOR gateway road** that `createMigratedHierarchy` bolts on
by inventing three neighbour towns at 200 m. The Infinite World has a real
inter-settlement network instead - and classifies it arterial, which forbids frontage.
The exact mechanism the legacy capital uses to fill its outer ring is the one v3
closes off.

## Settlement distribution

Accepted Settlements within 15,744 m of the origin: **748** - CITY 18, TOWN 544,
RURAL 186. One per 0.89 km² near the origin.

**The world is 73% TOWN.** The cause is in `TYPE_PAIR_MINIMUM_DISTANCE_METERS`, which
is derived from the finite game's six town centres:

```
RURAL-RURAL  504.9 m      TOWN-TOWN  394.2 m      CITY-CITY  1536 m
```

**Villages are spaced further apart than towns.** `W5-MILESTONE.md` records the
original distribution as 249 RURAL / 181 TOWN / 23 CITY under a flat 640 / 960 / 1536
contract; deriving the distances from finite town centres flipped the mix, and
nothing recorded that it had.

### CITY rarity near the origin is real, and not a bug

`urbanization` is an independent noise field - not derived from terrain or biome -
sampled on the 768 m Macro Region lattice at spacings of 6 and 17 regions. Thresholds
are `town: 0.42`, `city: 0.67`. Across 4,004,001 regions spanning ±3072 km:

```
RURAL (u < 0.42)          33.46%
TOWN  (0.42 <= u < 0.67)  49.68%
CITY  (u >= 0.67)         16.85%
min 0.0040   p50 0.4998   p99 0.8534   max 0.9907
```

But in the 17 x 17 regions around the origin the field peaks at 0.6118, so **the
nearest CITY on the default seed is 9.08 km away**, at (-8057, 4196). That is ordinary
local variation in a smooth field - and it makes CITY hard to inspect, because the
sandbox spawns at the nearest Settlement.

**To get a CITY at spawn, use a seed.** `?seed=` is read in `sandbox-boot.js`.
Measured home Settlements:

| seed | home | distance from origin |
| --- | --- | --- |
| `KaniNingen Infinite Natural World` | RURAL / suburb | 0.66 km |
| `city-probe-35` | **CITY / capital** | 0.80 km |
| `city-probe-31` | **CITY / capital** | 2.07 km |

`infinite-world-sandbox.html?seed=city-probe-35` spawns directly in a capital.

A seed changes the whole world, so this is a development probe rather than a fixture -
but the two above were found by scanning 40 candidate strings for a CITY within 2500 m
of the origin, which takes seconds and can be redone for any property worth
inspecting.

## Also worth knowing

- **28% of CITY Settlements have no connectivity gateways.** `buildConnectivityGraphNear`
  searches for neighbours at `connectivity.queryRadiusMeters` = 1536 m; 5 of 18 CITY
  Settlements had no accepted Settlement inside that radius and fell back to
  `ISOLATED_FALLBACK` / `CLASS_GRAMMAR_WITHOUT_FICTITIOUS_GATEWAYS`, a different road
  grammar. CITY road output is therefore bimodal in a way TOWN and RURAL are not
  (0 of 5 sampled each).
- **Biome affects whether a Settlement may exist, never how large it is.**
  `terrainSuitability` gates on wetland / rocky-highland / grassland / woodland weights
  and slope with a 0.34 floor; `urbanization`, which picks the class, is an unrelated
  field.
- **`road-graph-v3` validates its own class invariants and throws.** Passing a
  connectivity graph built at the wrong radius produces more gateways than the RURAL
  grammar allows and raises `invalid road-graph-v3: RURAL requires one collector route`.
  The production caller passes `candidate.radiusMeters`
  (`distributed-settlement-chunk-generator.js:407`); anything reproducing the pipeline
  offline must do the same.
