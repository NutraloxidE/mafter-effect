# MP4 export — 動画 Footage レイヤーの書き出し品質・もっさり感

> **対象**: `component.type === "video"` の Footage レイヤーを含む timeline comp の MP4 / PNG-seq / WebM export  
> **状態**: 2026-06-26 **真因修正済み（要ユーザー再確認）** — ちらつき（戻り進み）＝ play-step、もっさり＝フレーム境界 seek の float 丸めで毎3フレーム重複。下記「解決（2026-06-26 Claude Opus）」参照。  
> **再現データ**: `for-debug-data/mafter-project (9).zip` → **video-test** コンポ、`for-debug-data/video_test.mp4`

**関連 spec**: §11.2 export / §20 Footage / INV-2（preview ↔ export 同一 scene 解決値）  
**関連実装**: [exporter.ts](../../src/runtime/exporter.ts) / [exportComposite.ts](../../src/runtime/exportComposite.ts) / [rasterCapture.ts](../../src/runtime/rasterCapture.ts) / [videoElementSync.ts](../../src/runtime/videoElementSync.ts) / [DomRenderer.ts](../../src/runtime/DomRenderer.ts)

**検証スクリプト**: `verify-video-export.mjs`（自動）、`verify-video-import.mjs` / `verify-video-import-edges.mjs`（import・preview のみ）

---

## 症状（ユーザー報告）

| 段階 | 挙動 |
|------|------|
| **当初** | 動画入りコンポを書き出すと、**ブラウザ標準の video プレイヤー UI**（コントロール付きプレイヤー風の表示）が焼き込まれる。2D 表示・3D で浮かせた場合も同様 |
| **1 次修正後** | プレイヤー UI は消え、**映像らしい内容は出る**が、書き出し結果が **もっさり**（動きが遅い・カクつく・重い） |
| **2 次修正後（export play-step）** | 自動検証ではフレーム処理時間は改善したが、**ユーザー手動確認では依然もっさり**（未解消） |

preview パネル上の再生は（別途 `previewVideoPlayback` 修正後）比較的スムーズ。問題は **export 経路に限定**。

---

## アーキテクチャ上の制約（確定）

MP4 export は最終的に `compositeExportFrame` → `captureElementToCanvas`（**SVG `foreignObject`**）で DOM をラスタ化する（[exportComposite.ts](../../src/runtime/exportComposite.ts) / [rasterCapture.ts](../../src/runtime/rasterCapture.ts)）。

| 要素 | foreignObject での挙動 |
|------|------------------------|
| `<img>` / text / solid / CSS transform | 概ね焼ける |
| `<canvas>`（raster effect） | clone では bitmap が複製されない → `inlineCanvasBitmaps` で img 化（既存） |
| **`<video>`** | **ネイティブフレームを描画できない** → プレイヤー UI 風フォールバック、または空 |

したがって動画 Footage は **live DOM の `<video>` をそのまま foreignObject に載せられない**。  
canvas / image と同様、**capture 直前に静止画へ焼き込む**必要がある（`inlineVideoFrames`）。

preview は live `<video>` をそのまま表示するため、export だけが別経路になる（INV-2 の「見た目」は一致させる必要があるが、実装手段は異なる）。

---

## 試したメソッドと結果

### Phase 0 — 動画 import / preview（本 issue の前提）

| 内容 | 結果 |
|------|------|
| `importVideoAsset` / `VIDEO_COMPONENT_DEF` / DomRenderer `<video>` 配置 | preview・タイムライン配置は **OK** |
| `previewVideoPlayback` + `syncVideoElementTime`（再生中は `play()`、停止時のみ seek） | preview のもっさり感は **改善**（progress 2026-06-26） |
| export | **未対応**のまま → 本 issue へ |

### Phase 1 — プレイヤー UI 問題の修正

**仮説**: foreignObject が `<video>` を描けず、ブラウザがデフォルト UI を表示している。

**実装**:

1. [rasterCapture.ts](../../src/runtime/rasterCapture.ts) — `inlineVideoFrames` / `inlineExportMedia`  
   - `flattenShadow` の **clone 側のみ** `<video>` → `drawImage(video)` → `<img data URL>` に差し替え  
   - live DOM は非破壊（canvas インラインと同型）
2. [DomRenderer.ts](../../src/runtime/DomRenderer.ts) — `video.controls = false`、export 時 `syncVideoElementTime(..., { playbackMode: false })`
3. [exporter.ts](../../src/runtime/exporter.ts) / [compFrameCapture.ts](../../src/runtime/compFrameCapture.ts) — capture 前に `flushVideoFrames()`

**結果**: プレイヤー UI は **解消**（`verify-video-export`: `playerUi=0%`）。  
**副作用**: 映像は出るが **もっさり** という次の問題へ。

### Phase 2 — もっさり（古いフレーム capture）への対処

**仮説**: `waitForVideoFrame` が `readyState >= HAVE_CURRENT_DATA` だけ見て即 resolve し、**seek 完了前**に `drawImage` している。毎フレーム同じ（またはほぼ同じ）ピクセルが焼かれ、動きが遅く見える。

**実装**:

1. `waitForVideoFrame` — `seeking` → `seeked` → `requestVideoFrameCallback`（rVFC）の順で待機
2. `inlineVideoFrames` — full-res PNG + `img.onload` 待ち + **二重** `waitForVideoFrame`（`flush` と `inline` 両方）
3. タイムアウト 5s → 800ms に短縮

**自動検証**: Playwright が **ハング**（`page.evaluate` で 1920×1080 の `ImageData` 全配列を返していた）。スクリプト修正後は完走。  
**結果**: ユーザー体感は **未改善**。

### Phase 3 — export 性能（毎フレーム seek 回避）

**仮説**: export ループが **フレームごとに `video.currentTime` を seek** しており、ブラウザの decode が 400ms 級/フレームかかる。実時間より遅い書き出し＋seek 精度不足でフレームが進まない。

**実装** (`exportVideoStep`):

1. [videoElementSync.ts](../../src/runtime/videoElementSync.ts) — `syncVideoElementExportStep`  
   - 連続フレーム: ターゲットより遅れていれば **`play()` で自然に進める**  
   - 逆行・2 フレーム超のジャンプのみ `seek`
2. `waitForVideoFrame(video, targetSec)` — `data-mafter-export-video-target` 属性の時刻までポーリング + rVFC
3. `inlineVideoFrames` — 表示サイズ + **JPEG**、二重 wait 削除
4. exporter / compFrameCapture — `setPreviewRenderOptions({ exportVideoStep: true })`

**自動検証** (`verify-video-export.mjs`, `video_test.mp4` 手動構築 comp):

| 指標 | Phase 2 頃 | Phase 3 |
|------|------------|---------|
| 1 フレーム平均処理時間 | ~472ms | **~139ms** |
| `playerUi` | 0% | 0% |
| `nonBlack` | ~94% | ~94% |
| frame 0↔15 ピクセル差分 | 0.39%（低い） | 0.39%（**ほぼ変わらず**） |

**結果**: ベンチは改善したが **ユーザー手動確認では依然もっさり** → **未解消**。

---

## 考察

### 1. 「もっさり」の二義性

ユーザー報告が指しうるものは少なくとも二つある。

| 意味 | 説明 | Phase 3 での扱い |
|------|------|------------------|
| **A. 出力 MP4 の再生がスロー・カクつく** | フレーム内容が時間とともに十分進んでいない | 0↔15 差分 0.39% は **要警戒**（footage がほとんど動いていない可能性） |
| **B. 書き出し処理そのものが遅い** | 1 フレームあたり数百 ms | 472ms → 139ms で改善したが、30fps 実時間（33ms/frames）には **まだ遠い** |

ユーザーが「まだもっさり」と言った時点では A が主因の可能性が高い（映像は出るが動きがおかしい）。  
自動検証の **低 inter-frame diff** は、修正が不十分なシグナルとして残っている。

### 2. foreignObject + video インライン経路の限界

現行パイプライン:

```
renderFrame → syncVideo (seek/play) → flushVideoFrames → compositeExportFrame
  → flattenShadow → inlineVideoFrames (drawImage → JPEG → img) → foreignObject → canvas
```

ボトルネック候補:

- **ブラウザの `<video>` seek / step decode**（export では決定論的にフレーム単位が必要）
- **`drawImage(video)` → `toDataURL` → foreignObject 再エンコード** の二重ラスタ化
- rVFC が **mediaTime を保証しない**環境での race（`waitForVideoFrame` は `currentTime` 近似のみ）

preview が速いのは **連続 `play()` に decode パイプラインを任せている**ため。export は **停止→capture→進める** を繰り返すため、同じ API では構造的に不利。

### 3. 検証の限界

| 項目 | 限界 |
|------|------|
| `verify-video-export.mjs` | 軽量 comp を **スクリプト内で生成**（`video-test` zip 本体ではない）。素材が静的だと diff 閾値をすり抜ける |
| ピクセル差分 0.39% | 平均輝度（meanLum）も 45.7→46.1 と近く、**動き検出として弱い** |
| Playwright 完走 ≠ ユーザー zip の 3D+camera ケースをカバー | `mafter-project (9).zip` の **video-test**（2D + 3D レイヤ + camera）は手動確認が正 |

### 4. 非破壊性（他レイヤーへの影響）

動画が無い comp では `inlineVideoFrames` / `flushVideoFrames` は no-op。  
変更は **export / compFrameCapture 経路**と **clone 側メディアインライン**に閉じ、solid / image / 調整レイヤーの合成ロジックは変更していない。

---

## 未試行・次に検討すべき方向

優先度順の案（**未実装**）:

| # | 方針 | 概要 | trade-off |
|---|------|------|-----------|
| 1 | **export 用 video を foreignObject 外で合成** | `compositeExportFrame` の後段、またはレイヤー capture 時に live `<video>` を `drawImage` で直接 master canvas に重ねる（img 経由の foreignObject を省略） | 3D transform / blend との合成順を慎重に設計 |
| 2 | **WebCodecs `VideoDecoder`** | FS 上の mp4 をフレーム index でデコードし `ImageBitmap` キャッシュ。DOM `<video>` seek に依存しない | 実装コスト大・codec 対応・INV-2 テスト要 |
| 3 | **export 専用フレームキャッシュ** | 書き出し開始時に `(assetId, sourceFrame) → ImageBitmap` を先読み（バックグラウンド seek） | メモリ・初期待ち |
| 4 | **`VideoFrame` API** | `new VideoFrame(videoElement)` で rVFC / ハードウェアバッファ経路を使う | ブラウザ差・foreignObject との接続 |
| 5 | **検証強化** | `mafter-project (9).zip` を直接 import し、frame 0/30/60 の **hash / SSIM**、出力 MP4 の **フレーム間 PSNR** を測る | 問題の A/B 切り分け |

---

## 再現手順（開発者向け）

1. `npm run dev` → `http://localhost:5173/`
2. `for-debug-data/mafter-project (9).zip` を import → **video-test** コンポを開く  
   （または `for-debug-data/video_test.mp4` を +Video で配置）
3. Export → MP4（Best / コンポ解像度）
4. 出力を再生し、preview 同フレームと比較

自動:

```bash
node verify-video-export.mjs
# dev server 要。VERIFY_PORT でポート指定可
```

---

## 変更ファイル一覧（2026-06-26 時点）

| ファイル | 役割 |
|----------|------|
| [src/runtime/rasterCapture.ts](../../src/runtime/rasterCapture.ts) | `inlineVideoFrames`, `inlineExportMedia` |
| [src/runtime/videoElementSync.ts](../../src/runtime/videoElementSync.ts) | `waitForVideoFrame`, `exportStep` sync |
| [src/runtime/DomRenderer.ts](../../src/runtime/DomRenderer.ts) | `flushVideoFrames`, `exportVideoStep` 配線 |
| [src/runtime/exporter.ts](../../src/runtime/exporter.ts) | export オプション |
| [src/runtime/compFrameCapture.ts](../../src/runtime/compFrameCapture.ts) | 同上 |
| [src/runtime/exportComposite.ts](../../src/runtime/exportComposite.ts) | `inlineExportMedia` 呼び出し |
| [test/videoElementSync.test.ts](../../test/videoElementSync.test.ts) | ユニット 12 件 |
| [verify-video-export.mjs](../../verify-video-export.mjs) | Playwright 実機 |

