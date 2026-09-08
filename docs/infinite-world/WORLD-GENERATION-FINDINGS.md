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

## Alleys: investigated, not implemented

`alleyCount` is the most obvious of the three unread parameters, and it was surveyed
as a candidate lever. It was dropped: the estimate is **+2 buildings for a CITY whose
median is 27**. The findings are kept because they will otherwise be re-derived.

**The ordering is not "more alleys in bigger places".** `alleyCount` is CITY 2 /
TOWN 1 / **RURAL 3** - the village gets the most and the town the fewest, and it is
not even monotonic. In the finite game's terms that is deliberate: CITY is
`roadPattern: GRID` with `localBranchCount: 6` and gets its density from the grid,
while RURAL is `ORGANIC` with `localBranchCount: 3` and `deadEndBias: 0.68`, where
alleys are the texture of a village. Implementing `alleyCount` faithfully would
**narrow** the gap between the classes, not widen it.

**All three existing implementations do the same thing**, and none of them subdivides
a block:

| | attaches to | direction | length | frontage |
| --- | --- | --- | --- | --- |
| `road-graph-v1` | a local branch terminal | along `axis`, alternating | `radius * 0.22` | `true`, explicit |
| `road-graph-v2` | a local boundary node | along `normal`, alternating | `radius * 0.18` | `true`, explicit |
| finite game | a local-branch T where exactly 2 roads meet | parent `normal`, **outward preferred** | `max(alleyWidth*3, coreRadius * 0.13 * roadLengthMultiplier)` | on the frontage route |

Only the finite game guards the geometry (`isFullCorridorClear`,
`isSafeJunctionPoint`, `isRoadEndClear`) and records failures as
`omitRoute(..., 'END_OR_CORRIDOR_BLOCKED')`. The lengths differ by a factor of three
for the same Settlement - 8.95 m for a finite CITY against 26.7 m for v1 - so v1 and
v2 are not faithful ports.

**An alley is a leaf, so it changes no topology invariant.** It adds one node and one
edge, `cycleRank = E - V + 1` is unchanged, and since block count equals cycle rank,
**no new blocks and no new Lots appear**. That also means the natural insertion point
is the graph-generation stage, as a post-pass after the class grammar and before
`buildSegments()` - exactly where v1 and v2 put it - not anywhere downstream of block
extraction.

**Frontage needs no change**: `road-graph-v3.js:261` already sets
`frontageEligible: roadClass !== ROAD_GRAPH_CLASSES.ARTERIAL`, so an alley added
through the normal builder is eligible automatically.

**The RURAL placer is already wired for alleys and has never seen one.**
`ruralFrontageEdgeClass` maps `segment.class === ALLEY` to `'alley/dead-end'`, which
has full entries in `RURAL_FRONTAGE_EDGE_PLACEMENT_TABLE` and in
`RURAL_VILLAGE_CORE_DENSITY_GRADIENT.candidateIntervals` (CORE 14 / MIDDLE 20 /
OUTER 26 m). Every measured run reports
`rawByClass: {collector: 21, local: 6, "alley/dead-end": 0}`. This is the fourth
instance of the declared-but-never-produced shape, after `fpsCap`, the fog colour and
the Bush handoff.

**The finite game's alley length is unusable here.** RURAL comes out at 5.8 m, below
the `minimumLengthMeters: 11` that same RURAL table requires, so those alleys would be
rejected outright. It also collides with the 6 m slot pitch: `floor(5.8 / 6)` is zero
positions.

**And the slot arithmetic mostly cancels.** A new T-junction on a parent route deletes
the slot positions within the 6 m junction clearance - roughly one either side, on
both sides of the road, so about 4 slots. A 26.7 m alley offers `floor(26.7 / 6)` = 4
positions, loses the one next to its own attach junction, and keeps 3 x 2 sides = 6.
**Net gain is about +2 slots per alley**, which at the measured ~50% slot-to-building
conversion is +1 building. The pitch fix in e8f90df is part of why: tightening the
lattice raised the baseline that an alley has to beat.

| | net slots | buildings |
| --- | --- | --- |
| CITY (2 alleys) | +4 | **+2** |
| TOWN (1 alley) | +2 | **+1** |
| RURAL (3 alleys) | +3 raw candidates on its own path | **+1-2** |

**Two validation invariants would break on the obvious implementation.** Measured
headroom:

| | current | limit | with perpendicular alleys |
| --- | --- | --- | --- |
| RURAL `exactRightAngleRate` | **0.000** (3 junctions, 9 angle pairs) | < 0.25 | **6/18 = 0.333, fails** |
| TOWN `exactRightAngleRate` | 0.000 (5 junctions, 15 pairs) | < 0.50 | 2/18 = 0.111, safe |
| TOWN `localDeadEndRatio` | **0.600** | 0.15..0.65 | **0.800 if the terminal role is `'dead-end'`, fails** |
| CITY center vs outer junction density | 5.32e-4 vs 0.00 | center > outer | 5.4e-5 outer, safe |
| `cycleRank`, `collectorRouteCount` | - | class ranges | unchanged |

A degree-2 node becoming degree-3 adds three angle pairs, two of them at exactly 90
degrees if the alley is perpendicular, and the check tolerates +-1 degree.
`localDeadEnds` filters on `role === 'dead-end'` exactly, so the terminal must be
named something else - v1 and v2 use `'alley-terminal'`. v3 also validates
`selfIntersectionCount` and throws, which neither v1 nor v2 guards against.

**If it is ever implemented**, the minimum shape that passes all four invariants is:
v1's length (`radius * 0.22`), the profile's own branch-angle range rather than a
right angle (RURAL already declares 60-120 degrees and the highest `alleyCurvature`),
`role: 'alley-terminal'`, and the finite game's corridor guards with an omitted-route
record on failure.

## Arterial frontage: a graded rule that was flattened into a prohibition

The outer half of every Settlement was empty because the only road reaching it was
arterial, and arterial carried `frontageEligible: false`. That flag turned out not to
be a rule the finite game ever had.

**The finite game does not forbid frontage on a MAJOR road. It makes one a last
resort.** Three places in `src/building-frontage.js` say so:

```js
const ROAD_KIND_DISTANCE_BIAS = Object.freeze({
  [ROAD_KINDS.LOCAL]: 0,
  [ROAD_KINDS.ALLEY]: 24,
  [ROAD_KINDS.MAJOR]: 320,      // 8 m at 40 units per metre
});
```

`selectFrontageRoad` picks the road minimising `distance + bias`, so a MAJOR road wins
only when it is more than 8 m closer than any street. `buildFrontageAnchorPlan` sorts
MAJOR last (`roadPriority` 3, behind LOCAL spine, LOCAL and ALLEY). And
`createFrontagePlacement` throws
`'frontage road must be MAJOR, LOCAL, or ALLEY'` — naming MAJOR a valid frontage kind
outright. The only kind genuinely excluded is `START_APPROACH`, which has no bias
entry at all.

**A graded suppression became a boolean during the port to road-graph-v3.** Neither
commit that introduced it (`16e3a6f` for v1, `290888d` for v3) carries a message body,
and no document records a rationale. This is the `grassPatches` shape: a rule with a
middle setting, collapsed to off.

**The rest of the pipeline was already ready.** `LEGACY_KIND_BY_CLASS` maps
`ARTERIAL -> ROAD_KINDS.MAJOR`, which is the kind `createFrontagePlacement` accepts and
`ROAD_KIND_DISTANCE_BIAS` has an entry for. Every consumer of `frontageEligible` is a
segment-level boolean check. One flag at graph-build time was the whole obstruction.

### The position-dependent rule turned out to be unnecessary

The obvious design — "eligible inside the Settlement radius, not outside" — is already
satisfied by construction:

```
arterial radial extent, as a fraction of the declared radius
RURAL   0.658 .. 0.920      inside the radius: 100.0% of all arterial
TOWN    0.657 .. 0.920      100.0%
CITY    0.641 .. 0.920      100.0%
```

