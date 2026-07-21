# Browser Export Phase 1 — Before / After Benchmark

> 2026-07-19 / Chromium via Playwright / 1280×720 / 24 frames / heavy synthetic 9+4-layer comp  
> 対象変更: `VideoFrame(canvas)` direct input + `dequeue` event backpressure  
> fixture: `bench-gpu-raster-export-baseline.mjs`

## 結論

変更は採用する。ただし **小さな constant-factor 改善**であり、browser export の主要ボトルネックを解消するものではない。

- 同一 build 内の MP4 A/B（4 paired runs）で、wall median **4,030.5 → 3,902.0 ms（3.2%短縮）**。
- 定常 frame median は **123.8 → 115.5 ms/frame（6.7%短縮）**。
- paired run は direct canvas が 4 組中 3 組で勝利。1組は Chrome/foreignObject の大きな揺れで 14.4%悪化したため、効果はノイズより十分大きいとは断言しない。
- `createImageBitmap` は **24 calls → 0**。legacy計測では合計 1–2msしか表面化しておらず、本修正だけで劇的な改善は出ない。
- `dequeue` event backpressure は heavy fixture では encoder queue が支配的でないため、wall改善への寄与はほぼ観測不能。unit testで即時・複数dequeue・abort・closedを固定した。

## 同一 build A/B

一時benchmark seamで各 runを `bitmap → canvas` の順に交互実行し、測定後にseamを削除した。

| pair | legacy bitmap | direct canvas | canvas差分 |
|---:|---:|---:|---:|
| 1 | 4,737.3 ms | 5,421.5 ms | +14.4% |
| 2 | 4,281.4 ms | 4,119.6 ms | -3.8% |
| 3 | 3,779.5 ms | 3,525.7 ms | -6.7% |
| 4 | 3,725.7 ms | 3,684.3 ms | -1.1% |
| **median** | **4,030.5 ms** | **3,902.0 ms** | **-3.2%** |

定常frame（first frameのencoder/browser初期化を除く）median:

| legacy bitmap | direct canvas | 差分 |
|---:|---:|---:|
| 123.8 ms/frame | 115.5 ms/frame | **-6.7%** |

## 独立 before / after

### MP4

- before 3 runs: 3,746.8 / 3,751.9 / 3,638.9 ms、median **3,746.8ms**。
- final direct metadata run: **3,698.7ms**（before median比 -1.3%）。
- final output: MP4 / 1280×720 / duration 0.800s / 5,785 bytes / metadata decode成功 / page errors 0。

### WebM

- before 1 run: **3,964.2ms**。
- direct 3 runs: 3,023.6 / 3,747.5 / 3,948.7 ms、median **3,747.5ms**（before単発比 -5.5%）。
- final metadata run: **2,979.6ms**、WebM / 1280×720 / duration 0.766s / 46,151 bytes / metadata decode成功 / page errors 0。

WebM beforeは1 sampleだけなので、改善率は参考値。採否はMP4の同一build paired A/Bを主根拠とする。

## Correctness / regression gates

- `npm run typecheck`: PASS。
- targeted unit: `encoderBackpressure` 4 / `exportVideoEncode` 6 / `playerBuildFreshness` 1、全PASS。
- full vitest: **1348/1350 PASS**。失敗2件:
  - `effects.test.ts` liquidChrome再登録: progressに記録済みのpre-existing failure。本変更と無関係。
  - 初回 `playerBuildFreshness`: `npm run build:player` 実行後PASS、`public/player.js`更新済み。
- `verify-video-export-monotonic.mjs`: **PASS**。onTarget 25/25、reversals 0、stuckFrames 0/24。
- `verify-export-adjustment.mjs`: PASS。
- `verify-track-matte.mjs`: PASS 9/9。
- `verify-video-export.mjs`: frame capture自体は成功したが、既知の古い `video_test.mp4` に焼き込まれたplayer UIを検出しFAIL。このverifyは変更箇所より前段のcaptureを検査しており、direct `VideoFrame` / backpressureとは無関係。動きの正準ゲートは上記monotonic verifyを採用。

## 残るボトルネック

計測の支配項は引き続き foreignObject clone/serialize/SVG decode とlayer合成。次の性能フェーズは `browser-export-max-speed-plan.md` の Phase 2/3:

1. WebGL compositor outputを2D canvas copyなしでencoderへ渡す。
2. layer-local content surface cacheでtransform-only frameの再captureを止める。
3. solid/image/video/canvasをforeignObject外からdirect surfaceとして合成する。

本Phase 1はその前提となる不要surface除去と、bounded encoder queueの待機精度改善である。