---

## 関連 progress エントリ

- `progress.md` — 2026-06-26 動画 Footage インポート / preview 再生 / export（本 issue）

---

## 解決（2026-06-26 Claude Opus）

「もっさり」より「**戻ったり進んだりちらつく**」へ症状が悪化していた。3 つの独立した真因を特定・修正（変更は [videoElementSync.ts](../../src/runtime/videoElementSync.ts) のみ）。

### 真因1 — ちらつき（前後振動）: export の `play()`

Phase 3 の `exportVideoStep` は連続フレームを `video.play()` で進めていた。**play は実時間進行**のため、export ループの離散フレーム処理（1 フレーム数百 ms）とズレ、ターゲットを行き過ぎる → `behind < -frameSec` で逆行 seek → 再び play で行き過ぎ、を繰り返してキャプチャフレームが**前後に振動**。INV-2（フレーム決定論）違反。

→ `syncVideoElementExportStep` から `play()` を廃止し、**各フレーム決定論 seek**（pause + 目的フレームへ seek）に変更。

### 真因2 — もっさり（毎3フレーム重複 → 実質 20fps 化）

フレーム境界 `k/fps` ちょうどへ seek すると、`k/fps` の float 値が境界をわずかに下回り（例: タイムベース 1/15360 で `2/30*15360 = 1023.9999… → floor 1023 → frame 1`）、**前フレームが表示される**。k≡2 mod 3 等で**毎3フレームが直前の複製**になり、動きが 2/3 に間引かれてカクつく。`verify-video-export-monotonic.mjs` で `f0,f1,f1,f3,f4,f4,…` を観測して確定。

→ `videoSeekTargetSec(target, fps) = target + 0.5/fps`（**フレーム区間の中央**へ seek）。float 丸めが境界をまたいでも目的フレーム内に収まる。export と scrub（preview 停止）の両方で共有し、**preview↔export で同一フレーム表示**（INV-2・単一の正）。

### 真因3 — stale capture

`waitForVideoFrame` が seek 直後に「seek 前に提示済みの古い present」で resolve していた。`waitPresentedFrame` で **rVFC の `mediaTime ≈ target` を満たす present** まで待機（rVFC 未発火環境は 300ms フォールバック）。

### 検証

- 旧 `verify-video-export.mjs` の `video_test.mp4` は**それ自体が旧プレイヤーUIバグの焼き込み＋ほぼ静止**で、動き検出が無効（0↔15 diff 0.39% の正体）。ffmpeg `testsrc2` で動く素材 `for-debug-data/video_motion.mp4` を生成し、新 `verify-video-export-monotonic.mjs` で連続フレームの `currentTime`／フレーム間差分を測定。
- 結果: **reversals=0 / stuckFrames=0 / onTarget=25/25**、各フレーム ~3.3% の連続した動き。`npm test` 全 479 PASS、既存 `verify-video-export.mjs` 無回帰（playerUi=0%）。
- 残: 1 フレーム ~320ms（foreignObject ラスタ化が主因）は symptom B として別タスク。

## ステータスまとめ

| 項目 | 状態 |
|------|------|
| プレイヤー UI が焼き込まれる | **解消** |
| preview 再生のもっさり | **別途改善済み**（export とは別） |
| export 出力のちらつき（戻り進み） | **解消**（play-step 廃止・決定論 seek） |
| export 出力のもっさり（毎3フレーム重複） | **解消**（フレーム中央 seek） |
| INV-2（preview と export の見た目一致）— 動画 Footage | **達成**（scrub/export 共有 seek・要ユーザー再確認） |
| export の絶対速度（~320ms/frame） | **未対応**（symptom B・別タスク・foreignObject 由来） |
