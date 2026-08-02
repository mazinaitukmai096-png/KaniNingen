# PROJECT_MASTER.md

## 1. プロジェクト概要

**プロジェクト:** KaniNingen Infinite World
**目的:** Infinite Worldを正式版として完成させる。

最終目標は、高速移動でも描画が破綻せず、Stable IDとSave v5互換を維持し、新しいObjectやMobをpolicy登録中心で追加でき、長時間プレイでも安定する状態にすること。

---

## 2. 設計思想

- Static / Dynamic / Criticalを分離する。
- World Streaming Coordinatorは制御だけを担当する。
- 描画LOD、Mesh、Material、ShaderはObjectごとに維持する。
- AI、Physics、CombatはDynamic Streamへ統合しない。
- Stable ID、Save、Gameplay整合性を最優先で保護する。
- Treeだけの局所的なprefetchや特例処理を追加しない。
- Worker Poolは前提にせず、まず単一Workerの再利用・優先度・キャンセルを改善する。

```text
Player
  │
World Streaming Coordinator
  │
World Streaming Plan
  │
Canonical Owner Cache
  │
Worker Scheduler
  │
Publication Coordinator
  ├─ Static Object Stream
  ├─ Dynamic Entity Stream
  └─ Critical Entity Lease
```

---

## 3. ChatGPTとCodexの役割

### ChatGPT

ユーザーがCodexの完了報告を貼ったら、追加指示を待たずに次を自動判断する。

1. 完了・未完了・blockerの判定
2. 問題と回帰の有無
3. commitの要否と安全なcommit境界
4. Browser確認の要否
5. 次のCodex指示
6. 推奨モデル・推論レベル・目安時間
7. PROJECT_MASTER.mdの更新内容
8. 新チャットへ移るべきか
9. 長い報告の要約

回答は必要最小限にし、同じ説明を繰り返さない。
ユーザーに毎回「次」「指示」「マニュアル更新」と言わせない。

### Codex

- 実装
- 自動テスト
- Git操作
- Browser確認
- 性能計測
- PROJECT_MASTER.mdの更新
- 最終報告

Codexは明示指示なしにpush・tag・reset・squashを行わない。

---

## 4. 丸投げ運用フロー

```text
ユーザーがCodex報告を貼る
        ↓
ChatGPTが自動判定
        ↓
必要ならBrowser確認
        ↓
安全ならcommit
        ↓
PROJECT_MASTER.md更新
        ↓
次のPhase指示
        ↓
Phase区切りなら新チャットへ移行
```

ユーザーが基本的に行うのは、Codexの報告を貼ることだけ。

---

## 5. トークン節約ルール

- Phaseまたは大きな作業区切りごとに新チャットへ移る。
- 新チャットでは最新版のPROJECT_MASTER.mdだけを最初に共有する。
- 必要なら直前のCodex最終報告だけを追加する。
- コマンドログ全文は貼らず、結果・失敗・commit・Git statusだけを共有する。
- Codex指示は現在の作業だけを書く。先のPhaseを混ぜない。
- 同じ禁止事項や説明を必要以上に繰り返さない。
- commit作業・確認作業は中、通常実装は高を基本とする。
- Ultraは全面的なアーキテクチャ再設計で、他のレベルでは成立しない場合だけ使う。
- 長い表や設計比較は、判断に必要な場合だけ作る。
- PROJECT_MASTER.mdは簡潔に保ち、古い詳細ログを蓄積しない。

---

## 6. Browser確認ルール

ChatGPTは変更内容からBrowser確認の必要性を自動判断する。

### 原則として必要

- UI・HUD・設定画面
- LOD・Fog・描画距離
- Tree、Building、Terrain、Waterなどの表示
- Shader、Material、WebGL resource
- Gameplay入力・Combat
- Save / Continue / Retryの実操作
- Streaming・高速移動・Floating Origin
- FPS、frame time、Draw Callなど実GPU性能

### 原則として不要

- 文書だけの変更
- 純粋なUnit Test追加
- 挙動中立の内部整理
- commit分離だけ
- Browserでしか確認できない事項がないCacheやSchema変更

### Browserが利用できない場合

- 自動テストやHarnessで確認可能な範囲を実施する。
- 実Browser未確認を明記する。
- 視覚品質や実GPU性能を推測でPASSにしない。
- Browser確認が受入れ条件ならcommitを保留するか、条件付き保存として扱う。

