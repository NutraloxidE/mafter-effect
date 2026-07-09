# Preview Rendering Improvement Idea v2 — 透過動画 preview の「時間経過ドリフト」と「ループもたつき」の解消

- 日付: 2026-07-08
- 起点: [doc/issue/fucked-up-preview/report.md](issue/fucked-up-preview/report.md)（packed VideoDecoder 移行の実ピクセル計測 → 85% フリーズで棄却）
- 現在地: `main` HEAD `a597f75`（native `<video>` packed + perf 系 + 双方向同期ゲート）= **これまでの試行錯誤で最もスムーズ**（ユーザー体感・progress.md 2026-07-08 baseline note と一致）
- 検証フィクスチャ: **Downloads の最新プロジェクト Comp33**（背景通常動画 + packed alpha 人物の混在ケース）

---

## 1. 残っている症状（ユーザー報告・2026-07-08）

| # | 症状 | 対象 |
|---|------|------|
| S1 | 再生開始から **2〜4 秒あたりで映像がタイムラインに対して遅れたり進んだりする**（往復するズレ） | packed alpha レイヤーで顕著 |
| S2 | **ループ再生の折り返しで動画がもたつく**（一瞬止まる／カクつく） | alpha 動画・通常動画の**両方** |
| S3 | **もたつかず最後までスムーズに完走するループも存在する**（S2 は毎回ではなく間欠的） | 同上 |

S3 は重要な手がかり: **スムーズに完走できる実行パスが現行コードに既に存在する**。つまり S2 の修正方針は「新機構を足す」前に「**スムーズ側の成立条件を特定し、それを決定論的に再現（常時成立）させる**」を第一候補にできる（§3 H5・§7 Phase 0）。

report.md の教訓どおり、これらは**実ピクセル計測でしか正しく評価できない**（内部カウンタは「コードが定義上ゼロに保つ値」を測ってしまう）。本ドキュメントの受け入れ基準もすべて実ピクセル基準とする（§6）。

---

## 2. 現行アーキテクチャの要点（コード根拠）

```
タイムラインクロック（rAF wall-clock）          動画クロック（media element 内部）
runPreviewFrameClock / runPreviewPlaybackLoop    <video>.play()（unmuted・ネイティブ decode）
  previewPlaybackLoop.ts                           videoElementSync.ts playbackMode
        │                                                 │
        └────── 双方向ゲート（毎 tick）───────────────────┘
                 playbackVideoSync.ts computePlaybackSyncState
                 ・映像遅れ lag > 1frame  → holdTimeline（タイムライン停止）
                 ・映像先行 lead > 1frame → pauseVideo（video.pause()）
                 ・解除は 0.5frame 以下 / failsafe 1 秒で強制解除
```