**road-graph-v3 never draws arterial past 0.92R.** All 95 arterial segments across 48
Settlements have `purpose: connectivity-gateway` — a single spur from the gateway
terminal inward. What actually connects Settlements to each other is
`canonical-major-road-network.js`, a separate system the frontage placer never sees.
So no rule is needed to keep buildings out of the countryside, and the placement loop's
`town.radius - APPROXIMATE_BUILDING_RADIUS[type]` gate is a second guard behind that
(measured `OUTSIDE_RADIUS: 0`).

### Arterial width costs nothing

```js
const centerDistance = road.width / 2 + profile.frontExtent + setback;
```

The setback is measured from the road edge, not the centreline, so a wider road only
pushes the building further out. A CITY house sits 4.58 m from an arterial centreline
against 4.19 m from a local one. Measured building/road overlaps: 0.

### What was implemented

`road-graph-v3.js` grants the gateway arterial `frontageEligible: true`, and
`settlement-lot-v2.js` restores the suppression where the finite game spends it:

```js
majorRoadFrontageIsPermitted(segment, position, roadGraph)
  // a point on a MAJOR road may take it only where no other class runs within
  // FINITE_ROAD_KIND_DISTANCE_BIAS[MAJOR] / 40 = 8 m of it
```

That is `selectFrontageRoad`'s rule made exact: a slot sits on its own road at distance
zero, so the road wins only when every street is more than the bias away. Slots are
also ordered by the same table, matching `buildFrontageAnchorPlan`. The finite table is
mirrored rather than imported, because `src/building-frontage.js` is byte-identity
protected against fixed commits; `infinite-world-lot-v2.test.mjs` reads the finite
source and asserts the mirror has not drifted, so the copy is checked rather than
silent.

**Ordering alone does almost nothing here, and that is worth knowing.** Sorting MAJOR
slots last changed the total from 1522 to 1516 — six buildings. Demand
(`attemptedBuildingCount` 64-123) far exceeds slot supply, so the loop exhausts nearly
every viable slot whatever the order; ordering decides which building index lands
where, not whether a slot is used. The distance rule is what actually suppresses.

| | baseline | simple flip | ordering only | distance rule (shipped) |
| --- | --- | --- | --- | --- |
| total buildings | 1218 | 1522 | 1516 | **1452** |
| CITY total / median | 565 / 27 | 741 | 740 / 42 | **705 / 39** |
| TOWN total / median | 399 / 29 | 481 | 477 / 35 | **477 / 35** |
| RURAL total / median | 254 / 11 | 300 | 299 | **270 / 11** |
| fronting an arterial | 0 | 298 | 298 | **234** |
| outer half of the disc | 29 (2.4%) | 292 (19.2%) | 292 | **263 (18.1%)** |

A connected CITY goes from 25 to 36 median, against 47 for an isolated one, so the
"more connected, emptier" inversion is reduced rather than removed.

### The zero-Block RURAL path is deliberately excluded

`ruralFrontageEdgeClass` would file a gateway arterial under `'alley/dead-end'`,
because it dead-ends at its terminal — giving a trunk road the sparsest, most informal
interval in the table under a name that means the opposite. More to the point, that
path's tested contract is collector plus local: every row in the twelve-seed
characterisation reports `deadEndFrontageCount: 0`, and the class ratios are asserted
to sum to one across those two. Putting a village on a trunk road is a separate
decision, so arterial is filtered out of that path and out of
`measureRuralUsableFrontage`, which would otherwise report frontage the village never
uses. RURAL still gains 16 arterial-fronting buildings through the 4 of 17 villages
that draw a loop and therefore take the non-RURAL fallback.

### One dormant exemption is now live

`gatewayApproachIsClear` in `canonical-major-road-network.js` skips obstacles whose
`frontageRoadStableId` matches the arterial a canonical MAJOR road is joining. Until
now no building ever fronted an arterial, so that branch never fired. Measured across
19 canonical MAJOR roads and 225 buildings: **0 road/building overlaps** — the router
is fed the Settlement's buildings and lots as obstacles
(`obstacleAudit: {buildingCount: 82, lotCount: 82}`) and routes around them, and the
approach stays inside the arterial corridor the buildings are set back from. Worth
re-checking if either width or the setback profile changes.

### A measurement error worth remembering

The first pass reported 912 of 1522 buildings violating the 30-degree frontage-direction
rule, which would have killed the change. It was wrong: `buildDeterministicFrontage-
FallbackBuildingsV2` returns buildings in Settlement-local coordinates and the adapter
translates them, while `roadGraph.segments` are already in world coordinates — the
check was comparing the two frames. Running the repo's own check against the repo's own
fixture returned 0, which is what exposed it.

**Counts do not depend on the coordinate frame; every safety number does.** Building
totals from the broken run were correct and matched an independent audit exactly
(1218). Overlap counts, angle counts and radial distributions were all meaningless.
Any future simulation that reconstructs this pipeline outside the adapter has to
translate by `candidate.center` first, and should be validated against
`resolveSettlementTemplate` on a known fixture before its numbers are believed.

The same shape happened a second time during the live check, differently dressed. A
seed was screenshotted 10 s after navigation on the pre-change build, showed a title
screen, and was read as "this seed boots"; the post-change build showed the boot
error, so the change looked like the cause. The title screen was still displaying
`起動中: Terrain` - the boot had not finished. A deterministic headless probe gave the
identical 4/6 split on both revisions, and waiting 30 s in the browser reproduced the
failure on the pre-change build too.

**A partial state and a finished state are not comparable, in either direction.**
Both mistakes were the same error: comparing two things that were not the same kind
of thing, and only the deterministic re-measurement caught it.

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

**To get a CITY at spawn, use a seed.** `?seed=` is read in `sandbox-boot.js`. But a
seed has to clear a second bar first - see "Most seeds do not boot" below - so pick
one from this list, every entry of which was boot-tested:

| seed | home | distance from origin | boots |
| --- | --- | --- | --- |
| `KaniNingen Infinite Natural World` | RURAL / suburb | 0.66 km | yes |
| `city-probe-22` | **CITY / capital** | 2.88 km | **yes** |
| `city-probe-61` | **CITY / capital** | 1.32 km | **yes** |
| `city-probe-75` | **CITY / capital** | 1.35 km | **yes** |
| `city-probe-101` | **CITY / capital** | 1.99 km | **yes** |
| `city-probe-111` | **CITY / capital** | 3.15 km | **yes** |
| `city-probe-29` | TOWN / school_town | 2.82 km | yes; nearest CITY 1.04 km from the origin |
| ~~`city-probe-35`~~ | CITY / capital | 0.80 km | **no - fails to boot** |
| ~~`city-probe-31`~~ | CITY / capital | 2.07 km | **no - fails to boot** |

`infinite-world-sandbox.html?seed=city-probe-22` spawns in a capital and boots.

An earlier revision of this document recommended `city-probe-35`, which does not boot.
It was found by scanning for "home Settlement is a CITY" and never actually launched.
Of 13 CITY-home seeds in a 120-seed scan, only 5 boot.

### Most seeds do not boot

`w8-parity-chunk-generator.js` resolves an experience spawn by looking for a wetland
pond with a clear intro camera corridor, expanding from
`W8_SPAWN_SAFETY_CONTRACT.preparedDataRadiusChunks` (2) out to 6 chunks, and throws
`no safe W8 pond spawn and intro camera corridor were found` if it finds none.

Measured over 10 arbitrary seeds: **4 boot, 6 fail.** Over the 13 CITY-home seeds:
5 boot, 8 fail. The cause is dissected in "Why most seeds do not boot" below.

**This is pre-existing and unrelated to the arterial frontage change** - the same 10
seeds give the identical 4/6 split on `0edd98a~1`. It is recorded because a
non-booting seed looks like a regression when you meet it just after changing
Settlement generation, and because "pick a seed to inspect X" is only useful advice if
the seed launches.