### Save保護

- 既存Continue Saveを無断で上書きしない。
- 検証専用seedまたは検証専用Save keyを使用する。
- 検証Saveの削除または既存Save無影響を確認する。

---

## 7. Gitルール

- 1 commit = 1目的
- Phaseや依存関係ごとに小さく保存
- commit前後に関連テストを実行
- push / tagは明示指示まで禁止
- rollbackはgit revert
- reset --hard、checkoutによる差分破棄、stash drop、巨大squashは禁止
- 既存の未commit差分を勝手に破棄しない
- 混在ファイルはhunkまたはindex blobで安全に分離する
- 依存関係が成立しないcommitは作らず停止する

必須確認:

```text
node --check
git diff --check
関連テスト
必要なら全repository serial suite
git status
```

---

## 8. PROJECT_MASTER.md自動更新ルール

Codexは各Phase完了時または重要commit後に、このファイルを更新する。

更新対象:

- 現在の状態
- 完了済みPhase
- 現在進行中
- 未解決
- 次にやること
- 重要commit履歴
- Browser結果
- Performance
- Save / Stable ID状態
- 現在有効な判断

更新時のルール:

- 古い実行ログは残さない。
- 最新状態に置き換える。
- 重要な設計理由と未解決だけを残す。
- ファイルを不必要に長くしない。
- PROJECT_MASTER.md更新は、原則としてPhase実装commitとは別の小commitか、同じPhaseのdocs更新として明示する。
- ChatGPTはCodex報告を受けたら、更新指示を次の指示へ自動的に含める。
- ユーザーに更新を思い出させる作業をさせない。

---

## 9. 現在の状態

**Branch:** `feature/infinite-chunk-sandbox-w1a`
**最新実装commit:** `fac3f5a fix: gate player movement on terrain coverage`
**Origin差:** pushなし / behind 0
**現在Phase:** Phase 5B進行中
**Phase 4:** 完了・commit済み
**Phase 5A:** Phase 5A-2のincremental publication、persistent bucket、terrain coverage gateまで完了
**Vegetation LOD:** `1a0a32a`でcommit済み
**現在の目的:** Bush / Rock / GrassをObject別LODのまま共通Static Object Streamへ移行し、Harnessと回帰testで検証する。

---

## 10. 完了済みPhase

- [x] Phase 0: Baseline
- [x] Phase X: Streaming Invariant
- [x] Phase 1: Telemetry
- [x] Phase 2: World Streaming Plan / Policy Registry
- [x] Phase 3: Canonical Owner Cache
- [x] Phase 4: Worker Scheduler
- [ ] Phase 5: Static Object Stream（Phase 5A-2完了、Phase 5B進行中）
- [ ] Phase 6: Building / Settlement
- [ ] Phase 7: Publication Coordination
- [ ] Phase 8: Dynamic Entity Stream
- [ ] Phase 9: Critical Entity Stream
- [ ] Phase 10: Extension API
- [ ] Phase 11: Production Acceptance

---

## 11. 重要commit

| Commit | 内容 |
|---|---|
| `66d2a79` | World Streaming Telemetry |
| `db820c9` | Behavior-neutral World Streaming Plan |
| `8845f03` | Canonical Forest Horizon manifests |
| `346d6cf` | Canonical Owner Cache共有 |
| `1ad5b53` | 単一Worker Scheduler、priority、deadline、aging、cooperative cancellation |
| `dbdfb2c` | Tree presentationの共通WorldStreamingPlan / Static Stream接続 |

---

## 12. 現在進行中

Phase 5Aの以前の受入れ判定は取り消した。ready-setがReadyでも、Distant rootの
全owner compose完了までpublishされず、高速移動時のTree遅延とmain-thread freezeが残っていた。
Phase 5A-2ではowner/page単位publication、persistent bucket、dirty range更新、
frame-budget upload/disposeへの移行を完了した。Phase 5BではBush / Rock / Grassを
Object別policy登録から同じowner/page publicationとpersistent Natural bucketへ接続している。

Phase 5A-2の停止→密度回復→再加速Harnessで、次の集中要因を確定した。

