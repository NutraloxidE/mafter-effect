# Fix plan v2-plus: 音声/動画の内部分離でループ継ぎ目クリックを消す

> **この文書は Sonnet 5 に丸投げして実行できる自己完結プランである。** 実装担当エージェントは、まず
> 「参照すべき前提」を全部読んでから Phase 0 に入ること。**実ブラウザ計測を通すまで「直った」と宣言しない。**

- ブランチ: `fix/bundle-loop-audio-replan`（現 HEAD = `c903ab0`）。この上に積む。
- スコープ: **video 内蔵音声のみ・bundle 経路のみ**（standalone audio / export / editor preview は挙動を変えない）。
- 実装者: Sonnet 5（丸投げ可）。判断に迷う分岐は本文の「STOP して確認」に従う。

---

## ⚠️ 実装結果（2026-07-10・実 Chromium 計測）— 分離だけでは不十分と判明

**配線は成功したが、継ぎ目クリックは消えなかった。** 実装（Phase 1〜3）を Sonnet 5 が完了し、Claude が実ブラウザで計測した結果:

- **配線は正しい**（実機で確認）: 表示 `<video>` は `muted=true` で再生、別 `<audio>` 要素（同素材・detached）が `muted=false` で再生、**二重音声なし**。`persistentlyMutedVideoIds` 機構が機能。trimStart/inPoint 反映（report.md 副次発見）と `clampFadeWindowToLoopRange`（ループ境界を declick 窓にクランプ）も入った。
- **しかしクリックは残った**（`verify-loop-seam-click.mjs` の実音声 wrap 計測）:

  | 版 | wrapPeakDelta | 備考 |
  |---|---:|---|
  | 無修正 | ~0.10 | 元のクリック |
  | c903ab0（gain 分離・最小） | ~0.05 | |
  | v2-plus（分離のみ） | ~0.13 | 悪化 |
  | v2-plus + seek 時 volume=0 | 0.07〜0.16（run ばらつき大） | **不安定** |

- **原因（確定）**: 分離した `<audio>` 要素も、継ぎ目で `el.currentTime=0` の**ハード seek** を行い、declick を **`el.volume`** で掛けている。継ぎ目付近の実測 volume は seek 直前で **0.80 までしか下がらず**（tick が wrap 検出時に applyGains を通らない＋`el.volume` に**出力レイテンシがあり sample 精度で当たらない**）、seek の波形不連続が可聴 gain で通過する。**これは postmortem と同じ「HTMLMediaElement.volume は sample 精度の declick に使えない」限界**であり、音声を別要素に分離しても declick 手段が `el.volume` のままなら解決しない。
- run ごとに 0.07〜0.16 とばらつく＝**確実に消せない**ため、受け入れ基準（ノイズが消えたらパス）を**満たさない**。マージ見送り。

### 次にやるべきこと（ユーザー判断待ち）

分離アーキテクチャ自体は正しい土台。**真に消すには sample 精度の declick が要る**。選択肢:

1. **分離 `<audio>` を Web Audio の fadeGain（AudioParam automation）に通す**（推奨候補）。postmortem の失敗は「**タップした video 要素を muted にしてグラフごと無音化**」した事故であって、fadeGain 概念自体ではない。今回は **video に触れず、専用の `<audio>` 要素だけを graph に通し muted にしない**ため、postmortem の罠に当たらない。seek 前に fadeGain を 0 へ sample 精度でランプ→seek→戻す。ユーザーは Web Audio を避けたい意向だったので**要確認**。
2. **デコード済みバッファの gapless ループ**（AudioBufferSourceNode + loop points + crossfade）。最も綺麗だが重い。
3. **継ぎ目の短いハードミュート窓**（~40ms）。crude だが `el.volume` レイテンシに勝てるかは要計測。

現状の v2-plus コミットは **調査成果（配線・trimStart 修正・計測）として保存**。クリック解消は上記いずれかの追加実装が必要。

---

## 参照すべき前提（実装前に必読）

1. [`report.md`](report.md) — 一次調査。継ぎ目の生の不連続とコード経路。
2. [`postmortem-web-audio-attempt.md`](postmortem-web-audio-attempt.md) — **Web Audio graph 方式は中止済み。二度とやらない**（後述の禁止事項）。
3. [`fix-plan-v2-minimal.md`](fix-plan-v2-minimal.md) — 直前の最小修正（c903ab0）。gain だけ描画ゲートから分離したが seek は分離できず、クリックは約58%減で ~0.05 残留。その「残留の正体」を本プランで消す。
4. [`verify-loop-seam-click.mjs`](verify-loop-seam-click.mjs) — **実 Chromium + 実音声キャプチャの回帰ゲート**。これが本プランの合否判定器。