### The live app agrees with the offline measurements exactly

`globalThis.__infiniteWorldSandbox` exposes `generator.resolveSettlementPresentationTemplate`
and `generator.distributor.findSettlementsNear`, so a running world can be queried
directly. For the TOWN at (-1139, 2581) on `city-probe-29`:

```
live:    43 buildings, 6 fronting an arterial, 6 in the outer half
offline: 43 buildings, 6 fronting an arterial, 6 in the outer half
```

Identical, including `roadClassCounts`. The offline harness used throughout this
document reflects what the app actually builds.

## Why most seeds do not boot

The 6-of-10 failure was dissected before choosing a fix. Everything below is measured.

### It is always the pond, never the corridor

The search was instrumented to classify each round. Per candidate: does the pond
itself sit clear of buildings and roads, and does any of 32 headings offer a clear
69.3 m intro corridor?

```
seed "city-probe-35"           (FAILS)
  radius 2  (5x5 chunks,  80 m square): ponds 0
  radius 3  (7x7,        112 m):        ponds 0
  radius 4  (9x9,        144 m):        ponds 0
  radius 5  (11x11,      176 m):        ponds 0
  radius 6  (13x13,      208 m):        ponds 0

seed "KaniNingen Infinite Natural World"  (BOOTS)
  radius 2  (5x5 chunks,  80 m square): ponds 194  viable 119  no-corridor 75  pond-blocked 0
```

**Failing seeds find zero ponds at every radius.** Where ponds exist there are
hundreds, 61% of them pass the corridor test, and the pond-position test rejects none
at all. The corridor has never been the binding constraint in any sample.

### The rarity figure is not the 1.33% biome share

`createWaterSurfaces` does not gate on the wetland biome. It gates on terrain
`moisture >= W8_PARITY_CONTENT.wetlandMoistureThreshold` (0.64), plus a cell height
range under 0.42 m, plus no Settlement conflict, capped at 24 per chunk. Measured over
1,050,625 samples on a 4 m grid:

```
terrain moisture: min 0.0975  p50 0.4075  p90 0.5880  p99 0.6713  max 0.7551
at or above 0.64: 14.208% of the world
```

So the gate is **14.2%**, not the 1.33% wetland-primary share quoted earlier in this
document - that share answers a different question. 14.2% is still patchy enough to
leave large dry regions, which is what the failures are.

Distance from 40 random positions to the nearest qualifying cell:

```
within 104 m (the current radius-6 reach): 53%
within 208 m: 70%     within 320 m: 85%     within 480 m: 95%     within 600 m: 98%
p50 88 m, max 492 m, and 1 of 40 found nothing inside 600 m
```

The observed 40% boot rate sits just under the 53% the reach predicts, the remainder
being the flatness, Settlement-conflict and per-chunk-cap filters.

### The finite game has a fallback that the port dropped

`findLandingSpot` in `src/game.js`:

```js
// マップ生成後、町はずれの池のほとりをゲーム開始地点として選ぶ。
// 池が生成されていない場合はマップ中心付近にフォールバックする。
function findLandingSpot() {
    const ponds = waterZones.filter(wz => wz.isPond);
    if (ponds.length > 0) { /* start in the pond, facing the shore */ }
    return { x: 0, z: 500, facingAngle: 0 };   // <- no pond, start anyway
}
```

The pond is an authored opening - the player wakes in the water at the edge of town and
walks out - but the finite game **never treats it as a requirement**. When no pond
exists it starts somewhere else and the game begins.

The Infinite World kept the preference and dropped the fallback, turning it into a hard
throw. **This is the third instance of the same shape in this document**, after
`grassPatches` and the arterial `frontageEligible` boolean: a graded or fallback rule
flattened into an absolute one during a port.

### The two "protected pond" mechanisms are neither of these

There are two separate things named after the same pond, and today's failures involve
neither:

- `W8_PROTECTED_SAFE_SPAWN_POND_STABLE_ID` is exported and consumed once, in
  `chunk-render-adapter.js:2363`, exempting that pond from the isolated-wetland-tile
  presentation filter. Its own comment says the canonical surfaces, Stable IDs and the
  safe-spawn contract are untouched. Dropping it would make the pond invisible, not
  throw.
- `PROTECTED_SAFE_SPAWN_BOOTSTRAP` is module-private and pins pond
  `wf1:water-surface:0fdcd2fc...` at (549.75, 431.25) for the default seed's hash, with
  its own two errors (`protected W8 safe pond bootstrap no longer matches canonical W5
  data`, `...failed its current corridor validation`). **It is gated on
  `!useExperimentalRoadGraph`, and production runs road-graph-v3, so this path never
  executes in production.** Confirmed by instrumentation: the default seed goes through
  the general search and reports 194 ponds at radius 2.

### What each option would buy

| option | boot rate | cost |
| --- | --- | --- |
| today: pond only, radius <= 6 | **4/10** | 2.9 s to fail |
| widen to radius 13 (+-216 m) | ~70% predicted | 3,644 chunks, **8.2x**, ~24 s |
| widen to radius 20 (+-328 m) | ~85% | 12,331 chunks, **27.7x**, ~80 s |
| widen to radius 30 (+-488 m) | ~95% | 39,701 chunks, **89.2x**, ~260 s |
| **dry fallback, radius unchanged** | **10/10** | unchanged |

Widening is the wrong lever: cumulative chunk generation grows about as the cube of the
radius while the success rate climbs slowly, and it never reaches 100% - 1 of 40 probes
found no qualifying cell within 600 m.

The dry fallback was simulated by feeding `selectSafeExperienceSpawn` candidates drawn
from the same terrain grid `createWaterSurfaces` walks, keeping its flatness rule and
dropping only the moisture gate. Every one of the six failing seeds then found a spawn,
and only 400 of 173,056 available candidates were sampled, so the real margin is far
wider. The point and corridor tests were left completely unchanged - the same clearance
rules that a pond spawn passes today.

## The fallback, restored

`findLandingSpot`'s structure is back: pond if one exists, open ground if none does. The
pond branch is untouched, so a world with a pond starts exactly where it starts today.

### What was and was not changed

`selectSafeExperienceSpawn` was not modified at all. Its point test, its 32-heading
69.3 m corridor test, and its player and camera clearances are the same code that a pond
start passes today. The investigation had already shown that dry candidates pass those
tests unchanged, so there was nothing to relax and relaxing anything would have been the
wrong fix.

What was added is a second **candidate source**, `createDryLandingCandidates`, mirroring
`createWaterSurfaces` cell for cell - the same terrain grid walk, the same 0.42 m height
range, the same `conflictsWithSettlement(..., 0.5)` rejection, the same per-chunk budget
- with the `moisture >= 0.64` gate removed. The pond loop runs first over radii 2..6; the
dry loop runs only if it found nothing, over the same radii.

A dry landing reaches the selector through its `waterSurfaces` parameter because that is
the candidate channel the selector takes. `attributeDryLanding` then strips the pond
attribution from the result, so `pondStableId` is `null`, `dryLandingStableId` carries the
identity instead, and `spawnSafety.waterSurfaceIntersections` is empty rather than naming
a pond the player is not standing in. The HUD already rendered `Pond: none` for a missing
`pondStableId`.

### Candidate volume, not candidate quality, is what costs

The first version fed the whole prepared square's open ground to the selector: 598
candidates, and the boot went from 2.9 s of failing to **18.3 s**, of which 14.0 s was
inside `selectSafeExperienceSpawn`.

The cause is not the tests being slow, it is that open ground *passes* them. A pond
candidate wedged against a building aborts its corridor sweep on the first sample; open
ground runs all 32 headings x 73 samples to completion. Measured per candidate: 11 ms on
the pond path, 23 ms on the dry path.

