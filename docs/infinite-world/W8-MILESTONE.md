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

- Status: Gate B closed; Gate C has not started.
- Root cause: Tank Projectile terrain queries generated uncached Chunks through `generator.generateChunk()` during the gameplay frame.
- Formal behavior: Projectile terrain queries are non-generating. Cached terrain keeps normal sampling and collision; a cache miss returns no terrain hit while Projectile movement, lifetime, World Object collision, damage, presentation, and renderer synchronization continue.
- Temporary W8 isolation, frame diagnostics, Audio batching/priming, Clipmap cache, runtime snapshot hot-path, and Projectile shader investigation changes were removed from the closure diff.
- Verification: repository serial test run 394/394 passed; related Core Combat, Sandbox Boot, Production Visuals, and Save tests passed; syntax and whitespace checks passed.
