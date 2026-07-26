# W8 有限World体験パリティ

W8 は、保護コミット `f8bc9f80c2af417bb585bff26c99522c4229ab8e` の有限Worldを、見た目・操作・戦闘・演出の比較基準として扱う Infinite World runtime です。有限Worldの固定地形は複製せず、W5 canonical terrain、分散Settlement、Floating Origin、Stable IDを維持します。

## 不変条件

- `index.html`、`src/game.js`、`src/constants.js` は保護コミットと同一です。
- W5 canonical ChunkData、地形高、Stable ID、content hashは変更しません。
- terrain mesh、衝突、Player接地、建物基礎、自然物、遠景LODは同じW5 `surfaceHeight` と垂直scale 1を参照します。
- W8固有の表示は `presentationLayers` に加算し、保存対象やW5 hashには含めません。
- Growth、Wanted、Threat、NationはW8パリティ範囲に追加しません。

## Runtime

- 起動は `New Game` と `Continue` を分離し、自動ロードしません。
- phaseは `menu → intro → playing → dying → gameover`、時計は単一の `gameplayTimeMs` です。
- New GameはW5のStable IDで固定した安全なpondとintro/camera corridorを検証し、5×5 dataと3×3 renderの準備完了後にだけintroへ入ります。cameraはSettlement壁との交差を実描画meshで解消します。
- Tankは有限版のスコア依存上限・生成確率・拠点条件・距離・LOS・旋回・cooldownを満たした場合だけ出現・射撃します。
- 保存はschema v4です。W8 v3、W7 v2、W6を一時candidate上で検証・移行し、飛翔中Projectileと描画cacheと計測状態は保存しません。
- 通常保存は状態変更後5秒のidle、重要イベントと `pagehide` は即時です。ブラウザ保存はIndexedDBを使用し、旧localStorageから一度だけ移行します。

## 診断と性能

`performance.mark/measure` でChunk生成、projection、load/unload、rebase、prefetch、遠景、Gameplay同期・更新、Shadow、透明Material、render、serialization、IndexedDBを同じframe timelineへ記録します。測定queryでは保存、遠景、Shadow、透明物、Gameplay同期を一項目ずつ停止できます。

診断ではChunk境界の同期生成と遠景更新が反復spikeに相関しました。そのためWorkerや固定7×7生成は追加せず、進行方向の次の5×5 data windowを1 frame 1 Chunkずつ事前生成し、遠景はW5の高さ値を変えずsampling密度だけを下げました。

同一foreground Chromeでの最終確認runでは、frame p50 6.1ms、p95 18.2ms、max 48.7ms、50ms超frame 0.30%、Chunk transition p95 14.2msでした。これはW8側の絶対floorを満たします。正式完了には、有限版とW8を各5 run測定した中央値比較と、POによる3分間の実機確認が別途必要です。

## 検証

自動テストは337件です。開始モード、非同期Chunk準備、safe pond/camera corridor、camera衝突、旧save移行、破損save、Tank生成・LOS・旋回・射撃、Atomic、Boss、死亡、Restart、W5 snapshot/content hash、height source、表示資源、診断集計を含みます。抽出元とSHA-256は `W8-FINITE-PARITY-PROVENANCE.json` に固定しています。

## W8 Gate B closure

- Status: Gate B closed.
- Root cause: Tank Projectile terrain queries generated uncached Chunks through `generator.generateChunk()` during the gameplay frame.
- Formal behavior: Projectile terrain queries are non-generating. Cached terrain keeps normal sampling and collision; a cache miss returns no terrain hit while Projectile movement, lifetime, World Object collision, damage, presentation, and renderer synchronization continue.
- Temporary W8 isolation, frame diagnostics, Audio batching/priming, Clipmap cache, runtime snapshot hot-path, and Projectile shader investigation changes were removed from the closure diff.
- Verification: repository serial test run 394/394 passed; related Core Combat, Sandbox Boot, Production Visuals, and Save tests passed; syntax and whitespace checks passed.

## W8 complete finite-experience migration contract

### Status and authority

- Source of truth: protected finite-World commit `f8bc9f80c2af417bb585bff26c99522c4229ab8e`.
- Migration contract: defined by Project Owner decision.
- Migration execution: active outside Gate C and split into independently verified parity Gates.
- Gate C execution: not started. Gate C measurement cannot begin until every parity Gate below is closed.
- Completion meaning: intended Player-visible Gameplay, presentation, controls, UI, and Audio match the finite-World source within the explicit Infinite World exceptions below. Pixel-identical fixed-map topology is not required.

The finite-World source and protected shared modules remain unchanged. Every migrated
value or behavior must be traceable to the protected source, an existing provenance
record, or an explicit Project Owner decision. An unexplained Player-visible difference
keeps this migration incomplete.