The selector cannot exit early - it ranks candidates by clearance, and that ranking is
part of the contract that was deliberately left alone. So the supply was narrowed
instead. The selector already prefers candidates within `preferredPondDistanceMeters`
(16 m, exactly one chunk) of the review spawn, so the dry loop offers the owning chunk's
open ground first and widens to the rest of the square only if none of it survives. The
obstacle set stays the whole prepared square in both cases - only the candidate supply
narrows, never the safety model.

```
                                    dry-build   select     boot total
whole prepared square (598 cands)     2782 ms  13968 ms      18288 ms
owning chunk first    ( 24 cands)       21 ms    475 ms       4773 ms
```

Every seed found its landing in the owning chunk on the first try; the widening branch
has not yet been needed in any sample.

### Measured result

Same ten seeds as the 4/10 baseline, `generateChunk(0, 0)` under road-graph-v3 and
settlement-lot-v2:

| seed | before | after | landing |
| --- | --- | --- | --- |
| `KaniNingen Infinite Natural World` | boots | boots | pond, unchanged |
| `city-probe-29` | boots | boots | pond, unchanged |
| `city-probe-16` | boots | boots | pond, unchanged |
| `road-v3-seed-c` | boots | boots | pond, unchanged |
| `city-probe-35` | **throws** | boots | dry |
| `city-probe-31` | **throws** | boots | dry |
| `city-probe-3` | **throws** | boots | dry |
| `W5 distributed golden` | **throws** | boots | dry |
| `road-v3-seed-a` | **throws** | boots | dry |
| `road-v3-seed-b` | **throws** | boots | dry |

**4/10 -> 10/10.** The four pond seeds were re-run against a stashed tree and produce
byte-identical spawns: same `x`, `y`, `z`, `facingY`, `cameraYaw`, same pond Stable ID,
same clearances. The preference is intact; only the throw is gone.

The six dry landings clear the contract with room to spare - player clearance 3.33 m to
18.5 m against a 3.25 m requirement, camera clearance 3.08 m to 24.0 m against 0.6 m.
They are not marginal passes.

### The intro needs no branch

The finite game's pond opening is authored - the player wakes in the water and walks to
the shore - so a dry landing might have needed its own choreography. It does not. The
intro is a camera move plus a forced forward walk, and neither half knows about water:

- `experience-shell.js:740` drives the intro camera purely from `gameplayTimeMs`,
  `facingY` and `playerRootY`. There is no water term.
- `experience-shell.js:641` is the whole of intro locomotion: `forward = intro ? 1 : ...`
  at `0.35` speed. No buoyancy, no swim state, no wade.
- `world-state-store.js:634` `restartRun` reads only `playerSpawn.x` and `.z`. The spawn's
  `y` never reaches the player; ground height is resampled at runtime.
- `w8-natural-presentation-policy.js:158` clears vegetation along the intro corridor from
  the spawn point and `facingY` alone.

There is no swimming, buoyancy or water-collision code anywhere in the Infinite World. A
dry landing plays the identical intro, so no presentation branch was written - adding one
would have been inventing behaviour the game does not have.

## Suspect this first when porting from the finite game

Three separate investigations in this document, started from three unrelated symptoms,
each ended at the same defect: **a rule that is graded or has a fallback in
`src/game.js` became an absolute prohibition or an absolute requirement in the port.**

| finite game | port | symptom it caused |
| --- | --- | --- |
| `grassPatches`: a staged clause, thinning near Settlements | an outright ban | Grass missing where it should have thinned |
| `ROAD_KIND_DISTANCE_BIAS` MAJOR: 320 - an 8 m penalty on arterial frontage | `frontageEligible: false` - a boolean prohibition | the outer half of every Settlement held 2.4% of its buildings |
| `findLandingSpot`: pond preferred, open ground otherwise | pond required, else `throw` | 6 of 10 seeds could not boot |

The mechanism is the same each time. The finite rule expresses a *preference* through a
weight, a penalty, a staged condition or a fallback branch. Porting compresses it to the
end of its range that was easiest to reproduce - the hard end - and the intermediate
behaviour disappears. Nothing crashes at the port, and the code reads as if it were
always meant that way, so the loss is only visible much later as a shortage, an absence,
or a failure rate.

Two things follow for anyone porting more of `src/game.js`:

- **Read the finite implementation, not the ported one, when a rule looks absolute.** All
  three defects were found by opening `src/game.js` and finding the graded original -
  twice with the intent written in a Japanese comment right above it, as with
  `findLandingSpot`'s "池が生成されていない場合はマップ中心付近にフォールバックする".
- **Restore the gradation, do not just invert the flag.** Flipping
  `frontageEligible: false` to `true` would have produced something looser than the
  finite game, not equal to it; the fix reused the finite table's own MAJOR: 320 as an
  8 m suppression. Likewise, removing the pond requirement outright would have discarded
  a deliberate opening; the fix kept the pond first and restored only the fallback.


## The capital had one street

CITY was the sparsest of the three classes: 22 segments over a 121.5 m radius, 8.9 km/km2,
against TOWN's 32 over 94.5 m and 12.5 km/km2. The capital had fewer streets than a town.

### localGrowthCount resolves to 6 and was then spent down to 1

Both grammars compute the same expression, and CITY's result is the largest of the three:

```
             localBranchCount  densityMultiplier  round(branch * (0.8 + density * 0.2))
CITY                6               1.25                  6.3  ->  6
TOWN                5               1.02                  5.02 ->  5
RURAL               3               0.68                  2.81 ->  3
```

`createOrganicOrTownGrammar` grows one local branch per station from that number.
`createCityGrammar` used it in exactly one place:

```js
const deadEndCount = clamp(Math.round(localGrowthCount * profile.deadEndBias), 1, 2);
```

CITY's `deadEndBias` is 0.18, so `round(6 * 0.18)` is 1. **Every CITY grew exactly one
local street** - `localDeadEndCount` measured min 1, median 1, max 1 across all 18. The
clamp ceiling of 2 never bound; `deadEndBias` did. Measured composition:

```
CITY   city-inner-cross      4.83 seg   52.2 m   } structural cycle arcs
       city-middle-cross     1.50 seg   54.0 m   } between the radial routes
       city-local-dead-end   2.00 seg   21.7 m   <- the only street
TOWN   local-growth         10.00 seg  127.5 m   <- five streets
       partial-loop          5.36 seg   91.6 m
RURAL  local-growth          6.00 seg   72.2 m   <- three streets
       partial-loop          1.48 seg   33.1 m
```

**21.7 m of local street in a capital against 127.5 m in a town.** `deadEndBias` should
decide how many local streets end blind, not how many exist.

### createCityGrammar has no local-growth layer

CITY dispatches to a separate grammar (`road-graph-v3.js:1152`). It builds radial COLLECTOR
routes from a hub plus cross-connection arcs, and its LOCAL class is those arcs plus a
decorative stub - there is no local-growth stage at all. `localSpineCount: 2` is
repurposed there as `majorRouteCount`, the count of radial collectors, so the LOCAL spine
concept the parameter names is gone.

The finite game does have a capital grammar, and it grows **six** LOCAL branches: three on
each of two LOCAL spines (`road-town-structure.js:727`, `spine0BranchPoints` and
`spine1BranchPoints`). That is exactly `localBranchCount: 6`. The target was never a chosen
number - the profile constant, this grammar's own resolved `localGrowthCount`, and the
finite capital's actual branch count all say 6.

### The fourth porting instance, and a different sub-shape

This is the fourth time a finite-game rule arrived diminished, but it is **not** the shape
of the first three, and looking for that shape would not have found it:

| # | finite rule | what the port did | shape |
| --- | --- | --- | --- |
| 1 | `grassPatches`: staged thinning near Settlements | outright ban | graded -> absolute |
| 2 | arterial frontage: an 8 m distance penalty | `frontageEligible: false` | graded -> absolute |
| 3 | `findLandingSpot`: pond preferred, ground otherwise | pond required, else throw | fallback -> absolute |
| 4 | capital: six LOCAL branches on two spines | value resolved to 6, then multiplied by an unrelated bias to 1 | **correct value, wrong consumer** |