- 再生中の drift 矯正 seek は **0.5 秒（≈15f@30fps）超のみ**（`PLAYBACK_RESYNC_THRESHOLD_SEC`、[videoElementSync.ts:210](../src/runtime/videoElementSync.ts#L210)）。それ未満は双方向ゲートが担当。
- ゲートの誤差計測は **`video.currentTime`**（[playbackVideoSync.ts:95-114](../src/runtime/playbackVideoSync.ts#L95-L114)）。
- packed alpha は `<video>` 1 本 + renderFrame ごとの `compositePackedAlpha`（WebGL、CPU フォールバック）で canvas に合成（[DomRenderer.ts:2303-2316](../src/runtime/DomRenderer.ts#L2303-L2316)）。
- カット境界の先読み warm-up は存在するが（[videoLookaheadWarmup.ts](../src/runtime/videoLookaheadWarmup.ts)）、`currentFrame >= clip.inPoint` のクリップを除外するため **ループ折り返し（表示中クリップの中へ戻るジャンプ）には一切効かない**。
- 音声レイヤーがあるときのみ `PreviewAudioClock`（AudioContext マスター）に切替（[PreviewPanel.tsx:675-706](../src/editor/panels/PreviewPanel.tsx#L675-L706)）。

---

## 3. 根本原因仮説

### H1（S1 ドリフト往復）: 二値制御ゲートの発振 + 「見えている画」ではなく `currentTime` を制御している

双方向ゲートは enter=1f / exit=0.5f のヒステリシスを持つが、アクチュエータが **pause() / タイムライン停止という二値**しかない。実デコーダは pause→play の再開に数フレーム分のレイテンシがあるため、「先行 → pause → 追い越される → 遅れ → hold → また先行…」の**リミットサイクル（発振）**に入りやすい。再生開始直後はバッファが揃っていて誤差ゼロ、パイプラインが定常化する **2〜4 秒あたりから発振が始まる**のは制御工学的に自然な挙動で、ユーザー報告と一致する。

さらに制御対象の `video.currentTime` は**デコーダの読み出し位置**であって**画面に present されたフレーム**ではない。オンボード GPU では present パイプラインの深さ分（可変・数フレーム）ずれるため、ゲートが「誤差 0.5f 以内」と判断していても**見えている画は往復ドリフト**する。これは report.md が暴いた「内部カウンタは実ピクセルを測っていない」問題の、**計測スクリプトではなく制御ループ自身への再演**である。

### H2（S1 補助因子）: クロックドメイン分離

unmuted の `<video>` は音声ハードウェアクロックに、タイムラインは rAF（ディスプレイクロック）に従う。skew 自体は小さい（<0.1%）が、H1 の発振に一方向のバイアスを与え「遅れがち／進みがち」の機種差（ユーザー既報）を作る。

### H3（S2 ループもたつき）: 折り返し = 裸の大ジャンプ seek

ループ wrap でタイムライン frame は `loopStart` へ飛ぶ（[previewPlaybackLoop.ts:47-49](../src/runtime/previewPlaybackLoop.ts#L47-L49)）。video 側は `|currentTime − target| > 0.5s` の resync 条件に該当し **その場で seek** → キーフレーム探索 + 前方デコード + present 復帰までの間、映像 plane がフリーズする。alpha の有無に関係なく起きる（ユーザー報告どおり両方で発生）。先読み warm-up はカット in 点専用でここには効かない（§2）。

### H4（S2 増幅因子）: ソース/プロキシの GOP が長い

キーフレーム間隔が長い素材ほど wrap seek の前方デコード距離が伸びる。packed / proxy は自前の `VideoEncoder` 再エンコードなので **GOP は自分で決められる**のに、現状は明示制御していない。

### H5（S3 = 間欠性の判別因子）: 「スムーズなループ」を成立させている既存メカニズムの候補

同じコンプ・同じ操作でループの体感が変わるなら、実行ごとに状態が変わる分岐がどこかにある。コード上の候補は次の 4 つ:

1. **RAM preview キャッシュオーバーレイのヒット**（最有力）。`shouldPreferCacheOverlay(isPlaying)` は**ワークエリアの bake が完了しているときだけ**再生でキャッシュ表示を許す（[ramPreview.ts:179-183](../src/editor/ramPreview.ts#L179-L183)）。成立時はループ全体が**焼き済み PNG blob のフリップ**になり `<video>` の seek に一切依存しない = wrap が完全にスムーズ。bake 未完了・キャッシュ無効（`settings.enabled`）・projectRevision 変化でキー無効化・`isRealtimeCapable()` 判定が realtime 側、のいずれかで live 経路へ落ち、S2 が出る。**「エラー無く完走するループ」と「もたつくループ」の差はこの分岐そのものである可能性が高い。**
   - 注意: キャッシュ発火条件 `compNeedsAutoPreviewCache` は effect ベース（bake 必須 effect / processPixels / full displacement、[previewCompAnalysis.ts:72-78](../src/editor/previewCompAnalysis.ts#L72-L78)）で **video レイヤーの有無は見ていない**。realtime 検出（live render 実測が遅い）経由で偶発的にキャッシュ表示に入るかは実行ごとの計測値次第 = 間欠性と整合する。
2. **`video.buffered` に loopStart が残っている**。2 周目以降や短いループでは折り返し先がデコーダのバックバッファ内にあり、seek が高速に完了する（ブラウザのバッファ保持は不定 = 間欠性と整合）。
3. **wrap 時点のゲート状態**。折り返し瞬間に `pauseVideo`（映像先行で pause 中）だったかどうかで、seek 開始のタイミングと present 復帰の見え方が変わる。
4. **loopStart のソース時刻がキーフレーム直上か**（trim ゼロ = ソース 0 秒はほぼ確実にキーフレーム。trim 付きクリップは H4 に依存）。

いずれが真の判別因子かは §6 の per-wrap 計装で確定させる。仮に (1) なら、修正は「video を含むコンプでもワークエリア bake を確実に完了させ、再生をキャッシュ表示に乗せる」だけで S2 が消える可能性があり、Idea 1 より安い。ただし bake はメモリ・ビルド時間・編集時の invalidation コストがあるため、live 経路の wrap 改善（Idea 1）を不要にするかは計測で判断する。

---

## 4. 改善アイデア（優先度順）

### Idea 1 — ループ折り返しのダブルバッファ交代（S2 直撃・最優先）

wrap の瞬間に seek するのではなく、**wrap の N フレーム前（例: 1 秒前）に同一アセットの 2 本目の `<video>` をプールから確保し、`loopStart` のソース時刻へ先行 seek + prime しておき、wrap 時に要素を差し替える**。

- 既存 infra の組み合わせで作れる: `videoElementPool`（要素プール）+ `primeVideoElement`（[videoElementSync.ts:120](../src/runtime/videoElementSync.ts#L120)）+ lookahead 判定の拡張（`loop && loopEnd − currentFrame <= 窓` のとき `loopStart` 時刻を warm-up 対象に加える）。
- **packed alpha は特に相性が良い**: 表示面は合成 canvas であり `<video>` 自体は不可視。`compositePackedAlpha` への入力 video を切り替えるだけで**画面上は完全に無縫**。
- 通常動画も、DomRenderer のカット境界差し替え（`forceSeek` 経路）と同じ機構で要素 swap すればよい。
- 音声: wrap 時に旧要素を mute→pause、新要素を unmute。音の継ぎ目はループ先頭で必ず不連続になるので体感劣化はない。
- リスク: 低。preview playbackMode 限定・既存プールの流用。export / scrub は触らない。

### Idea 2 — 同期誤差の計測を rVFC（presented frame）ベースに（S1 の土台）

各 primary video に常駐の `requestVideoFrameCallback` トラッカーを付け、**最後に present されたフレームの `mediaTime`** を保持し、`VideoClockSample.currentTimeSec` の代わり（または併記）に使う。

- ゲート／サーボ（Idea 3）が「ユーザーに見えている画」を制御対象にできる。report.md の測定妥当性の教訓を制御ループへ適用するもの。
- rVFC 非対応環境は従来 `currentTime` へフォールバック。
- 変更範囲: `DomRenderer.sampleMountedVideoClocks` 周辺 + `playbackVideoSync.ts` の入力拡張のみ。純関数テストで固定しやすい。

### Idea 3 — pause/hold 二値ゲートを playbackRate 微調整サーボに置換（S1 直撃）

映像先行/遅れを **`video.playbackRate` の ±2〜4%（0.96〜1.04）の連続調整**で吸収する。実プレイヤー（ブラウザ・ffplay 等の A/V sync）の標準手法。

- 誤差（Idea 2 の presented-frame error）に比例したレート補正（P 制御 + 少しの積分でよい）。**pause も seek も発生しない**ため H1 のリミットサイクルが構造的に消える。
- ±4% 程度なら映像の速度変化は知覚困難。音声も `preservesPitch`（既定 true）でピッチ維持。
- `holdTimeline` / `pauseVideo` は撤去せず、**サーボの補正上限を超える大誤差（例: >5f）の failsafe に格下げ**する。decode が実時間に届かない機ではこれまでどおり hold が働く（decode 律速に sync で勝とうとしない、の教訓は維持）。
- 変更範囲: `computePlaybackSyncState` を「状態→レート」の純関数に拡張 + `syncVideoElementTime` playbackMode で rate を適用。INV-1 非該当（レンダリング解決値は不変）。

### Idea 4 — media-master クロック反転（S1 の恒久解・中期）

comp33 型（支配的な video が 1 本以上再生中）のとき、**タイムライン frame を rAF ではなく primary video の presented mediaTime から導出する**（`frame = round(mediaTime × fps) + offset`）。

- 「video をタイムラインに従わせる」制御問題そのものを消す。video は自分自身とはドリフトできない。transform / expression / DOM レイヤーは軽いので video に追従させるだけでよい。
- `PreviewAudioClock`（音声レイヤー時は AudioContext がマスター）という**前例が既にある**。クロック供給源の抽象は同じ形にできる。
- 複数 video 混在時は「最長スパンの primary」をマスターに選び、残りは Idea 3 のレートサーボでマスターへ寄せる（タイムラインへではなく**マスター video へ**同期させる = ズレの基準が 1 本になる）。
- 課題: マスター切替（クリップ out 点通過・ループ wrap）時の offset 付け替え、video が無い区間の rAF フォールバック。Idea 1〜3 より設計が重いので第 2 波。

### Idea 5 — packed / proxy 再エンコードの GOP 短縮（S2/スクラブ全般の底上げ）

`convertSplitAssetToPacked` / proxy 生成の `VideoEncoder` 設定に**キーフレーム間隔の明示指定（例: 0.5〜1 秒ごと、可能ならループ想定の先頭強制キーフレーム）**を加える。

- wrap seek・スクラブ seek の前方デコード距離が短くなり、Idea 1 が失敗した場合（プール枯渇等）のフォールバックも速くなる。
- コスト: ファイルサイズ微増（preview 用 proxy なので許容）。エンコード経路は preview 資産のみ・export 原本には触れない。

### Idea 6（オプション）— packed 合成の rVFC 駆動化

現状 packed の canvas 合成はタイムライン renderFrame 時にのみ走る。これを **video 自身の rVFC（新フレーム present 時）でも合成**すれば、タイムライン tick が React effect 等で遅れても canvas は常に最新デコード済みフレームを映す。Idea 4（video マスター）と組むと「packed 人物が背景に対して古い」状況が原理的に消える。`schedulePackedAlphaRedrawWhenReady`（[videoPackedAlpha.ts:170](../src/runtime/videoPackedAlpha.ts#L170)）が既に rAF リトライ機構を持つので拡張は小さい。

---

## 5. やらないこと（失敗事例からの制約）

| 禁じ手 | 理由 |
|--------|------|
| `VideoDecoder` 明示デコードへの再挑戦 | 実ピクセル計測で 85% フリーズ（report.md）。`failed/packed-videodecoder-preview` に保存済み |
| THREE/WebGL シーンに video を入れる（v1） | 失敗済み（[[alpha-video-perf-decode-bound]]） |
| 「デコード待ち」をタイムライン停止に変換して精度を買う設計 | ズレをもたつきに付け替えるだけ（report.md の同期修正 (B)(C) の教訓）。hold は failsafe に限定する |
| 内部カウンタ差分だけでの緑判定 | 測定妥当性の欠陥そのもの。受け入れは §6 の実ピクセル方式のみ |
| 再生中の小ドリフトを seek で矯正 | 旧 HW の自己増殖 seek ループ（[videoElementSync.ts:204-210](../src/runtime/videoElementSync.ts#L204-L210) コメント）に逆戻り |

---

## 6. 計測・受け入れ基準（report.md 方式を正とする）

計測ハーネスは [doc/issue/fucked-up-preview/capture-comp32-preview.mjs](issue/fucked-up-preview/capture-comp32-preview.mjs) を流用・拡張する（実 Chrome headed + CDP screencast + ffmpeg `freezedetect`、実測 ~47fps サンプリング）。

**追加すべき計測**（今回の症状は既存 8 秒計測では捉えきれない）:

1. **長時間ドリフト**: 30 秒以上の連続再生で、desync（subject vs 背景、および映像 vs タイムラインオーバーレイ）の**時系列トレンド**を取る。2〜4 秒以降の発振（周期・振幅）を可視化する。
2. **ループ wrap の per-wrap 分類計装（S3 の判別因子確定・最優先）**: loop ON で折り返しを **10 回以上**跨ぎ、**wrap 1 回ごと**に次を記録して「スムーズ wrap」と「もたつき wrap」を分類する:
   - 視覚フリーズ長（freezedetect、wrap 時刻 ±1s 窓）
   - キャッシュオーバーレイ表示中だったか（`shouldPreferCacheOverlay` の実値・`useCachedFrame`・bake progress）
   - 各 primary video の `buffered` レンジが loopStart ソース時刻を含んでいたか / `readyState` / seek 発行の有無と `seeking` 継続時間
   - wrap 瞬間のゲート状態（`holdTimeline` / `pauseVideo`）
   - loopStart のソース時刻（trim）と直前キーフレームからの距離（取得可能なら）
   → **判別因子が 1 変数で分離できたら、それを固定して「常にスムーズ」「常にもたつく」を意図的に再現できることを確認する**（ユーザー提案の「この状況を再現できるようにする」）。再現できて初めて修正着手。
3. **被験データ**: Downloads 最新プロジェクトの **Comp33**（ユーザーの実症状の再現体）を mini-project 化して使う。

**受け入れ目標（案）**:

| 指標 | 目標 |
|------|------|
| 視覚フリーズ率（30 秒再生） | ≤ 10%（baseline `3bd1f3c` の 5〜10% を悪化させない） |
| desync p95（30 秒・presented frame 基準） | ≤ 1.5 frame、かつ発振（±2f 超の往復）が視認されない |
| ループ wrap の視覚フリーズ | ≤ 150ms／回（現状は体感で数百 ms〜） |
| 既存回帰 | `verify-*-export*` 系 PASS 維持・`npm test` の export/raster/bundle 緑・INV-2（scrub/export 経路は本変更で不変） |

---

## 7. フェーズ分け提案

> **実装分担（2026-07-08 決定）**: Phase 0 は Claude Code + Sonnet 5 サブエージェント、Phase 1 以降（実装）は Codex が担当する。Codex 向けの厳格な実行プラン（WP 分割・決定ゲート・禁止事項・DoD）は [doc/preview-improvement-plan-v2-for-codex.md](preview-improvement-plan-v2-for-codex.md) が正本。Phase 0 の成果物は `doc/issue/preview-loop-wrap/decision-record.md`（スキーマは Codex プラン §3）で、これが `status: FINAL` になるまで Codex は着手しない。

| Phase | 内容 | 対応症状 | リスク |
|-------|------|----------|--------|
| 0 | 計測拡張（30s ドリフト時系列 + **per-wrap 分類計装で S3 判別因子を確定 → スムーズ/もたつき両状態を意図的に再現**、Comp33 fixture 化）→ ベースライン数値確定 | S3→S2 | なし |
| 0.5 | H5 の判別因子に応じた**最安修正**（例: 判別因子がキャッシュオーバーレイなら「video コンプでも bake を確実に完了させ再生をキャッシュに乗せる」／buffered なら wrap 直前の先行バッファ確保）。これで S2 が受け入れ目標に達したら Phase 1 は保留 | S2 | 低 |
| 1 | Idea 1: ループ折り返しダブルバッファ（Phase 0.5 で不足した場合の live 経路の恒久解） | S2 | 低 |
| 2 | Idea 2 + 3: rVFC presented-frame 計測 + playbackRate サーボ（hold/pause は failsafe 化） | S1 | 中（純関数テストで固定しやすい） |
| 3 | Idea 5: packed/proxy GOP 短縮 | S2 補強 | 低 |
| 4 | Idea 4 (+6): media-master クロック反転・packed rVFC 合成 | S1 恒久解 | 中〜高（第 2 波・Phase 2 の結果を見て判断） |

各 Phase の完了判定は **Phase 0 のハーネス再計測**で行う（内部カウンタでの緑判定禁止）。Phase 2 まででユーザー体感が受け入れ目標に達すれば Phase 4 は保留してよい。

**影響経路の宣言（implementation-loop Phase 2 相当）**: 本プランはすべて **preview 再生（playbackMode）専用**。export 決定論 seek（`exportStep`）・scrub・bundle player の export 側・INV-2 の scene 解決値には触れない。bundle player は `previewPlaybackLoop.ts` / `playbackVideoSync.ts` を共有するため、Phase 1〜2 のあとは **`npm run build:player` 必須** + §11.7 autoplay 検証を回すこと。