### Intentional Infinite World exceptions

The following differences are retained intentionally and are not parity defects:

- Infinite terrain and distributed RURAL/TOWN/CITY Settlement coordinates and count.
- 3x3 rendered Chunks, 5x5 active data, incremental directional prefetch, distant LOD,
  Floating Origin, and Stable-ID persistence.
- Safe pond selection and asynchronous Chunk preparation before the intro begins.
- Separate New Game and Continue paths, W8 Save persistence, and isolated Developer Tools.
- Shift sprint and graphics Quality affecting presentation rather than Human population.
- Fixed Project Owner Haystack Gameplay radius 35.
- Gate B non-generating Tank Projectile terrain queries on cache miss.

Settlement coordinates need not match the fixed finite map. RURAL/TOWN/CITY must instead
reproduce the finite source's intended archetype density, composition, scale cues,
destruction opportunities, and population experience. The finite High-quality population
and World Object density are the comparison baseline and do not vary with W8 Quality.

Growth, Wanted, Threat, Nation, future-facing comments, and the finite capital/link HUD
placeholders whose values are not driven by formal Gameplay are outside this migration.

### Parity ledger

| Area | Protected finite source | Current state | Required parity work | Verification owner |
| --- | --- | --- | --- | --- |
| Player movement, jump, fall, Scale camera, Claw input | `src/game.js`, `src/scale-sandbox.js`, `src/core/input.js` | matched by P1 | Existing values and W8 sprint are retained. Airborne-to-grounded transition now applies the finite Scale-specific landing Damage, push, Shake, two Shockwaves, dust, and World target interaction exactly once; intro, pause, dying, and grounded frames do not emit landing attacks | Player vertical, Experience Shell, Core Combat, production presentation tests |
| Start and camera choreography | `src/game.js` `startGame`, intro camera path | matched with intentional W8 safe-pond preparation | Protected finite `startGame` explicitly disables the obsolete `updateDropSequence`; W8 retains safe pond/async preparation and the finite intro camera state transitions plus building/Boss camera collision | Experience Shell, Sandbox Boot, render-adapter tests; PO 30-second review |
| Terrain and Infinite runtime | W5 canonical source plus finite visual provenance | intentional W8 exception | Do not change W5 height/hash; keep terrain, collision, foundations, and far presentation on the same height source | W5 snapshot/hash, height-source, streaming tests |
| Settlement composition and density | `src/game.js` town opportunity branches and `targetCount`; `src/settlement-building-visuals.js` compositions; Frontage, Lot, civic and life-detail modules | matched by P2, PO review pending | W5 remains byte-identical. A W8-only canonical overlay fills CITY/TOWN/RURAL to the finite building-opportunity ratios (normal 78%, Military 60%, Suburb 50%) with the protected type compositions, road-facing Lots, deterministic Stable IDs, fixed High-quality gameplay density, and the existing natural/life-detail layers. Near, far, collision, and Gameplay consume the same combined feature records | `infinite-world-w8-settlement-parity-overlay`, W8 parity Chunk, W5 distribution/hash, Runtime/production render tests; PO 5-minute review |
| Human population and AI | `src/game.js` Human spawn/update paths | matched by P3, Save continuity and PO review pending | High-quality population remains independent of W8 Quality. Stable-ID decisions reproduce finite idle, flee variation, trip/fallen/recover, building avoidance, and tangent water avoidance with frame-rate-independent probabilities; residents now spawn outside their owner Building collision | Gameplay tests; P6 Save tests; PO settlement review |
| Tank | `src/game.js`, `src/constants.js` Tank paths | matched by P4, PO review pending | Score limits, spawn, LOS, turn, cooldown, Projectile, finite collision obstacles, exact non-Human impact/destruction presentation, and Gate B cache-miss behavior are retained | Core Combat, W8 diagnostics, Production Visuals, Save tests; PO review |
| Boss | `src/game.js`, `src/constants.js` Boss paths | matched by P5, Save continuity and PO review pending | Natural and Developer Tools spawn share the protected slither/sweep/charge/dig/breach/recover contract and 14 segments. Tail contact/cooldown, predicted Breach, one-shot landing AoE/push/Scar, 15-shot hyper-rage spray, slither/recover Acid cadence, finite Acid flight/collision, 6 Damage, 1.1s Debuff with 0.75 movement, segment breaks, death cloud, and next threshold are connected to bounded presentation and Audio | Nuclear/Boss, Combat, Experience Shell, Production Visuals tests; P6 Save tests; PO Boss run |
| Buildings and World Objects | `src/game.js`, settlement visual/life modules | matched by P3, Save continuity and PO review pending | Existing Building values including Barn/Factory/Haystack/Cow remain unchanged. Generated grass, flower, shrub, street lamp, and road sign use formal World Detail descriptors instead of `tree`; the finite-destructible road sign uses its Scale gate, radius, one-hit destruction, colored debris, and Stable-ID destruction state | Gameplay, parity Chunk, Production Visuals tests; P6 Save tests; PO review |
| Combat and destruction | `src/game.js`, `src/constants.js`, `src/scale-sandbox.js` | matched by P4, durable revisit reconstruction and PO review pending | Damage, Heal, Score, Hit Stop, Shake, finite High-quality impact/death Particle counts, Rock/Building/Tank Debris, Human blood/Shockwave, Scorch/Blood Scar, bounded Ruins, and Atomic output/lifetimes use the protected finite values in fixed resource pools | Combat, destruction, resource lifecycle tests; P6 revisit tests; PO 5-minute review |
| HUD and settings | `index.html`, `src/game.js` | partial with intentional W8 menu differences | Keep New Game/Continue and functional W8 controls; match finite functional HP, Score, Scale, Atomic, Boss, News, Game Over, Mouse, Volume, Shake, FPS, Quality, and confirmed antialias behavior; omit inactive placeholders | Experience Shell, browser-equivalent tests; PO review |
| Audio | `src/game.js` finite Web Audio functions | matched by P4, PO review pending | Swish, Hit, Splat, Tank fire, Roar, Rumble, Acid, and Atomic use the finite oscillator voices on the same Presentation Event frame; the finite double-Claw path repeats Swish twice without duplicating Gameplay resolution; the declared but uncalled finite Attack cue remains unused | CombatCommand and Audio/presentation tests; PO review |
| Save and revisit | finite has no equivalent Infinite persistence; W8 v4 contract | intentional W8 extension, new parity state pending | Preserve old-save compatibility and persist durable Player/Human/Boss parity state; rebuild durable destruction presentation from Stable IDs; never persist transient Particle/cache state | migration, round-trip, corruption, revisit tests |