The first three are found by asking *"was this prohibition once conditional?"*. The fourth
would pass that test - nothing is prohibited, no branch was deleted, and `localBranchCount`
and `densityMultiplier` are both read and both correct. It is found instead by asking
**"this parameter resolves to 6 - where does the 6 actually go?"**, and following the value
to its single consumer. Trace resolved values to their use sites, not just rules to their
conditions.

### There is no radius-to-count mechanism anywhere

Segment counts derive only from `settlementType` profile constants. `radius` appears solely
as a multiplier on positions and lengths (`radius * 0.20`, `branchLength = radius * (...)`).
The proof is in the data rather than the code: radius is a per-`townType` constant - capital
121.5 m, church_town and school_town 94.5 m, residential and military 87.75 m, **suburb
81 m** - while counts key off `settlementType`. Suburb and residential are 8% apart in
radius and produce byte-identical counts. It is not a mechanism that misfires on CITY;
there is none to misfire. CITY being 1.29x the radius of a TOWN at equal counts is therefore
a guaranteed density deficit, not an accident.

### Invariant headroom, measured before changing anything

```
collectorRouteCount  2..3      min 2  med 3  max 3     at the ceiling
cycleRank            2..3      min 2  med 2  max 3     one spare cycle
centerD > outerD               outer density is 0      wide
junctionSpacing CV   > 0       min 0.264               wide
straightContinuation <= 77.8   max 53.3                wide
gatewayContinuity    < 25 deg  max 5.97                wide
exactRightAngleRate            no CITY bound (TOWN < 50%, RURAL < 25%)
```

`cycleRank` is the only tight bound, and dead-end branches do not touch it: a tree edge adds
one node and one edge. Only loops and through-connections raise it, and there is room for
about one. `centerJunctionDensity > outerJunctionDensity` holds trivially because CITY has
zero junctions outside 0.45r, and stays comfortable even with several.

### "Zero failures in 18 samples" is not evidence

Four variants were measured. The first three looked safe on the default seed's 18 CITY and
were not:

| variant | change | CITY buildings med | total (18) | **generation failures / 226** |
| --- | --- | --- | --- | --- |
| baseline | - | 39 | 705 | **0** |
| A | `deadEndCount = localGrowthCount` | 43 | 784 | 2 (0.88%) |
| B | A + the local-street length coefficient | 52 | - | 6 (2.65%) |
| C | B + the organic fallback ladder | 52 | 907 | 2 (0.88%) |
| **D** | **C + omit an unplannable street** | **52** | **907** | **0** |

A alone buys only +11%: the stub coefficient `(0.13 + outerRoadBias * 0.08)` gives 21.6 m
branches, too short to carry lots. The local-street coefficient the other grammar already
uses, `(0.20 + outerRoadBias * 0.13)`, gives 33.8 m.

**On 18 CITY, A, C and D all showed zero failures. On 226 CITY across seven seeds, A and C
show 0.88%.** A generation throw is a world that will not load - the same class of bug as
the spawn pond. The small sample said "safe" about two variants that are not. Sample size
for a failure rate has to be set by the rate you would still refuse to ship, not by whatever
the default seed happens to contain.

### What shipped

Four changes, all inside `createCityGrammar`. Three reuse values already in the file:

- `deadEndCount = clamp(round(localGrowthCount * deadEndBias), 1, 2)` becomes
  `localStreetCount = localGrowthCount`.
- the branch length coefficient becomes the local-street one from
  `createOrganicOrTownGrammar`.
- the length-scale retreat ladder becomes that grammar's six-step ladder instead of three.
- `throw new Error('unable to grow planar CITY dead-end')` becomes an omission. The finite
  game does the same thing with `omitRoute(routeId, ROAD_KINDS.LOCAL, 'END_OR_CORRIDOR_BLOCKED')`
  and keeps building. Omissions are counted, not silent: they appear in
  `graph.metadata.omittedRoutes` as `{ routeId, class, reason }` and as
  `roadSummary.omittedRouteCount`, mirroring the finite town summary's field of the same name.

Measured result:

```
                     baseline     after      finite game (anchor)
local segments       8 (8-11)     18 (14-21)
total segments       29           39
road length          411 m        592 m      819 m
density              8.9          12.8 km/km2
buildings median     39           52         50
buildings total      705          907        898
generation failures  0/226        0/226
```

CITY reaches the finite capital's building count rather than exceeding it. Before this,
CITY and TOWN both sat at a median of 39 buildings - the capital and a town were
indistinguishable; now the capital is 33% larger. TOWN and RURAL are unchanged: identical
segment counts, lengths and densities, and zero omissions outside CITY. Across 141 CITY in
four seeds, two settlements omitted three streets between them and generated normally at 16
and 14 local segments instead of 18.

Road length is still 592 m against the finite capital's 819 m. The building count matches
because supply is no longer the binding constraint - the CITY maximum is now 61 against the
64 cap, so `requestedBuildingCount` starts binding next.


## The profile says GRID and the implementation draws a starburst

The capital reads as radial from every angle. That is not a tuning problem; the CITY
grammar builds radial COLLECTOR spokes from a hub plus concentric arcs, and the local
streets added above are stubs growing off that skeleton.

### `roadPattern` is never a branch condition in road-graph-v3

`GRID` / `SEMI_GRID` / `ORGANIC` are compared **zero times**. The parameter reaches only
three places, none structural: the `profileUsage` diagnostic echo, an RNG key prefix
(`` `${profile.roadPattern}:main-axis` ``), and an edge `flags.grammar` label. The grammar
is chosen by `legacySettlementClass === SETTLEMENT_TYPES.CITY` instead. This is the same
"declared but unread" shape as `alleyCount`, and `hardBranchAngleMin/Max` is a third case -
the finite game rejects branches outside it (`road-town-structure.js:962`), v3 never reads
it and retreats through a hardcoded ladder that reaches +/-34 degrees, beyond the +/-15 the
finite game would refuse.

### Measured grid-ness, and the ordering is inverted

Bearings of street segments (collector + local), folded modulo 90 degrees; concentration
1.0 is a perfect grid, 0 is uniform.

```
class   roadPattern  gridBias   concentration   angular spread   exactRightAngleRate
CITY    GRID         0.92          0.245          sigma 24.0 deg        3.0%
TOWN    SEMI_GRID    0.58          0.422          sigma 18.8 deg        0.0%
RURAL   ORGANIC      0.12          0.329          sigma 21.4 deg        0.0%
finite capital                     ~1.0           sigma  0.6 deg      100% at 0/90
```

**The class declared GRID is the least rectilinear of the three.** No subjective judgement
is needed to see the inconsistency.

### `gridBias` is read six times and never reaches an angle in CITY

The one place `gridBias` produces right angles is

```js
const gridAngle = 90 + (rawAngle - 90) * (1 - profile.gridBias);   // line 492
```

which lives in `createOrganicOrTownGrammar` - the grammar CITY never enters. CITY's 0.92 is
the largest of the three and controls only warp damping on its radial corridors.

It also turns out this term is nearly inert even where it does run. Decomposing the measured
spread against what the formula alone can produce:

```
TOWN  band 75-105, gridBias 0.58  ->  formula gives sigma 3.6 deg
      measured sigma 18.8 deg     ->  formula explains 3.7% of the variance
CITY  band 85-95,  gridBias 0.92  ->  formula gives sigma 0.23 deg
```

The spread comes from the parent-relative frame, not the angle term: branches are grown
perpendicular to the local tangent of a *curved* collector, so a perfectly perpendicular
branch still lands on an arbitrary absolute bearing. **Perpendicularity to a curved parent
does not make a grid; a grid needs a global axis frame.** Routing CITY through the organic
grammar as a probe confirms it - the ordering becomes correct (CITY 0.466 > TOWN 0.424 >
RURAL 0.329) but concentration only reaches 0.466, still sigma ~18 degrees.

