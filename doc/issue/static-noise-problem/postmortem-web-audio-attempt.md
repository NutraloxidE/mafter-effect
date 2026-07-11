# ポストモーテム: bundle ループ音声 Web Audio 実装（中止）

- 日付: 2026-07-10
- 対象: [`fix-plan.md`](fix-plan.md) / [`fix-plan-codex.md`](fix-plan-codex.md) に基づく Codex 実装
- 判定: **中止。実装前（`f0a4064`）へ戻して再プランする。**
- 中止時点の実装は別ブランチ `codex/preview-v2-wp2-presented-servo`（commit `738fe09`）に保存済み。

---

## 何をやったか

`fix-plan.md` の設計「bundle の可聴音声を単一 Web Audio graph に通す」を Codex で実装した。

```
HTMLMediaElement -> MediaElementAudioSourceNode -> fadeGain -> userGain -> destination
```

作成・変更したもの:

| ファイル | 内容 |
|---|---|
| `src/player/mediaAudioController.ts`（新） | AudioContext + 要素ごと source/gain を所有するコントローラ |
| `src/player/loopSeamFade.ts`（新） | ループ継ぎ目フェードの状態機械（純関数） |
| `src/player/mediaAudioLayerTime.ts`（新） | comp frame → media time マッピング（純関数） |
| `src/player/BundlePlayer.ts` | コントローラ生成・unlock・両音声経路の配線 |
| `src/player/BundleAudioClock.ts` | `setMediaGainSink` / `setLoopBoundaryCallback` 追加 |
| `src/runtime/DomRenderer.ts` | `externalAudioGain` flag で直接 `video.volume` を停止 |
| `src/runtime/previewPlaybackLoop.ts` | `onLoopBoundary` コールバック追加 |
| `test/loopSeamFade.test.ts` / `test/mediaAudioLayerTime.test.ts` | 純関数の unit test |

---

## 何がダメだったか

### 1. グリーンなテストと壊れた製品（最大の問題）

Codex 実装は **typecheck・unit test・build:player すべて通過**したのに、**書き出した HTML は完全無音**だった。

原因は Web Audio の基本的な罠: `MediaElementAudioSourceNode` に接続した要素を `element.muted = true` にすると、**グラフに入る信号自体が無音**になる。実装は「ネイティブ要素は muted、可聴 gain はグラフが所有」という意図で 2 箇所（`DomRenderer` の `forceMuted` と `attach()`）で要素を muted 固定しており、直接 `video.volume` 経路も無効化していたため、音の出口が完全に消えていた。

→ **ユニットテスト（fake AudioParam）では検出不可能な種類のバグ。実ブラウザ検証をループに組み込まないと、この設計は「動いているように見えて無音」になる。**

### 2. 最もリスキーな部品にテストが無い

`mediaAudioController.ts`（AudioContext・source node・fade の実体）には **テストが1つも無い**。`fix-plan-codex.md` の WP3-04 は「fake AudioParam で fade-to-zero と重複 source node 拒否を assert する」と明記していたが、実装されなかった。結果、上記サイレンスバグが素通りした。

### 3. 設計した純関数が孤児化

`loopSeamFade.advanceLoopSeam`（継ぎ目フェードの状態機械, WP2-03）は **src のどこからも呼ばれていない**。コントローラは状態機械を使わず `window.setTimeout` で継ぎ目処理を別実装している。つまり「純関数を先に切り出して test で固める」という分解の狙いが、統合段階で捨てられた。

### 4. 元の目的（continuity/declick）が一度も実証されていない

実クローム検証で確認できたのは「クリック後に音が流れる（RMS > 0）」までで、**ループ継ぎ目のクリック音が消えたかは未検証**（検証に使ったのは継ぎ目を持たない単一トーン動画）。`report.md` が指摘した本来の不具合＝「継ぎ目でのポップ音」は、この実装で解消したという証拠がない。**大量の機構を足したが、狙った問題を解いた証拠がゼロ。**

### 5. アーキテクチャ上の構造的ミスマッチ

- **要素プーリング × 一度きりの source node**: レンダラは継ぎ目のシームレス化のために `<video>` 要素をプール／ダブルバッファし、ループ境界で差し替える（preview v2 WP1）。しかし `MediaElementAudioSourceNode` は要素につき一度しか作れず、要素を恒久的にグラフへ張り替える。差し替えのたびに新要素へ source node を作り、旧要素の node は宙に浮く。検証でも継ぎ目後に tap 数が 1→2 に増えた。fix-plan 自身の Risks が挙げていた問題を、実装は解けていない（毎フレーム全要素に attach して source node を溜めるだけ）。
- **可聴 gain の所有者が多重化**: `video.volume`（flag で停止）・コントローラ `userGain`・`BundleAudioClock` の `<audio>.volume` が競合。サイレンスバグはこの多重所有が要素の状態を奪い合った直接の症状。
- **preview/export との経路分岐が増える**: declick は本来「preview / browser export / bundle が同じ長さ・抑制を共有」して INV-2 の一貫性を保つ設計。bundle 専用の第3経路（コントローラ）を足すと、この一貫性から逸脱する方向になる。

---

## 何を学んだか（再プランに引き継ぐ）

1. **実ブラウザ検証を「完了条件」に必ず入れる。** unit + typecheck + build のグリーンは、音声・WebAudio・autoplay のような経路では「動く」ことを意味しない。
2. **Web Audio に載せるなら、要素プーリング／ダブルバッファとの整合を先に設計する。** source node の一度きり制約とプール差し替えは正面衝突する。
3. **「本当に Web Audio graph が必要か」を再検討する。** `report.md` の一次原因は「`video.volume` が描画フレームでしか更新されず、適応スキップで最後のフェードが落ちる」こと。これは、フェードを描画 cadence から切り離してスケジュールする／継ぎ目直前に必ず volume を書く／seek をミュートで挟む、といった **より小さい修正**で解ける可能性がある。フルの Web Audio 移行はオーバーキルかもしれない。
4. **継ぎ目のクリック音そのものを計測する検証プロキシを先に用意する。** 「音が鳴る」ではなく「継ぎ目の不連続が閾値以下」を測れないと、直したかどうか判定できない（`report.md` / `verify-loop-audio-seam.mjs` の境界差分計測が土台になる）。

---

## 保存物・参照

- 中止した実装: ブランチ `codex/preview-v2-wp2-presented-servo` の commit `738fe09`。
- 実クローム音声検証ハーネス（Range 対応サーバ + AnalyserNode RMS 計測）: `verify-loop-audio-realchrome.mjs`（同ブランチ）。再プランでも「実際に音が鳴るか」の回帰ゲートとして再利用可。
  - ハーネス上の教訓: ①stale vite 複数並走に注意 ②`route.fulfill` は Range 非対応で `<video>` がロード不能→実 HTTP Range サーバが必要 ③フィクスチャ `for-debug-data/video_with_audio.mp4` は 0 バイト・実 Comp 10 動画は HEVC で Playwright Chromium 非対応→ffmpeg で H.264+AAC トーン動画を生成 ④export 前に `saveToFs()` フラッシュ必須。
- 一次調査: `report.md`（継ぎ目差分の実測・コード経路）。
- 旧プラン: `fix-plan.md` / `fix-plan-codex.md`（設計と WP 分解。再プランのたたき台）。