Ledger states may change only with code and verification evidence recorded in this section.
No row may be marked matched because a similarly named module exists; the finite behavior,
presentation, and Player-visible outcome must be covered.

### Migration Gate order

1. P0: this contract and ledger.
2. P1: Player, intro, camera, and landing Gameplay.
3. P2: World and Settlement archetype experience.
4. P3: Human and World Detail Gameplay.
5. P4: Combat, destruction, Tank integration, presentation, and Audio.
6. P5: complete Boss Gameplay and presentation.
7. P6: UI, settings, and backward-compatible Save continuity.
8. P7: automated regression, paired Player Experience acceptance, then a fresh Gate C execution.

Each production Gate is one scoped change. A failed test, an untraceable specification,
or a required W5/protected-source change stops that Gate without starting Gate C. Content
density must not be reduced merely to make performance pass; optimization requires a
separate measured change that preserves the parity ledger.

## W8 Gate C contract

### Status

- Gate B: closed.
- Gate C contract: defined.
- Gate C execution: not started.
- W8 milestone: not yet closed.

### New contract decision

Gate C is the final performance and hands-on verification Gate for the W8 already
implemented through Gates A and B. It adds no W8 feature and performs no additional
optimization. Its purpose is to determine whether W8 can be formally closed after
comparison measurements against the finite World and Project Owner hands-on
verification.

### Required work

1. Measure the finite World for five runs under the same conditions.
2. Measure W8 for five runs under the same conditions.
3. Record the prerequisites for every run, calculate each median, and compare the
   existing documented performance metrics.
4. Have the Project Owner verify W8 in its normal state for three minutes, record
   the result, and determine whether W8 may be formally closed.
5. Record the outcome in this W8 progress document.

The finite World and W8 must use, as far as possible, the same device, browser,
resolution, settings, start conditions, and warm-up policy. No code, setting, or
Gameplay value may change during measurement. Unfavourable runs must not be
discarded. If an abnormal run must be excluded, record its reason and do not silently
replace it with a rerun. Use medians, not means.

### Measurement protocol

The following is a Project Owner decision for Gate C measurement. It fixes the
measurement conditions and recording method without starting Gate C execution.

#### Environment and execution conditions

- Record the OS used for measurement.
- Use Microsoft Edge and record the current browser version at measurement time.
- Record Window or Fullscreen mode and the Window Size or Resolution used.
- Record Device Pixel Ratio.
- Use the browser-default VSync state, with Hardware Acceleration enabled.
- Measure in the normal state with DevTools closed and without extension influence.
- Use the same PC, browser, display settings, power state, and measurement order for
  the finite World and W8.

