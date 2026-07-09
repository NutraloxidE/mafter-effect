# preview-loop-wrap decision record

- status: FINAL
- date: 2026-07-09
- fixture: `verify-comp33-mini-project.zip`（repo root。Comp33＝背景 native `<video>` + Person packed alpha `<video>`、`doc/issue/preview-improvement-plan-v2-for-codex.md` 指定の実症状再現体。生成スクリプト: `build-mini-comp33-zip.mjs`（一時物・未コミット、再生成手順は本ファイル末尾）。ソース: Downloads 最新 `mafter-project (25).zip` の Comp33 = `01KWZKBBD4CMNVGYKW5BXBZF38`、fps=30・duration=150frame(5s)。BG layer=`01KWZKBC8RCCGNM2MWJZM4G93J`、Person layer=`01KWZMGQFNV98G93STQGTTD32F`（asset `01KWZMGQFM57DSRCKX74ZKCJDW`、packed webm/VP9・duration 5s・trimStart 0）。

計測スクリプト: [capture-comp33-loop-wrap.mjs](capture-comp33-loop-wrap.mjs)（実 Chrome headed・CDP screencast + rAF 全速内部ログ + `seeking`/`seeked` イベント計装）。実 Chrome（`channel:"chrome"`）、`https://localhost:5173`。workArea=comp全体（0..150、loopStart=0）、loop ON、63秒再生 ×2 trial（`out/live/`、2 回目実行で上書きされるため raw JSON は trial2 のみ残置・trial1 は本ファイルに要約を転記）。

---

## baseline（修正前の実測値）

- freeze_pct_30s: **約 9.8%**（trial2, 63秒キャプチャの内部 hold ログ基準。80 hold events / 総 hold 6198ms / 総再生 63013ms。report.md の `3bd1f3c` baseline 5%・`7c888f7` baseline 10% と同オーダーで整合）
  - **重要な計測妥当性の注記**: 同一キャプチャで ffmpeg `freezedetect`（全画面ピクセル差分）を回すと **0 windows / 0%** だった。理由: hold 中は `cf`（タイムラインフレーム）が進まず render も止まるため Person canvas 合成・text・camera 変換は静止するが、**BG の `<video>` 自体は明示 pause されていない限りブラウザのネイティブ compositor が独立して描画を続ける**ため、画面全体としては十分なピクセルが動き続け freezedetect の閾値（`n=0.002`）に達しない。つまり「timeline 全体が hold で止まる」（report.md の VideoDecoder 経路・全レイヤー同時凍結ケース）と「Person 側だけが seek/decode 待ちで一時停止し BG は動き続ける」（今回の native `<video>` 経路の wrap 症状）は**視覚的性質が異なり、全画面 freezedetect は後者を過小評価する**。本計測では内部 hold ログ（cf 停滞、閾値 1.5frame=50ms）を per-wrap freeze の一次指標として採用し、report.md の「hold と freezedetect が二重一致」という検証はグローバル凍結ケースに限定されるものとして扱う。
- desync_p95_frames: **5.73（trial1）〜 24.39（trial2）**（`video.currentTime` ベース、subject−bg、displayed frame 換算）。trial 間でのこの大きな振れ幅自体が S1（往復ドリフト）の証拠であり、H1（二値ゲート発振・currentTime は presented frame の代理として不十分）を支持する。WP-2 の presented-frame（rVFC）計測への移行が必要という結論はこの baseline から直接裏付けられる。
- wrap_freeze_ms_median: **0**（trial1: 0, trial2: 0。22 wrap 中 16 wrap は internal hold 0ms＝完全にスムーズ）
- wrap_freeze_ms_max: **533ms**（trial2 wrap@45.71s。trial1 max は 451ms @38.21s）

---

## discriminator（S3 スムーズループの判別因子・実測で確定）

- discriminator: **mixed**
- evidence:

Comp33・workArea=comp全体（loopStart は常に両クリップとも source time **0秒**=trimStart 0。両アセットとも t=0 は定義上キーフレーム直上のため、**このフィクスチャでは keyframe-distance は全 wrap で不変**＝H4/WP-3 は本計測では判別因子たり得ない）。2 trial 合計 22 wrap を分類:

| trial | wrap数 | freezeMs=0 | freezeMs 50-63(閾値付近ノイズ) | freezeMs 380-533(大) |
|---|---|---|---|---|
| 1 | 11 | 6 | 4 | 1（451ms @38.21s） |
| 2 | 11 | 7 | 2 | 2（381ms @36.95s, 533ms @45.71s） |