### The grammar calls itself a grid

`GATEWAY_RADIAL_WARPED_GRID_WITH_INCOMPLETE_CROSS_CONNECTIONS`. The name carries
"WARPED_GRID"; the implementation is radial spokes and arcs.

### The reference implementation fails the validation

The finite capital's own street network, measured against v3's CITY invariants:

```
nodes 43  edges 42  components 1

cycleRank                    = 0   required 2..3   FAIL   a pure tree
collector/spine route count  = 2   required 2..3   PASS
centerJunctionDensity > outer      10 / 0          PASS
incomplete cross connections = 0   required >= 1   FAIL   it has no arcs at all
```

Two of the four CITY invariants reject the thing they are supposedly describing.

`CITY requires incomplete cross connections` is the decisive one. `crossConnection: true`
and `incomplete: true` are **hardcoded literals at the single `addArcConnection` call
site** - never computed, never false. So the check reduces to "at least one edge came from
`addArcConnection`". It tests provenance, not a property. A validator that names an
implementation function cannot be describing what a city is.

### The radial structure is new in v3, and undocumented

- The finite game contains no radial road generation at all: no `fromPolar`, no concentric
  ring, no angular spoke placement in `road-town-structure.js`.
- `road-graph-v1` has no CITY-specific grammar. All three classes use
  `OFFSET_COLLECTOR_SPINE_WITH_LOCAL_BRANCHES` - spine plus branches, the finite shape -
  and CITY differs only by a branch-length coefficient (0.46 against 0.42).
- `road-graph-v2` has no CITY-specific grammar either, only a per-class count.
- `createCityGrammar` arrives whole in commit `290888d`, "Add experimental settlement road
  graph v3". The message is that one line. There is no design note in the commit, in the
  code, in the tests, or in any document.

### The fifth porting instance: the structure itself was replaced

| # | finite rule | what the port did | shape |
| --- | --- | --- | --- |
| 1 | `grassPatches`: staged thinning | outright ban | graded -> absolute |
| 2 | arterial frontage: 8 m penalty | `frontageEligible: false` | graded -> absolute |
| 3 | `findLandingSpot`: pond preferred | pond required, else throw | fallback -> absolute |
| 4 | capital: six LOCAL branches | resolved to 6, multiplied by an unrelated bias to 1 | correct value, wrong consumer |
| 5 | capital: 100% of angles at 0/90 | radial spokes plus arcs | **structure replaced** |

The first four are reachable by following a value or a rule. The fifth is not: every value
matches, every rule matches, and `localBranchCount`, `deadEndBias` and `densityMultiplier`
all lead nowhere. It surfaces only by cross-checking a declaration against its consumers -
noticing that `roadPattern: GRID` is written down and that no line of code branches on that
string. When porting, audit declared-but-unread parameters as a class; three of them
(`alleyCount`, `roadPattern`, `hardBranchAngle*`) are unread in v3, and one of those turned
out to be hiding a whole-structure divergence.

### The Lot path is marginal in every class, CITY most of all

Measured against the design question "does closing blocks make the Lot path work":

```
class   n    blocks  lots   from lots   frontage fallback   scatter   total
CITY     18      34    113        66  (7.3%)        841        0       907
TOWN    543     585   5380      2836 (12.7%)      17322     2142     22300
RURAL   185      37    504       213  (7.8%)       2523        0      2736
```

CITY averages 1.9 blocks per Settlement, which tracks its `cycleRank` of 2-3, and those
blocks yield 3.3 Lots each at 58% occupancy. **92.7% of a capital's buildings come from the
frontage fallback, not from Lots.**

This tempers the block argument. Closing two or three rectilinear blocks instead of arc
blocks should raise both Lots-per-block and occupancy, because a rectangle tiles with
rectangular Lots and a circular arc does not - but the path being improved currently
supplies 7% of the buildings. Rectilinear blocks are worth doing for the shape of the
result, not as a building-count lever. Any claim about the count has to be measured on a
prototype rather than argued from the block count.


### The goal here is not to reproduce the finite game

The finite capital is a perfect lattice: every one of its 42 street segments lies at exactly
0 or 90 degrees, and its branch spacings are even (380, 380 and 400, 400). Reproduced
faithfully that reads as mechanical. The target is instead what `gridBias` 0.92 designates -
mostly rectilinear, slightly relaxed - which lands deliberately short of the reference. This
is a different decision from instances 1 through 4, where the finite intent was restored as
found.

One caveat carried into the design: **`gridBias` 0.92 does not itself produce "slightly
relaxed".** Through the existing formula with CITY's own 85-95 preferred band it yields
90 +/- 0.40 degrees, a concentration of 0.9999 - tighter than the finite capital measures.
The relaxation has to be sourced deliberately and separately, not read out of 0.92.


## Stage 1: the lattice

The CITY grammar now lays a rectilinear lattice on the global `GRID:base-axis` frame it
previously used only to fan its radial spokes out. Two lanes on one axis and three or four
on the other, crossing; `localSpineCount` of 2 restored to its name as the two lanes that
carry branches; `localGrowthCount` of 6 branches, three per spine, perpendicular; gateways
entering where their own bearing first meets a lane.

```
                     radial (before)   lattice (after)   finite capital
bearing concentration      0.245            0.948            ~1.0
within 10 deg of an axis   33.3%            96.9%            100%
exact right angles          3.0%            60.3%            100%
road length                592 m           1094 m            819 m
frontage-eligible          592 m           1094 m
raw slots                    196              364
Lots per Block               3.0             19.0
buildings from Lots         7.7%            35.9%
buildings (median)            52               64  <- at the cap
generation failures        0/226            0/226
```

TOWN and RURAL road networks are untouched - identical segment counts, lengths and
densities. The target band for stage 3 was 0.90 to 0.95 concentration, and the lattice
lands at 0.948 on lane-spacing jitter alone, so the planned "loosening" stage is not
needed.

### The whole grid was frontage-ineligible

The first lattice put 73% more road on the ground and **halved** the buildable length, from
592 m to 290 m, and the capital dropped from 52 buildings to 30. The closed Blocks it
finally produced generated zero Lots, rejected as `NO_VALID_FRONTAGE`. In the game the
streets were laid out neatly with nothing between them.

`addPolyline` set the frontage verdict on every edge it made:

```js
frontageEligible: roadClass !== ROAD_GRAPH_CLASSES.ARTERIAL,
```

`addEdge`, the primitive underneath it, set nothing. The lattice lanes are built with
`addEdge` directly, so all 23 of them carried `frontageEligible: undefined` and dropped out
of both frontage selection and Lot generation - taking the Blocks they bound with them.

The default now lives on `addEdge` and the duplicate in `addPolyline` is gone. That is safe
precisely because it was only ever missing at the new call sites: of the four callers, the
two that predate this work (`addPolyline` itself and `addGatewayConnection`) both set the
flag explicitly, and an explicit flag still wins - `addGatewayConnection` marks an ARTERIAL
frontage-eligible on purpose. A default belongs on the primitive that makes the thing, not
on one of its two callers.

### Gateways enter where their bearing meets a lane

Three constructions were tried and abandoned before one held, and the reason each failed is
the same fact: **`segmentsIntersect` counts a bare touch as an intersection.** A shared
endpoint, a T-junction, a collinear overlap - all true.

```
touching at an endpoint  -> true
T-junction (mid contact) -> true
proper crossing          -> true
collinear overlap        -> true
```

Radial spokes never met this, because spokes radiating from one hub cannot touch. A lattice
is nothing but contacts. Routing a gateway to a lane *end* and turning to reach it puts the
corner on whichever lane runs through that end, or runs the second leg along it; either way
the graph is rejected. Widening the search only moved which settlement failed.

