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

1. **自動計測（回帰ゲート）:**
   - `verify-loop-audio-seam.mjs`（既存・ソース境界差分の事実計測）を維持。
   - 実クローム音声ハーネス（postmortem 参照の Range サーバ + AnalyserNode）を **継ぎ目区間の残留エネルギー計測**に拡張し、seek 前後で「フェード適用済み＝閾値以下」を assert。単一トーンではなく**ループ継ぎ目を持つ**フィクスチャで測る。
2. **純関数テスト:** autoFade 適用が毎フレーム呼ばれることを、ループの `onFrameAudio` 発火回数（renderGate が render を抑制するフレームでも呼ばれる）で固定。
3. **あなたの耳:** Comp 10 を実機再生し、ループ継ぎ目のクリックが消えたか最終判定。
4. `npm run typecheck` / focused test / `npm test` / **`npm run build:player`** / `playerBuildFreshness`。

---

## 実装順（小さく・検証しながら）

1. seam 計測フィクスチャ（ループ継ぎ目を持つ H.264+AAC）と計測プロキシを先に用意（直す前に「クリックがある」を数値化）。
2. 第1案を実装（DomRenderer 音声適用分離 → loop 配線 → BundlePlayer）。
3. 計測で継ぎ目残留が閾値以下になるか確認。ダメならフォールバック（ミュート窓）へ。
4. `build:player` → 実機であなたが試聴 → progress 更新。