**cache-overlay は構造的に到達不能と実測で確定（除外）**: `previewCacheService` の `Caching` 設定を強制 ON にし `startBackgroundBuildIfNeeded()` を直接呼んでも、`RamPreviewController.startBackgroundBuildIfNeeded()`（[ramPreview.ts:280](../../../src/editor/ramPreview.ts#L280)）が `if (this.isRealtimeCapable()) return;` で即 return し、bake が一度も開始しなかった（120秒待機後 `isWorkAreaBuildComplete()` は false のまま）。Comp33 は video+text+camera のみで resolve/DOM 更新コスト自体は軽く「realtime capable」と判定されるため、**ボトルネックが video decode 側にあるケースでは Caching を有効化しても bake が起動しない**。加えて `compNeedsAutoPreviewCache`（[previewCompAnalysis.ts:72](../../../src/editor/previewCompAnalysis.ts#L72)）も video component を条件に含まない（idea doc の既知の穴どおり）。**二重の理由で cache-overlay 経路は本症状に無関係** — WP-A（`compNeedsAutoPreviewCache` に video 条件追加のみ）はこのクラスの comp では `isRealtimeCapable()` ゲートを通過できないため**単独では効果がない**可能性が高い（実装するなら `isRealtimeCapable()` 側の改修も必要になるが、これは本プランの WP-A スコープ外＝今回は route に含めない）。

**buffered（JS 可視の `.buffered` API）は全 wrap で一定＝単純な判別因子にならない**: 22 wrap 全てで bg/person とも `buffered` は `[[0, duration]]` で loopStart(0秒) を常に含み（`containsLoopStart: true`）、`readyState` も常に 4（HAVE_ENOUGH_DATA）。にもかかわらず実際の seek 所要時間（`seeking`→`seeked` 間隔、`personSeekDurationMs`）は **5〜34ms（クリーンな wrap）から 138〜1350ms（大 freeze の wrap）まで実測で 40〜270 倍のばらつき**があった。つまり `.buffered` が「データはある」と報告していても、**内部デコーダ状態（JS から不可視）は毎回同じではなく、seek 完了までの実コストが非決定論的に変動する** — これは決定ゲート表の「buffered」カテゴリの記述（「buffered 依存は制御不能」）と一致する実測結果である。

**gate-state（二次的な増幅要因）**: 大 freeze 3件中 2件（trial1 @38.21s, trial2 @36.95s）で Person 側 `seek` イベントが通常 2 回（seeking→seeked）のところ **3 回**発生していた（＝1 回目の seek が完了する前に 2 回目の再 seek が発行され、遅延が積み増しされた形跡）。残り 1 件（trial2 @45.71s, freeze 533ms・最大）は seek 回数は 2 回のままだが bg/person 双方が `paused:true` かつ **hold イベントが単発ではなく 6 回・約 1.8 秒間断続**しており、H1（二値ゲートのリミットサイクル / hold-pause 発振）と一致する挙動が wrap 直後に観測された。

**結論**: 単一変数で綺麗に分離できる判別因子は見つからなかった（`buffered`/`readyState`/`cacheOverlayActive` は全 wrap で不変、`paused` は大 freeze 3件中1件のみで一致）。実態は「**loopStart への live seek がほとんどの場合は高速完了するが、内部デコーダ状態に依存して稀に大幅に遅延し（H3/H4 相当の decode 律速が buffered API では見えない形で発現）、その遅延中に同期コードが冗長な再 seek やゲート発振を誘発して増幅する（H1 相当）**」という複合現象。決定ゲート表の `mixed / unknown → WP-1 → WP-2` に該当する。

---

## route（Codex が実施する WP と順序）

- order: [WP-1, WP-2]
- notes:
  - **WP-1 を先に実施する根拠**: 観測された大 freeze はすべて「表示中クリップの live 要素に対する wrap 時点の seek+decode」が原因であり、これは Idea 1（ループ折り返しダブルバッファ）が直接排除する経路そのもの。wrap 前に 2 本目の要素を loopStart へ warm-up 済みにしておけば、内部デコーダ状態の非決定性・冗長 re-seek の両方とも構造的に発生しなくなる（seek 自体が wrap 瞬間に発行されないため）。
  - **WP-2 を WP-1 の後に実施する根拠**: 本計測の desync_p95（5.73〜24.39 frame、trial 間で大きく変動）は S1（往復ドリフト）の直接証拠であり、`video.currentTime` ベースの二値ゲートの限界（H1）を裏付ける。WP-1 は wrap 時点の freeze を消すが、定常再生中の drift/発振には効かないため WP-2（presented-frame 計測 + playbackRate サーボ）が別途必要。
  - **WP-A は route に含めない**: 上記の通り `isRealtimeCapable()` ゲートにより Comp33 型（video decode がボトルネックで resolve/render は realtime）の comp では bake が構造的に起動せず、WP-A のスコープ（`compNeedsAutoPreviewCache` への video 条件追加のみ）では本症状は解消しない。将来 WP-A を検討する場合は `isRealtimeCapable()` 側の設計変更が別途必要（本 Phase 0 のスコープ外・ユーザー確認事項）。
  - **WP-3（GOP 短縮）は route に含めない**: 本フィクスチャは loopStart が常に両クリップの source t=0（定義上キーフレーム直上）のため、GOP 短縮が wrap seek を改善するかは今回のデータでは検証不能（悪化させる証拠もない）。WP-1 実施後も残留する非 wrap 時（スクラブ等）の seek 遅延が問題になった場合の追加候補として保留する。
  - WP-1 実装時の追加注意（本計測から）: 大 freeze 時に observed な「Person 側の冗長 re-seek（3 回 seek イベント）」は、warm-up 済み要素への交代ロジックが既存の resync/re-seek パスと二重に発火しないよう注意すること（交代が完了した後は同期コードが交代先要素に対して追加の corrective seek を出さない設計にする）。

---

## 再現手順（Codex/検証者向け）

```sh
# フィクスチャ再生成（Downloads の最新 mafter-project (*).zip から Comp33 を抽出する場合）
node build-mini-comp33-zip.mjs   # repo root、要 jszip（devDependency）

# dev server を起動した状態で
node doc/issue/preview-loop-wrap/capture-comp33-loop-wrap.mjs           # live（cache なし）
CACHE_MODE=1 node doc/issue/preview-loop-wrap/capture-comp33-loop-wrap.mjs  # cache 強制 ON（bake 未着火を確認する場合。現状 timeout で FATAL 終了するのが正しい結果）
```

出力: `doc/issue/preview-loop-wrap/out/<live|cache>/metrics.json`（per-wrap 分類・freeze/desync 統計）、`raf-log.json`（内部クロック全ログ）、`seek-events.json`。
