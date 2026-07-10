# Fix plan v2（最小修正）: bundle ループ継ぎ目クリック

- 前提: [`postmortem-web-audio-attempt.md`](postmortem-web-audio-attempt.md) で Web Audio 方式は中止。
- ベース: `f0a4064`（ブランチ `fix/bundle-loop-audio-replan`）。
- 実装者: **Claude（私）が直接実装**（Codex には投げない）。
- 確定した方針（ユーザー回答）:
  - アプローチ = **最小修正から**（効かなければ escalate）
  - スコープ = **video 内蔵音声だけ**（standalone audio の inPoint/trimStart 修正は別 issue）
  - 受け入れ = **自動計測（継ぎ目不連続の数値ゲート）＋ あなたの耳（Comp 10 実機）**

---

## 根本原因（report.md 再掲・ベースで再確認済み）

- ソース動画は 3.733s の切り位置がループ安全でない（末尾サンプル非ゼロ→先頭ゼロ）。
- 既存 declick（`footageAutoFade` 120ms）は `resolve()`→`video.volume` で out/in フェードを掛ける設計。
- しかし `video.volume` の書き込みは **gate された `DomRenderer.renderFrame` の内側だけ**で起きる（[previewPlaybackLoop.ts:70](../../../src/runtime/previewPlaybackLoop.ts#L70) の renderGate）。
- 適応フレームスキップが効くと、継ぎ目直前の out-fade フレーム（108〜111）の volume 書き込みが落ち、seek 時点で非ゼロ出力のまま → クリック。

**要するに:** フェード計算は正しいのに、フェードの「適用（volume 書き込み）」が描画 cadence に縛られて継ぎ目で抜ける。

---

## 修正方針（第1案・継続性維持）: 音声適用を描画ゲートから分離

**「重い視覚描画」だけを gate し、「軽い音声 gain 適用」は毎フレーム必ず行う。** 既存の 120ms autoFade をそのまま使うので、継ぎ目は連続フェード（無音ギャップを作らない）。

### 変更点（最小・bundle 経路のみ）

1. **`DomRenderer`** に軽量な音声専用適用メソッドを追加（新規・描画しない）。
   - 例: `applyAudioForFrame(scene | frame)` — resolve 済み video の `gain × autoFadeMultiplier` を各 `<video>.volume` に書き、再生/ミュート状態だけ同期する。DOM レイアウト・raster・matrix 更新は**しない**。
   - 既存 `renderFrame` の volume 書き込みロジックを共有し、二重管理にしない。

2. **`previewPlaybackLoop.ts`** に `onFrameAudio?: (frame) => void`（optional）を追加。
   - `advance > 0` の毎フレーム（wrap 計算後の `currentFrame` 確定時）に、renderGate に関係なく呼ぶ。
   - **未指定なら従来と完全一致**（editor preview はこのループを共有するので無指定＝無影響）。

3. **`BundlePlayer.play()`**（no-audio 経路 = Comp 10）で `onFrameAudio: (f) => this.renderer.applyAudioForFrame(f)` を配線。
   - 視覚 `renderFrame` は従来どおり renderGate 下。音声だけ毎フレーム適用。

### なぜこれが最小か

- 新規モジュール・新 AudioContext・状態機械ゼロ。既存 `footageAutoFade` / `resolve` / `video.volume` をそのまま使う。
- 変更は「適用タイミングの分離」だけ。フェード形状・declick 判定・INV は不変。
- editor preview / export 経路は touch しない（optional 配線で bundle だけ）。

---

## フォールバック（第1案で継ぎ目クリックが消えなければ）: 継ぎ目ミュート窓

resolve+volume の毎フレーム適用でも取り切れない場合のみ:

- ループ wrap（`next >= loopEnd`）で `onLoopBoundary` を発火し、seek をまたいで `<video>` を**短時間ハードミュート**（例 40〜80ms）してから復帰。
- native mute は WebAudio と違い確実に無音化でき、クリックを決定的に消す。
- コストは継ぎ目ごとの極短い無音ギャップ（通常不可聴）。第1案が継続性で勝るので、あくまで保険。

---

## 非目標（今回やらない）

- Web Audio graph / MediaElementAudioSourceNode（中止済み）。
- standalone `audio` レイヤーの inPoint/outPoint/trimStart 対応（別 issue）。
- export / editor preview の音声経路変更。
- フェード長・declick 抑制判定の変更。

---

## 受け入れ・検証

> **鉄則（postmortem の最大の教訓）: 「直った」の判定は必ず実ブラウザ＋実キャプチャで行う。**
> 前回は typecheck・unit（fake AudioParam）・build が全部グリーンなのに実際の書き出しは完全無音だった。
> 音声・autoplay・WebAudio・video 再生に触る変更は、**ヘッドレスの内部カウンタや fake ノードでは真偽が出ない**。
> よって本 issue の完了条件は、下記いずれも **実 Chromium（`playwright` の実ブラウザ）で、実際に鳴っている音波形をキャプチャして計測**することを必須とする。fake AudioParam / モック / unit テストだけで PASS を宣言してはならない。

1. **実ブラウザ＋実音声キャプチャ（主・回帰ゲート）:**
   - **駆動:** 実 Chromium で、**再ビルドした `public/player.js` を埋め込んだ本物の HTML bundle** を Range 対応 HTTP サーバで配信し、ユーザー操作（クリック）で autoplay を unlock する（postmortem の教訓：`route.fulfill` は Range 非対応で `<video>` がロード不能／実 HTTP Range サーバ必須）。
   - **キャプチャ:** プレイヤー自身の `AudioContext` を `AudioNode.prototype.connect` フックで **AnalyserNode にタップし、実際に destination へ流れている音波形（time-domain）を取得**する。内部の gain 値やフラグの読み取りではなく、**鳴っている音そのもの**を計測する。
   - **測る対象:** 単一トーンではなく **ループ継ぎ目を持つフィクスチャ**で、seek をまたぐ継ぎ目区間の残留エネルギー（不連続）を計測し、「フェード適用済み＝閾値以下」を assert。修正前は継ぎ目残留が閾値超（＝クリック有）、修正後は閾値以下（＝クリック消）を **前後比較**で示す。
   - **コーデック/フィクスチャの注意:** Playwright Chromium は HEVC 非対応・空 mp4 は再生不可。**H.264+AAC の実音声入り**フィクスチャを ffmpeg で生成して使う。export 前に `saveToFs()` フラッシュ必須。
   - 既存 `verify-loop-audio-seam.mjs`（ソース境界差分の事実計測）は補助として維持。
2. **純関数/ループ挙動テスト（補助・単独では完了条件にしない）:** autoFade 適用が renderGate 抑制フレームでも毎フレーム呼ばれることを、`onFrameAudio` 発火回数で固定。ただしこれは実ブラウザ計測の代替にはならない。
3. **あなたの耳（最終判定）:** Comp 10 を**実機で再生**し、ループ継ぎ目のクリックが消えたか耳で最終確認。
4. `npm run typecheck` / focused test / `npm test` / **`npm run build:player`** / `playerBuildFreshness`（これらは前提条件であって、単独では「直った」の証明にならない）。

---

## 実装順（小さく・検証しながら）

1. **実ブラウザ計測ハーネスとフィクスチャを先に用意**（直す前に「クリックがある」を実 Chromium の音波形キャプチャで数値化）。ループ継ぎ目を持つ H.264+AAC フィクスチャ＋継ぎ目残留エネルギー計測。**この基準取りも実ブラウザで行う**（unit では基準にならない）。
2. 第1案を実装（DomRenderer 音声適用分離 → loop 配線 → BundlePlayer）。
3. **実ブラウザ計測**で継ぎ目残留が閾値以下になるか確認（前後比較）。ダメならフォールバック（ミュート窓）へ。
4. `build:player` → 実機であなたが試聴 → progress 更新。

> どの段階でも「PASS」を名乗る前に、実 Chromium で鳴っている音をキャプチャした計測を通すこと。unit/typecheck/build のグリーンは前提条件にすぎない。
