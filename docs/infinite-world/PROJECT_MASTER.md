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
**最新実装commit:** `dbdfb2c feat: stream tree presentation through shared plans`
**Origin差:** pushなし / behind 0
**現在Phase:** Phase 5A正式完了、Phase 5B開始前
**Phase 4:** 完了・commit済み
**Phase 5A:** Tree Static Stream移行完了・commit済み
**Vegetation LOD:** 実装済み差分を未commitで保持
**現在の目的:** Bush / Rock / GrassをTreeと同じStatic Stream基盤へ移行する。

---

## 10. 完了済みPhase

- [x] Phase 0: Baseline
- [x] Phase X: Streaming Invariant
- [x] Phase 1: Telemetry
- [x] Phase 2: World Streaming Plan / Policy Registry
- [x] Phase 3: Canonical Owner Cache
- [x] Phase 4: Worker Scheduler
- [ ] Phase 5: Static Object Stream（Phase 5A Tree完了、Phase 5B未着手）
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

Phase 5Aは正式完了。Treeを共通Streaming Planの最初のconsumerとして接続し、
高速移動時にTreeが遅れて出現する問題を解消した。

確認済み:

- velocity-aware ready-set
- owner reuse
- stale publication ticket拒否
- required / prefetch全件Ready
- backlog 0
- failed 0
- Worker 1
- 高速移動時の森林密度低下なし
- 停止後の一括出現なし
- 急旋回後のTree欠落なし
- Continue優先度競合を修正
- 全repository serial suite 705/705 PASS
- Phase 5A staged tree単独検証 87/87 PASS
- commit後関連integration 108/108 PASS

Browser Current / High:

- required owner 505/505 Ready
- prefetched owner 122/122 Ready
- backlog 0 / failed 0 / Worker 1
- frame p95 12.2ms / max 90.9ms
- 高速直進、停止、急旋回で進行方向の密度低下・停止後の一括出現なし

次工程はBush / Rock / GrassのStatic Stream移行。Phase 5B開始前で停止中。

---

## 13. 現在の決定事項

- Treeの描画距離不足ではなく、先読み・再利用・publication starvationが原因だった。
- Tree高速移動問題はvelocity-aware ready-set、owner reuse、scheduler、publication ticketで解消した。
- 生成coverageとpublication freshnessは分離する。
- 同じowner集合ならstate revision更新だけで生成をcancelしない。
- Gameplay requestをStatic presentationより優先する。
- Tree成功後にBush / Rock / Grassを同じStatic Streamへ移行する。
- Tree専用prefetchやObject名分岐は作らない。
- Worker Poolは現時点で採用しない。

---

## 14. 未解決

### Priority A

- generation p95 329.9msをPhase 11 Production Acceptanceで正式再評価する
- foreground Browser 5-run、長時間soak、50ms超frame率をPhase 11で正式判定する

### Priority B

- Bush / Rock / GrassのStatic Stream移行
- Building / Settlementの共通Plan接続
- owner/page単位Publication Coordination

### Priority C

- Dynamic Entity Stream
- Critical Entity Lease
- Extension API

---

## 15. 次にやること

1. Phase 5BとしてBushをTreeと同じStatic Stream policyへ接続する。
2. Bush合格後、Rockを同じ基盤へ移行する。
3. Rock合格後、Grassを同じ基盤へ移行する。
4. Object別のready-set、owner reuse、publication、Stable ID、destructionを比較する。
5. Phase 5B完了後に全repository serial suiteとBrowser高速移動を再実行する。

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