#### Runs, warm-up, start, and end

- Run five independent formal runs for the finite World and five independent formal
  runs for W8. Do not stop a set because of an intermediate result.
- Perform one warm-up Run before formal measurement. It is not part of the formal
  result.
- Start each Run through New Game. Begin recording when the Player becomes
  controllable after the normal start sequence; retain the corresponding initial
  camera and UI state for the finite World and W8.
- The Project Owner performs the same operation in the finite World and W8. A Run
  ends after that same operation is completed.

#### Recording, abnormal Runs, and remeasurement

For every Run, record frame p50, frame p95, frame max, frames-over-50ms rate, and
Chunk transition p95. Record each five-run median and the per-metric pass/fail result.

Do not exclude an abnormal Run merely because its result is unfavourable. Browser
crash, OS update, or an external factor may justify exclusion only when the reason is
recorded. If production code, Gameplay, save schema, or generator behavior changes
during measurement, restart all five formal runs from the beginning.

#### Undefined protocol items

Existing documents do not define the detailed Project Owner operation, its route or
duration, an exact Run end event beyond completion of that operation, or an exact
finite-World/W8 run interleaving order. This contract does not invent those details.

### Performance acceptance criteria

Existing W8 documentation defines the comparison method: five finite-World runs
and five W8 runs with median comparison. It also records these measurement metrics:
frame p50, frame p95, frame max, percentage of frames over 50ms, and Chunk transition
p95. The W8 diagnostic section records a single W8 confirmation run and states that
it met the W8 absolute floor.

The following are Project Owner decisions formally adopted for Gate C. They are not
values discovered in existing documentation. Measure both the finite World and W8 for
five runs, record the raw data and each five-run median without rounding a value into
passing, and judge every metric individually. Both absolute and relative criteria
must pass; passing only one does not pass Gate C.

| Metric | Absolute criterion | Relative criterion |
| --- | --- | --- |
| frame p95 | 33ms or less | W8 median must not worsen by more than 20% from the corresponding finite-World median |
| frame max | 100ms or less | W8 median must not worsen by more than 20% from the corresponding finite-World median |
| frames over 50ms | 1.0% or less | W8 median must not worsen by more than 20% from the corresponding finite-World median |
| Chunk transition p95 | 100ms or less | W8 median must not worsen by more than 20% from the corresponding finite-World median |

Any run immediately fails Gate C if it has a freeze, loss of control, Runtime stop,
missing Chunk, clear visual collapse, Save or Continue corruption, or mismatched
measurement conditions. A blocker found during the Project Owner three-minute hands-on
verification is also an immediate failure.

If production correction becomes necessary during measurement, stop Gate C as
incomplete, keep the correction separate from Gate C measurement results, and repeat
all five runs from the beginning after the correction. Gate C execution remains not
started until measurement is explicitly begun.

### Three-minute hands-on verification

The Project Owner verifies, through New Game or the formal normal start path, that:

- Chunk streaming continues without conspicuous missing Chunks, terrain loss, or
  boundary failure.
- There is no loss of control, blocked progression, or recurrence of a long freeze.
- Tank spawn, Tank AI, Tank fire, Projectile, World Object collision, and combat
  operate normally.
- Production Visuals have no clear missing elements.
- Save and Load follow the W8 formal contract.
- No new serious Console error recurs continuously.

Visual review does not define a new abstract "visual parity" requirement. It uses
only the finite-World comparison source, invariants, and provenance already recorded
for W8.

### Completion and failure conditions

Gate C can close W8 only when the Gate C contract is recorded; the required five-run
raw data and medians for both finite World and W8 are recorded; the Project Owner
performance acceptance criteria are met; the Project Owner three-minute verification is
complete without a blocker; W8 invariants and protected files remain intact; existing
repository regression tests pass; and the result is recorded here.

Gate C fails or remains incomplete if measurement conditions cannot be aligned, a
required performance metric cannot be identified, W8 misses a Project Owner
performance acceptance criterion, hands-on verification finds a freeze, blocked
progression, serious Chunk loss, serious error, or a blocker in Save, combat,
streaming, or Production Visuals, or a production change or protected/invariant change
becomes necessary.

If Gate C fails or a defect is found, do not close W8 and do not begin a production
fix in the Gate C measurement change. Record the measurements and blocker, separate
any fix into another Gate or fix contract, and do not mix pre-fix and post-fix
measurement results.

### Scope restrictions

Gate C does not add features, adjust Gameplay, add after-the-fact optimization,
permanently add performance instrumentation, change save schema, generator or Chunk
streaming behavior, W5 canonical ChunkData, terrain height, Stable ID, content hash,
or protected finite-World files, or add Growth, Wanted, Threat, or Nation.