What works is to stop routing and start planning: compute where each gateway's bearing
first meets a lane, put a node there, and weave it into that lane's chain the way branch
attachments already are. The approach is then one radial leg from the outer circle to that
node - it touches nothing because it stops at the first thing it reaches, and the lane
already has a node waiting. `gatewayContinuityAngles` sits at 0 because the leg is
collinear with the arterial that feeds it.

One trap on the way: a `0.005R` margin that skipped entry candidates too close to a lane
end. Rejecting a lane as a *candidate* does not remove it as an *obstacle* - it just hides
it, and the leg then runs through the lane it declined to stop at. No margin is small
enough to fix that; only a crossing genuinely beyond the lane end is not a crossing.

### Two CITY invariants were replaced

`CITY requires incomplete cross connections` tested `edges.some(e => e.flags.crossConnection
&& e.flags.incomplete)`, and both flags are hardcoded literals at the single
`addArcConnection` call site - never computed, never false. It tested which function drew
the edge. The finite capital fails it outright, having no arcs at all.

In its place, the declaration nothing enforced: `roadPattern: GRID` becomes a measured
floor on street-bearing concentration. Roads leaving for a neighbour are excluded - the
arterial by class and the collector approach by its `gatewayRoute` flag - because they are
aimed at that neighbour rather than laid along the town plan, which is the same exclusion
that shows all 42 of the finite capital's street segments at exactly 0 or 90 degrees.

The second half of "incomplete" became `localDeadEndCount >= 1`. Phrasing it as "not every
trunk pair may be linked" does not survive a lattice, where every lane reaches both trunks;
that reading only ever made sense for radial spokes. A capital is not a closed figure - it
still has streets that stop, and the finite capital satisfies that with 12 of them.

Both rewritten checks pass on the finite capital. The checks they replaced did not.

### What the failing tests actually meant

Three tests broke and none of them meant what its name suggested.

- **The determinism test was not a determinism failure.** `createRoadGraphV3` threw on one
  fixture Settlement and execution never reached a single determinism assertion. The margin
  bug above was the cause.
- **The lever 1 test** (`resolved 6 = streets built + streets omitted`) was collateral from
  the same throw; only the route id pattern needed updating for the new grammar.
- **`bendNodeIds.size > 0`** guards a real rule - a bend is geometry, so it must have degree
  exactly 2 - against being vacuous. In v3 a `bend` is the articulation of a polyline drawn
  through intermediate points, and a lattice runs straight from junction to junction, so it
  makes none. The guard is now scoped to the grammars that curve. The first guess, that it
  encoded a radial assumption, was wrong: the finite capital does carry 21 degree-2 nodes.
  They come from subdividing its straight runs, not from curvature, so they are not evidence
  that a grid should bend.

### Lever 3's arterial test asserted the wrong half

It required `onArterial.length > 0` - that a CITY actually places buildings on its gateway
arterial. That passed only because the radial CITY offered 592 m of street and ran out. With
1094 m the suppression works as designed and no CITY building takes an arterial:

```
buildings fronting the gateway ARTERIAL
  CITY     0 / 1152 =  0.0%
  TOWN  2993 / 22300 = 13.4%
  RURAL  143 / 2736 =  5.2%
```

The mechanism is plainly alive where frontage is still scarce. What lever 3 restored was
that an arterial is *available* as a last resort, never that it is always taken, so the
test now checks that every arterial stays frontage-eligible and that street frontage exists
to be preferred. The suppression check - nothing takes an arterial where a street runs
within the finite 8 m MAJOR bias - is unchanged.


## Lots were allowed to lie under Roads

`settlement-lot-v1` sized every Lot against the Block polygon and never against the Roads
themselves. `footprintFromDescriptor` insets the Lot by half a Road width along `inward` -
away from the Lot's own frontage - and nothing insets its two sides or its back:

```js
const roadInset = descriptor.segment.widthMeters / 2;
const insetStart = { x: frontStart.x + descriptor.inward.x * roadInset, ... };
// ... and the remaining three corners are placed by `inward * depth` alone
```

The containment test that follows, `polygonInsidePolygon(footprint, polygon)`, measures
against a Block polygon drawn through Road **centre lines**. So neither failure is visible
to it:

- **Sideways.** Lots are laid along a boundary edge and centred with `remainder / 2` of
  slack at each end. When an edge length is close to a whole multiple of the target Lot
  width that slack is near zero, the end Lot reaches the Block corner, and the
  perpendicular Road's half width - 0.925 m for a CITY lane - is already inside it.
- **Backwards.** In a shallow Block the Lot's back edge lands within half a width of the
  Road behind it, again inside the centre-line polygon.

### The grid did not cause this; it exposed it

The defect is as old as the Lot path. It stayed invisible because the Lot path was barely
used: measured on the radial CITY, Blocks produced 3 Lots each and Lots supplied **7.3%**
of a capital's buildings. Rectilinear Blocks tile with rectangular Lots, which took Blocks
to 19 Lots each and the Lot share to **35.9%** - and six buildings immediately came out
sitting on lanes they did not front onto.

It is latent in the other classes too. Across a 48-Settlement sample the corrected check
rejects five Lots outside CITY: RURAL 270 to 269 buildings, TOWN 477 to 473. Those never
surfaced as building overlaps, but the Lot rectangles were under Roads all along.

### Widening the Blocks is the wrong fix

Scaling lane spacing with the lane count, so a fourth lane does not squeeze Blocks to 24 m,
takes the overlaps from **6 to 4** - it never reaches zero, because the sideways case is a
corner effect rather than a depth effect. It also trades away the density the grid was
built to gain. That change was reverted.

Checking the Lot against the Roads themselves takes it to **0**, with no geometry change at
all. `lotCoversRoad` rejects a candidate whose footprint overlaps any Road rectangle other
than its own frontage - which the inset above has already cleared, and where a touching
contact is the Lot meeting its own kerb.


## Four Road symptoms, two causes

Reported from the running game: the road surface flickers as the view moves; a small-scale
player sinks into it; roads arrive later than trees while moving; roads sometimes break.
They are not four bugs. Sinking is its own defect, and the other three are one.

### Not z-fighting, and not the ground poking through

The road ribbon is drawn at terrain height plus `FINITE_ROAD_SURFACE_HEIGHT_METERS`,
`3 / PRODUCTION_VISUAL_UNITS_PER_METER` = **0.075 m**.

Vertices are emitted only at road corner points and clip-boundary points -
`roadVertexIndex` is the single caller of `heightAt`, and nothing subdivides a segment
along its length - so a straight run is one quad interpolating between its endpoints while
the terrain beneath it is a ~0.5 m grid free to rise in between. That is a real hazard, but
it is not what is happening here. Sampling every road segment around a capital at 0.25 m:

```
road surface offset 0.075 m; 560 samples
samples where the ground sits above the road surface: 0 (0.00%)
worst poke-through: 0.0000 m
segment length: min 0.1  median 4.5  max 16.8 m
```

Chunk clipping keeps segments short and the terrain is smooth at that scale, so the road
never dips into the ground. Neither symptom is z-fighting against the terrain.

### The player stands on the ground; the road floats above it

`player-vertical-movement.js` knows only about terrain:

```js
function applySurface(state, terrainHeightMeters, scaleProfile) {
  ...
  target.groundRootY = terrainHeight + metrics.footOffsetMeters;
}
```

There is no road term anywhere in the vertical state - `terrainHeightMeters` is the only
surface it is given. So the player's feet rest 0.075 m below the road they appear to be
standing on. At the default scale that gap is invisible. `footOffsetMeters` shrinks with the
scale stage while the road offset does not, so as the player gets smaller the same 7.5 cm
grows to a large fraction of their height and they visibly sink into the carriageway. That
is the whole of symptom 2, and it is independent of the other three.

### Every road in the world is one mesh, removed before its replacement is added

`w8-distant-presentation.js` says it in its own comment:

> Every Road in the world shares one merged bucket, and the live mesh is removed before the
> replacement is added. When this generation still carries Road records but has not produced
> a Road mesh yet, publishing it would drop the entire Road layer until some later
> generation composes one - the player sees all Roads blink out together while moving.

That is the reported flicker, the reported lateness and the reported gaps, in the source.
Any recomposition anywhere - the player moving, a settlement entering range - rebuilds the
single global road bucket, and the swap is remove-then-add.

The comparison with trees is the asymmetry that makes roads feel worse. Trees publish per
terrain cell (`canonicalTreeCell` staged alongside each `terrainCell`), so a moving player
gets them incrementally and locally. Roads have no per-cell publication: one bucket for the
world, recomposed whole.

There is already a partial guard - `preserveExistingRoadWhenEmpty` and the
`roadPriorityDeferredRemovalCount` path keep the last good roads when a generation carries
road records but has not composed a mesh. It covers that one case, not recomposition in
general.

Two systems build road ribbons from the same geometry code: `chunk-render-adapter.js` for
resident chunks and `w8-distant-presentation.js` for the merged distant bucket, handed over
through `settlementReplacementBarrier`. The handover is a second place where a road can be
briefly owned by neither.

### Correction: a comment is not the implementation

The previous entry named the merged road bucket's remove-then-add swap as the likely cause
of the flicker, on the strength of the code's own comment describing exactly that symptom.
That was wrong, and the way it was wrong is worth keeping.

`publishPriorityRoadGeneration` removes the live mesh and adds the replacement **inside one
synchronous function call**. No frame is rendered between them, so the scene graph is never
without roads and the swap cannot blink. The comment describes a failure that the guard
directly beneath it - `roadPriorityDeferredRemovalCount` - already prevents. It documents a
fixed bug in the present tense.

This is the same error as reading a declaration as behaviour (`roadPattern: GRID`), one step
further removed: a comment was read as a proxy for what the code does now, when it records
what someone believed while writing it. A comment is evidence about intent and history, not
about current behaviour. Confirm the mechanism in the code, then read the comment for why.

### Confirmed: the flicker is a coplanar double draw

`settlementPresentationHolds` retains an unloaded chunk's presentation, and a hold carries a
`road` component holding `layerMeshes.roads` and the `roadRibbonGeometry`. `held.group` is
attached to `worldRoot` and is removed only when the hold is released. Nothing lowers its
visibility - there is no `.visible = false` anywhere in `chunk-render-adapter.js`.

The adapter states the overlap as a premise:

```js
if (projected?.group) roots.push(projected.group);
if (held?.group && held.group !== projected?.group) roots.push(held.group);
```

One owner, two groups, both live. `createDrawableReplacementBarrier` makes this deliberate:
the hold is released "only after the returning Near detail has crossed an actual completed
renderer receipt", so a returning chunk's fresh road mesh and the held one coexist until the
receipt lands. Both are built by `buildSettlementRoadRibbonMeshData` from the same road
records at the same `surfaceOffsetMeters`, so they are exactly coplanar, and which one wins
a pixel flips with the view. That is the flicker, and it recurs whenever chunks re-enter
residency - which is to say, while moving.

Cell-wise road publication would not close this window. It is a different axis: spatial
granularity against LOD handover. Symptom 1 is separable and small; symptoms 3 and 4 remain
with the single merged bucket.

### The obvious site for the grounding fix has no roads in it

Making contact aware of the road surface needs to know whether the player stands on one.
The natural place is `gameplay-runtime.js`, beside `#tryTerrainHeightAt`, which reads
`tankTerrainChunks`. That cache cannot answer it:

```js
sourceChunkData: Object.freeze({ chunkX, chunkZ, terrain: source.terrain }),
```

`#rememberTankTerrainChunk` deliberately keeps terrain and drops everything else, so
`settlementFeatures` - and with them every road - are gone by the time the runtime samples a
height. Roads are not colliders either, so the spatial models that answer
`#canonicalPlayerColliders` do not carry them. There is currently no road geometry reachable
from the layer that decides where the player's feet go.


### What is measured and what is inferred

Measured: the 0.075 m offset; zero terrain poke-through in 560 samples; that the vertical
state has no road term; that roads are one merged bucket removed before replacement while
trees publish per cell.

Inferred, not yet confirmed against the running game: that the flicker the player sees *is*
that bucket swap rather than something else on top of it. The static evidence is strong -
the code comment describes the exact symptom - but it has not been watched with the road
diagnostics on while flicker is happening.


## Running the test suite without losing two hours

Every item here cost real time in this session. None of them is a defect in the code
under test, and all of them look like one.

### Do not run the whole suite in parallel

`node --test "tests/*.test.mjs"` runs files concurrently. In this session one worker
went to **zero CPU progress for two hours** and the run never ended. The parallel
runner also gives no file attribution, so a hang cannot be traced to the file that
caused it.

Run per file instead. It is slower in the best case and far faster in the bad case,
and a hang names itself:

```sh
while IFS= read -r f; do
  echo "== $f"
  node --test "$f" 2>&1 | grep -E '^ℹ (tests|pass|fail)|^✖'
done < filelist
```

Two further traps in that loop:

- **`timeout N node --test ...` does not reliably kill it on Windows.** A run given
  `timeout 500` was still alive at 640 s. Check for survivors with
  `Get-CimInstance Win32_Process -Filter "Name='node.exe'"` and stop them by PID.
- **Redirecting to a file block-buffers the output.** `node --test ... > log.txt` does
  not line-buffer, so the file plateaus for minutes and looks hung when it is not, and
  a partial flush read as progress gives a wrong failure count. Judge liveness from
  process CPU time, not from the log's length.

### Killing a run orphans an http-server, and the orphan holds port 8021

`infinite-world-w5-sandbox-boot.test.mjs` and `infinite-world-w5-http-entry.test.mjs`
serve the repo on `127.0.0.1:8021`. Cancelling a run - a tool-level task stop, Ctrl-C,
anything that does not let the test tear down - leaves `npx http-server . -p 8021`
running. **The next run of those files then blocks forever waiting for the port**, with
no error message that mentions the port.

This happened twice here and produced two false conclusions before it was found: once a
"hung test suite", once a "failing test file" that actually passes 24 of 25. Before
blaming a boot test, check:

```sh
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { \$_.CommandLine -like '*http-server*' } | Select-Object ProcessId, CommandLine"
```

and kill what it finds.

### Gates that cannot go green on this machine

Some tests can never pass here, so a red suite is the normal state and the only useful
question is *which* tests are red compared with a clean tree:

- **CRLF byte-identity guards.** They compare `readFileSync(path, 'utf8')` with
  `git show <baseline>:<path>`. `autocrlf` is on, the working copy is CRLF, the blob is
  LF, so the comparison cannot pass. This is most of the standing failures.
- **Wall-clock performance gates.** `infinite-world-w5-sandbox-boot` (real boot path,
  ~18 s budgets), `full production boot scheduling stays continuous through MAX sprint
  direction changes` (120 s observed), `a newly visible full Chunk object is
  damage-queryable before deferred presentation work` (383 s observed), and the
  Presentation throughput gates all measure elapsed time. They fail or pass depending on
  what else is running, and they flip between runs on an unloaded machine too - one of
  them passed on the changed tree and failed on the clean tree in this session, which
  means nothing.

### How to tell a real regression from the standing noise

Never compare failure *counts*, and never compare against a remembered number. Run the
affected files twice - once as-is, once with the change stashed at the same HEAD - and
diff the failing test **names**:

```sh
git stash push -- <your changed files>
# run, collect names
git stash pop
# run, collect names, then: comm -23 changed.txt baseline.txt
```

Only the files that can reach the changed module need this. For a change confined to
one module, that set is the tests importing it plus the tests importing its importers.
For the spawn fallback above that was 39 of 108 files, and the diff was empty.


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
