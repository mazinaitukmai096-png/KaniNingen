# Render cost findings

Recorded from a performance investigation that started with a reported 30 fps and
ended by finding the 30 fps was an artefact of the measurement. Nothing here is a
defect to fix today; these are the items that will bite first when the render
distance grows or the world gets heavier, and the measurements a future
investigation should start from instead of re-deriving.

## Read this before measuring anything

**Diagnostics change the frame rate. FPS measured with `?diagnostics=1` is not a
performance number.** The reported 30 fps reproduced only with diagnostics
enabled: `distant-diagnostics-snapshot` alone was costing 16-20 ms per frame,
which is the whole 60 fps budget. With no query flag the same build holds 60 fps.

Two further traps in the same area:

- **Every `p50` in `snapshot().diagnostics` is a median over a 7,200-sample
  circular buffer** (`DEFAULT_SAMPLE_LIMIT`), which is minutes of history. During
  the investigation `frame.p50` read `16.700000000000728` while the game was
  actually running at 33.4 ms per frame, because most of that buffer had been
  recorded earlier when the world was light. Read `latest`, or take a fresh
  series; `p50` answers a question about the past.
- **Near a vsync boundary, FPS cannot attribute cost.** At 60 Hz a frame that
  overruns 16.7 ms lands on the next vsync at 33.3 ms, so the counter reads a
  rock-solid 30 and does not move for any change that fails to get back under the
  line. Four separate A/B tests (triangles -68%, quality `low`, quarter window,
  meshes hidden) each showed "no change" for this reason. Measure in milliseconds
  - `diagnostics.stages.<name>.latest` - never in FPS.

## 1. What the `render` stage is actually made of

`render` wraps far more than the draw. Measured with the nested stages
`render-draw`, `render-mirror-begin`, `render-mirror-complete` and
`render-visual-continuity`, at 153 Macro cells / 148 draw calls / 1.37M triangles:

| component | share of `render` |
| --- | --- |
| `visualContinuity.acknowledgeScene` | 52-69% |
| `renderer.render` (culling + draw submission) | 12-26% |
| `gpuMirror` begin + complete | remainder |

Six samples, and the ratio held in every one. It also held on a second machine
with different absolute timings, so it is not environment-specific. Absolute
milliseconds from that run are not quotable - they were taken with diagnostics
enabled and varied 3x between identical conditions - but the split is stable.

The consequence for any future "reduce draw calls" work: draw submission is a
fifth of this stage at most. Merging meshes would help by shrinking what the
per-frame scene passes walk, not by cutting draw calls.

## 2. The per-frame scene passes ignore `visible`

`visitSceneObject` (visual-continuity.js) recurses the whole graph with no
`visible` check, and runs every frame from `acknowledgeScene`. The per-mesh body
does early-out, so the cost is not purely a function of object count: hiding 306
meshes moved `acknowledgeScene` from ~22 ms to ~12 ms. It responds to both how
many objects exist and how many were drawn.

`visualContinuity` and the GPU attribute mirror are constructed unconditionally,
so these passes run in normal play, not only under diagnostics.

## 3. Mesh count is linear in Macro cell count

The Grass field and the Bush lane each create one `InstancedMesh` per Macro cell,
all sharing one geometry and one material per lane. Measured at 113 cells: 113
Grass meshes and 113 Bush meshes, 226 of 401 objects in the scene.
`MACRO_MAX_RETAINED_CELLS` is 174, so at full retention those two lanes alone
reach about 348 meshes.

They are split per cell for staging and retirement granularity and for per-cell
frustum culling. Neither requires the draw unit to equal the staging unit: one
pooled `InstancedMesh` per lane with per-cell index ranges is possible. What that
would cost is per-cell frustum culling, which currently discards a real share of
the scene (401 meshes resolved to 148 draw calls).

## 4. Instance buffer uploads are whole-buffer

`instanceMatrix.needsUpdate = true` re-uploads the entire buffer: about 832 KB at
13k instances, on every cell staged. The loaded THREE is **r0.160.0**, which has
`BufferAttribute.addUpdateRange()` / `updateRanges`, so per-cell partial uploads
are available - but the current code sets `needsUpdate` wholesale and would have
to adopt ranges. For a pooled-mesh design this is the real work, not the pooling.

## 5. `fpsCap` is a dead setting on this path

`fpsCap` is declared in `world-state-store.js`, validated against
`[0, 30, 60, 120]`, persisted, rendered into the settings panel by
`experience-shell.js` and wired to a change handler - and the frame loop never
reads it. Choosing 30 fps in settings does nothing. The frame-skip it implies
exists only in the finite game (`src/game.js`, "FPS上限"), which is a separate
application.

This is the same shape as the Bush handoff bug recorded in
`w8-shrub-field-presentation.js`: a value exists on one side and nothing consumes
it on the other. Worth checking for that shape whenever a setting appears not to
work.