- 停止coverage外のstale corridor workがqueue/in-flightに残る
- ready page admission、build、visibility、compose、Buffer更新、dispose、publicationのbudgetが分断される
- 旧owner disposeが再加速時の1 frameへ集中する
- bucket末尾compactionによりresident instanceのmatrix再composeが発生する

停止coverageが安定した時点のstale cancellation、最新coverage外の完了結果の
publication抑止、required/deadline優先の統合frame budget、1 owner/frame admission・dispose・
publication、compaction移動のframe分散を実装・自動検証した。Browser自動操作は行わず、
ユーザー実機で全力走行、停止、再加速時のfreeze非再現を確認した。

Path Auditで、Coordinator、Static Stream、shadow planはboot時点で準備済みにもかかわらず、
`applyPlan`がDistant outer warm全体の完了までactivation fenceで禁止されていたことを確定した。
最初のDistant Tree可視からStatic Stream activationまで約9.9秒あり、このfenceが起動遅延の
確定原因だった。Phase 5A-2ではactivationを最初の有効なshadow planへ接続し、Distant warmは
初期表示を準備する独立処理として維持する。同じownerはStatic Streamのpending/ready taskへ
合流させ、on-demand consumerをbackground queueより優先して重複生成を防ぐ。

確認済み:

- velocity-aware ready-set
- owner reuse
- stale publication ticket拒否
- required / prefetch全件Ready
- backlog 0
- failed 0
- Worker 1
- ready済みとfirst draw済みを別指標として追跡
- Continue優先度競合を修正
- outer warm activation fenceを切り離し、最初のshadow planからStatic Streamを開始
- Distant warmとStatic Streamのowner要求をpending/ready reuseでdedupe
- activation fence修正後の全repository serial suite 712/712 PASS
- 全repository serial suite 705/705 PASS
- Phase 5A staged tree単独検証 87/87 PASS
- commit後関連integration 108/108 PASS

Browser Current / High:

- required owner 505/505 Ready
- prefetched owner 122/122 Ready
- backlog 0 / failed 0 / Worker 1
- frame p95 12.2ms / max 90.9ms
- 高速直進、停止、急旋回で進行方向の密度低下・停止後の一括出現なし

上記Browser値は初回Phase 5A時点の参考値であり、正式5-runはPhase 11で再判定する。

---

## 13. 現在の決定事項

- Treeの描画距離不足ではなく、先読み・再利用・publication starvationが原因だった。
- velocity-aware ready-setだけではfirst drawを保証しない。owner/page publicationまでをGateとする。
- 生成coverageとpublication freshnessは分離する。
- 同じowner集合ならstate revision更新だけで生成をcancelしない。
- Distant outer warmはStatic Streamのactivation条件にせず、独立した初期表示warmとして継続する。
- Static Stream activationは最初の有効なshadow planで一度だけ行い、suspend / relocation中は適用しない。
- Gameplay requestをStatic presentationより優先する。
- Phase 5A-2はユーザー実機確認まで合格。Phase 5Bは明示承認を受けて進行中。
- Tree専用prefetchやObject名分岐は作らない。
- Worker Poolは現時点で採用しない。

---

## 14. 未解決

### Priority A

- Current / High / MAXの正式5-runをPhase 11で判定する
- generation p95 329.9msをPhase 11 Production Acceptanceで正式再評価する
- foreground Browser 5-run、長時間soak、50ms超frame率をPhase 11で正式判定する

### Priority B

- Bush / Rock / GrassのStatic Stream移行とHarness検証（進行中）
- Building / Settlementの共通Plan接続
- owner/page単位Publication Coordination

### Priority C

- Dynamic Entity Stream
- Critical Entity Lease
- Extension API

---

## 15. 次にやること

1. Bush / Rock / GrassのObject別policyと共有owner coverageを検証する。
2. incremental publication、frame budget、stale cancellationの共通利用を検証する。
3. Stable ID、destruction、Continue / Retry、Floating Originの回帰を確認する。
4. Phase 11で正式5-run、長時間soak、generation p95を再評価する。

---

## 16. Performance Gate

- frame p95: 33ms以下
- frame max: 100ms以下
- 50ms超frame率: 1.0%以下
- Chunk transition p95: 100ms以下
- Plan計算p95: 1ms以下
- Player到達時required owner missing: 0
- publish starvation: 0
- resident canonical ownerの重複生成: 0
- stale result publication: 0
- 長時間実行でheapの継続増加なし
- Material / Mesh / Geometry / Drawは個体数に比例して増加しない