---

## ユーザーの発見（このプランの出発点）

> **「音声と動画を内部処理で分離させて別レイヤーとして動作させたら、クリック音が無くなった。」**

実機で、動画内蔵音声を別音声レイヤーとして鳴らす（＝動画はミュートし、同じ素材の音声を別経路で再生する）とクリックが消えることを確認済み。

## なぜ分離で消えるのか（メカニズム確定）

`BundleAudioClock`（[src/player/BundleAudioClock.ts](../../../src/player/BundleAudioClock.ts)）は standalone `audio` レイヤーを鳴らす軽量クロック。核心は:

- フレーム進行を **wall-clock（`performance.now`）で駆動**（[L252](../../../src/player/BundleAudioClock.ts#L252)）。`<audio>` 要素の `currentTime` には依存しない。
- ループ継ぎ目の **seek（`el.currentTime = 0; el.play()`）と declick gain（`applyGains` の autoFade）を、どちらも毎フレーム走る軽量 tick 内で実行**（[L255-297](../../../src/player/BundleAudioClock.ts#L255-L297)）。renderGate に間引かれない。

対して動画内蔵音声は、**seek が重い `DomRenderer.renderFrame`（renderGate で間引かれる）の中でしか起きない**。c903ab0 は gain フェードだけを毎フレーム化できたが、**実 seek は依然ゲートに縛られて遅延**する。フェード(0 到達)と seek のタイミングがズレる → 継ぎ目に非ゼロ出力が残る → クリック（~0.05）。

**結論:** 音声を動画から切り離し、`BundleAudioClock` の「seek も fade も軽量 tick 内で同時に行う」経路に載せれば、タイミングのズレが消え、クリックが消える。動画側は映像専用（常時ミュート）にする。

---

## アプローチ

**bundle 再生時、video 内蔵音声を別の `<audio>` 要素として `BundleAudioClock` に載せ、`<video>` は常時ミュート（映像のみ）にする。全 footage 音声（standalone + video 内蔵）を単一の軽量クロックが所有する。**

- `<audio src="footage.mp4">` は mp4/webm の音声トラックだけをデコードして鳴らせる（映像は無視）。動画デコーダ（映像用・muted）と音声要素は別々に走る（二重デコードだが音声デコードは軽い）。
- A/V 同期は既存 §11.4 双方向同期をそのまま使う（`BundleAudioClock` が master、video が追従）。`hasAudio` 分岐（[BundlePlayer.ts L145-](../../../src/player/BundlePlayer.ts#L145)）で既に配線済みの `getVideoClockSamples` / `setPlaybackRateForSync` / `setPlaybackPauseForSync` を流用する。
- autoplay: 最初のジェスチャで `audioClock.unlock()`（既存）。**video はミュートのままにする**（ミュート動画は autoplay 可、音は別要素の clock 側で解禁）。

### なぜ postmortem の失敗を繰り返さないか

前回は同一 `<video>` 要素を `MediaElementAudioSourceNode` で Web Audio グラフにタップし、要素を muted にしてグラフごと無音化する事故を起こした。**本プランはグラフを一切使わない。** 別個の native `<audio>` 要素で鳴らすだけなので、`<video>` を muted にしても音声（別要素）は無音化されない。構造的に前回の罠に当たらない。

---

## 禁止事項（HARD・破ったら STOP）

1. **Web Audio graph / `AudioContext` / `MediaElementAudioSourceNode` を使わない。** 音声は native `<audio>` 要素のみ（postmortem の失敗原因）。
2. **`hasAudioLayers`（[BundleAudioClock.ts L326](../../../src/player/BundleAudioClock.ts#L326)）のセマンティクスを変えない。** これは **editor preview（[PreviewPanel.tsx L681](../../../src/editor/panels/PreviewPanel.tsx#L681)）でも使われている**。video 内蔵音声の検出は **bundle 専用の新関数**で行い、既存関数の戻り値を変えない。
3. **export（`exporter.ts`）と editor preview（`previewAudioClock.ts` / `PreviewPanel.tsx`）の挙動を変えない。** 本修正は bundle 再生経路のみ。
4. **§5 スキーマ / INV / `project.json` 形式を変えない。** これは runtime 再生時の音声分離であって、プロジェクトデータ構造の変更ではない（別レイヤーを project に追加するのではなく、再生時に音声ソースを合成する）。必要になったら STOP して確認。
5. **fake AudioParam / unit / typecheck / build のグリーンだけで「直った」と宣言しない。** 実 Chromium の音波形キャプチャ（`verify-loop-seam-click.mjs`）で継ぎ目残留が閾値以下になったことを示すこと。

---

## 重さ（perf）の評価と分岐

「video をミュートして別 `<audio>` を足す」ことの重さは、次のように分解できる。

| 要素 | コスト | 補足 |
|---|---|---|
| `video.muted = true` 自体 | ほぼ0 | フレームデコード量は不変。ミュートで動画の音声トラック decode を省くかはブラウザ依存（保証なし） |
| 別 `<audio src=同じ素材>` 1個 | **AAC decode 1本（軽い）** | bundle は blob URL 済み＝再フェッチ無し。再 demux + AAC decode のみ（概ね CPU 1〜2%） |
| 二重音声 decode の無駄 | 小 | muted video が自トラックも decode し続けると同じ音声を2回 decode しうる |
| メモリ | 小 | bytes は RAM 済み、デコード済み音声バッファは小 |

**判断の芯:** 弱いマシンで重いのは**映像 decode（H.264/VP9）**で、これは video 要素数が変わらない本修正では**増えない**。増えるのは軽い音声 decode 1本のみ（[[alpha-video-perf-decode-bound]] / old-hardware stutter もボトルネックは映像側）。**音声付き動画1枚（Comp 10）なら体感差はほぼ無い見込み。** 効くとしたら「音声付き動画レイヤーが多数」で音声デコーダが N 本になる場合。

### 単純版 → 計測 → 必要なら escalate（計測駆動）

1. **まず単純版**（ミュート video + 別 `<audio>`）を実装する。
2. **Phase 4 で decode/stutter を実測**する。`verify-loop-seam-click.mjs` の CPU throttle を使い、分離前後で「フレーム進行の安定度・映像 stutter・decode lag」を比較（既存の再生計測ハーネス手法＝rAF ループで `{currentFrame, video.currentTime, readyState}` を積む、を流用してよい）。判定は絶対値でなく**分離前後の差**で見る。
3. **有意に重くなった場合のみ** escalate: **export 時に音声を別ファイルへ demux 分離**（video ストリーム＝映像のみ／小さな audio-only `.m4a`/`.opus` を別 `<audio>` で再生）。二重 decode を完全に消せるが、export の muxer 機構追加で複雑化するため、計測が要求するまでやらない。

> つまり「video ミュートの重さ」は先に単純版で作って**実測で分岐**する。重くない限り分離 export はやらない（YAGNI）。この perf 実測も Phase 4 の完了条件に含める。

---

## Phase 0 — 仮説の実ブラウザ再確認（コード変更なし・基準取り）

**目的:** 「動画をミュートして同素材の別 audio 要素で鳴らすとクリックが消える」を、本リポの実 Chromium ハーネスで数値化する。直す前に「分離すれば消える」ことを自分の計測で確認しておく。

1. dev サーバを 1 本だけ起動（stale vite に注意。`Get-CimInstance ... vite` で確認→全 kill→1本→ポート確定）。https://localhost:5173。
2. フィクスチャ: `verify-loop-seam-click.mjs` が使う H.264+AAC ループ継ぎ目動画（ffmpeg 生成。`TEMP/.../scratchpad/loopseam_h264_aac.mp4`）。無ければ同スクリプト冒頭コメントの手順で再生成。
3. **手動分離テスト**: ハーネスを一時改変 or 別スクリプトで、「video レイヤー＋同素材の standalone audio レイヤーを載せ、video をミュート」した bundle を作り、`verify-loop-seam-click.mjs` の計測ロジック（wrap 検出 + サンプル間 delta）で継ぎ目クリックを測る。standalone audio 経由なら `wrapPeakDelta` が現状の video 内蔵（before ~0.10 / after-minimal ~0.05）より有意に小さい（背景 ~0.002 レベルに近い）ことを確認。
4. 結果を本文書「実装結果」節に追記。**もし分離しても消えないなら STOP**（前提が崩れる＝設計やり直し。ユーザーに報告）。

> Phase 0 は「直す前の証拠」。ここを飛ばして実装に入らない。

---

## Phase 1 — bundle 専用: video 内蔵音声の検出（純関数）

- **Allowed:** 新規 `src/player/bundleFootageAudio.ts`（or 既存 `footageAudio.ts` に bundle 専用 export を足す）、対応する新規 test。
- **Forbidden:** `hasAudioLayers` の変更、`collectFootageAudioSources` のシグネチャ変更、editor/export ファイル。
- **内容:**
  - `collectFootageAudioSources(comp)`（[footageAudio.ts L58](../../../src/runtime/footageAudio.ts#L58)）は **既に video コンポーネントも列挙している**（`componentType: "audio" | "video"`）。これを土台に、bundle 用の音声ソース列挙関数を作る（assetId→assetPath 解決、autoFade / suppression 付与。既存 `collectAudioLayers`（[BundleAudioClock.ts L300](../../../src/player/BundleAudioClock.ts#L300)）の video 版拡張でよい）。
  - **音声トラック有無の判定**: video 素材に音声が無い場合に無駄に master 経路へ切り替えないため、可能なら `asset.meta` の音声情報で絞る。判定手段が無ければ「video は常に音声ソース候補」とし、無音 `<audio>` は害が無い（`BundleAudioClock` は wall-clock 駆動なので無音要素でもタイミングは壊れない）ことを test コメントに明記。**meta のどこに音声有無があるか不明なら Phase 0 の調査で確定してから決める。**
  - 純関数として unit test（video のみ / audio のみ / 混在 / trimStart 付き / 無効レイヤー除外）。

## Phase 2 — BundleAudioClock に video 内蔵音声ソースを載せる

- **Allowed:** `src/player/BundleAudioClock.ts`、対応 test（`test/bundleAudioClock.test.ts` 拡張は既存期待値を壊さない範囲で追加のみ）。
- **Forbidden:** wall-clock 駆動の基本構造・§11.4 hold ロジックの作り替え。既存 standalone audio の挙動回帰。
- **内容:**
  - `prepare` / `collectAudioLayers` を拡張し、Phase 1 の列挙で video 内蔵音声ソースにも `<audio>` 要素を作る。**objectId は video レイヤーの obj.id を使う**（DomRenderer の video 要素とは別 Map なので衝突しない）。
  - `inPoint` / `outPoint` / `trimStart` を正しく反映（report.md「副次的な発見」: 現状 standalone audio でも `trimStart`/`outPoint` を無視している。video 内蔵音声は trimStart を持つのでここで正す）。継ぎ目の `currentTime` リセット先は `(loopStart - inPoint + trimStart)/fps` 相当。**この時刻マッピングは純関数に切り出して unit test で固定**（fix-plan-v2 の `resolveVideoGainForFrame` と同じ思想。既存の `computeLayerMediaTime` があれば流用）。
  - declick（`applyGains` の autoFade）は既存経路のまま video 内蔵ソースにも効く。

## Phase 3 — BundlePlayer 配線: video 常時ミュート + master 経路切替

- **Allowed:** `src/player/BundlePlayer.ts`、（video ミュート永続化のため）`src/runtime/DomRenderer.ts` / `src/runtime/videoElementSync.ts` に **bundle 専用のミュート維持フラグ**を最小追加。
- **Forbidden:** export / editor の video ミュート挙動変更。gesture-unmute を全 video で一律廃止（standalone audio 非関与の既存 bundle 挙動を壊さない）。
- **内容:**
  - bundle 専用検出（Phase 1）で footage 音声（standalone + video 内蔵）が有る場合、`BundleAudioClock` master 経路を使う（現 `hasAudio` 分岐を bundle 専用検出に差し替え。**`hasAudioLayers` 自体は変えない**——呼び出し側で新関数を使う）。
  - **video 内蔵音声を抽出した video 要素は常時ミュート**にする。`installAutoplayUnlock`（[BundlePlayer.ts L199](../../../src/player/BundlePlayer.ts#L199)）の gesture ハンドラで、**video の unmute（`muteVideoPlayback:false`）をしない**（抽出済みなら音は clock 側）。gesture では `audioClock.unlock()` のみ行う。
  - 「抽出済み video は永続ミュート」を DomRenderer/videoElementSync に伝えるフラグは、postmortem の `externalAudioGain` とは**役割が違う**ことをコメントで明記（あちらは Web Audio グラフ前提の誤設計。こちらは単に「音は別 `<audio>` 要素なので video は映像専用」）。
  - c903ab0 の `applyAudioForFrame`（video.volume を毎フレーム書く）は、抽出済み（ミュート）video に対しては無害な no-op になる。**削除は必須ではない**（残しても害なし）。混乱を避けたければ Phase 4 後に別コミットで整理してよいが、本修正の完了条件には含めない。

## Phase 4 — 検証（実ブラウザ必須）+ build + 記録

1. **実ブラウザ回帰ゲート（主）:** `verify-loop-seam-click.mjs` を CPU throttle 有/無で実行し、**継ぎ目 `wrapPeakDelta` が背景（~0.002）に近いレベルまで下がる**ことを before（c903ab0）と比較して示す。throttle 有無で結果が一致すること（skip 依存が消えたこと）も確認。
2. **A/V 同期の目視/計測:** 分離した音声と muted video がズレないこと（wrap 後も currentTime が破綻しない）。ハーネスの `videoCurrentTime` 系列で確認。
3. **二重音声が無いこと:** video がミュートで、音は `<audio>` 側のみから出ている（実音声キャプチャで単一ソース）。
4. **perf 実測（重さの分岐判定）:** CPU throttle 下で分離前後のフレーム進行安定度・映像 stutter・decode lag を比較（上の「重さの評価と分岐」参照）。有意に重ければ export 音声分離へ escalate、そうでなければ単純版で完了。**「重くない」を計測で示すこと。**
5. **回帰:** `npm run typecheck` / `npx vitest run`（既存 1043 + 追加）/ **`npm run build:player`**（src/player・src/runtime を触るので必須）/ `playerBuildFreshness`。
6. **既存 export/preview 無回帰:** 既存の video/audio 関連 verify が該当すれば実行。editor preview の audio 経路が変わっていないこと（`hasAudioLayers` 未変更）。
7. 結果を本文書に追記し、`progress.md` を更新。
8. **最終判定はユーザーの耳**: Comp 10 を実機再生してクリックが消えたか確認してもらう（自己宣言しない）。

---

## 実装順（小さく・検証しながら）

```
Phase 0  実ブラウザで「分離すれば消える」を数値化（コード変更なし）    ← 最初にこれ
Phase 1  bundle 専用の video 内蔵音声検出（純関数 + test）
Phase 2  BundleAudioClock に video 内蔵音声ソースを追加（+ 時刻マッピング純関数 test）
Phase 3  BundlePlayer 配線（master 切替 + video 永続ミュート）
Phase 4  実ブラウザ計測（前後比較）+ build:player + progress 更新
```

各 Phase 後に `verify-loop-seam-click.mjs` か unit で確認してから次へ。**Phase 3 完了時点で必ず実ブラウザ計測**（unit だけで先に進まない）。

---

## STOP して確認する条件

- Phase 0 で分離しても継ぎ目クリックが消えない（前提が崩れる）。
- video 音声トラック有無の判定手段が `asset.meta` 等に見当たらず、全 video 抽出の副作用（無音 video での master 経路切替）が無視できないと判断した場合。
- §5 スキーマ / INV / `project.json` 形式に触れないと実装できないと判明した場合。
- A/V 同期が実機で明確にズレ、既存 §11.4 machinery で吸収できない場合。
- perf 実測で分離が有意に重い（映像 stutter / decode lag が悪化）と出た場合 → 単純版のまま進めず、export 音声分離 escalate の要否をユーザーに確認。
- 既存の standalone audio bundle / export / editor preview に回帰が出た場合。

---

## 成果物チェックリスト（完了条件）

```
- [ ] Phase 0 の実ブラウザ基準（分離で消える）を数値で記録
- [ ] bundle 専用検出は新関数（hasAudioLayers 未変更）
- [ ] video 内蔵音声が別 <audio> 要素として BundleAudioClock に載る
- [ ] 時刻マッピング（inPoint/outPoint/trimStart）が純関数 + test で固定
- [ ] 抽出済み video は常時ミュート（gesture でも unmute しない）
- [ ] Web Audio graph / MediaElementAudioSourceNode を一切使っていない
- [ ] 実 Chromium 計測で継ぎ目 wrapPeakDelta が背景レベル近くまで低下（前後比較）
- [ ] throttle 有/無で結果が一致（skip 依存の消滅）
- [ ] 二重音声なし・A/V 同期 OK
- [ ] perf 実測で「分離前後で有意に重くない」ことを確認（重ければ export 音声分離へ escalate 判断）
- [ ] typecheck / vitest / build:player / playerBuildFreshness 緑
- [ ] export・editor preview 無回帰（hasAudioLayers 未変更）
- [ ] progress.md 更新・ユーザー実機試聴の handoff
```