最新Phase 5A Browser実測はframe p95 12.2ms、max 90.9msでframe Gate内。
generation p95 329.9msは100ms Gateを超えているため、Phase 11の正式5-runで再評価する。
Phase 5Aではrequired ownerの到達時missing、backlog、failed、stale publicationは0だった。

---

## 17. Save / Stable ID

- Save schema v5を維持
- Stable ID生成式を変更しない
- cache、manifest、root、plan、Telemetry、leaseは保存しない
- destructionは最新Gameplay stateからpublication時に適用
- Continue / Retryでcanonical stateを再適用
- Floating Originはrender transformだけを変更する
- interactive presentationをGameplay ownershipより先に公開しない

---

## 18. Definition of Done

- Tree / Bush / Grass / Rock / Building / Settlementが共通WorldStreamingPlanへ参加
- Object固有LOD、Mesh、Material、Shaderを維持
- Human / Tank / Mobが現行AIのままDynamic Streamへ参加
- BossがCritical Leaseへ参加し、距離で消えない
- 新しいStatic ObjectとMobをpolicy登録で追加可能
- CoordinatorにObject名分岐がない
- 高速移動時の遅延出現・消失・密度低下がない
- PLAY-SYNC-01、Stable ID、Save v5、damage、Retry、Floating Origin、Water handoff、Settlement LODを維持
- 全自動テスト、Browser Acceptance、Performance Gate、長時間soakが合格

---

## 19. 新チャット移行ルール

以下のいずれかで新チャットへ移行する。

- Phase完了
- 大きなcommit境界
- 会話やログが長くなった
- 別種の問題へ移る
- ChatGPTがコンテキスト消費が大きいと判断した

新チャット冒頭:

```text
PROJECT_MASTER.mdを読んで、現在の状態から続けてください。
必要なら直前のCodex最終報告も参照してください。
```

ChatGPTは移行時に、最新版PROJECT_MASTER.mdの更新または作成を自動で案内する。

## 20. Phase 5A-2完了記録

Phase 5A-2は正式完了。Phase 5Bには未着手。

保存commit:

- `1a0a32a feat: define canonical vegetation lod policies`
- `bc4e723 feat: publish distant world through persistent frame budgets`
- `fac3f5a fix: gate player movement on terrain coverage`

完了内容:

- owner/page単位incremental publication
- Static Streamのstale corridor cancellation
- persistent Tree / Distant Natural / Settlement bucket
- admission、build、visibility、compose、Buffer更新、dispose、publicationのframe budget化
- Distant outer warmからStatic Stream activation fenceを分離
- Player位置commit前のcanonical Terrain readiness / finite height gate
- 未Ready時の直前位置・正式height維持とprefetch / transition要求
- Save v5、Stable ID、PLAY-SYNC、Floating Origin、destruction、Continue / Retryを維持

検証:

- Vegetation LOD基盤: 17/17 PASS
- Phase 5A-2 staged関連suite: 110/110 PASS
- Player terrain coverage専用: 2/2 PASS
- movement / prefetch / Continue / Retry関連: 49/49 PASS
- 全repository serial suite: 717/717 PASS
- `node --check`: PASS
- `git diff --check`: PASS
- ユーザー実機の全力走行、停止、再加速で以前のfreezeは再現しなかった

Phase 11でforeground 5-run、長時間soak、generation p95を正式再評価する。

## 21. Browser運用ルール

Browserは利用枠を大きく消費するため、原則として使用しない。

優先順位は必ず以下とする。

1. Unit Test
2. Integration Test
3. Harness
4. Telemetry
5. Browser（最後の受入れ確認のみ）

Browserを使う前に、

- Browserでしか確認できない項目
- Browserが本当に必要な理由

を明示すること。

Browser確認は原則1 runのみ。

以下は禁止。

- 同一シナリオの繰り返し実行
- 長時間走行
- 不要な再読込
- 不要なスクリーンショット取得
- Browser待機だけの長時間実行

Browserでは確認できない事項は推測しない。

Browser連携が利用できない場合は、

- 未確認と明記
- Harness／Telemetryで代替可能な範囲だけ確認

とする。
