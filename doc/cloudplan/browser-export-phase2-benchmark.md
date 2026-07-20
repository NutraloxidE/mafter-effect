# Browser Export Phase 2 — GPU compositor encoder直結

> 計測日: 2026-07-20  
> fixture: 1280×720 / 24 frames / blend + mosaic adjustment + matte + nested comp  
> format: MP4(H.264) / WebM(VP9)、`alpha=false`、scale=1

## 変更

- 非透過 MP4/WebM は WebGL2 compositor を優先し、失敗時は同じ capture/op 列で Canvas2D へ fallbackする。
- native解像度では compositor の最終 WebGL canvas を `VideoFrame` へ直接渡す。
- 従来の `WebGL canvas → Canvas2D canvas` の最終 `drawImage` を1回/フレーム削除する。
- PNG、透過WebM、scaled output、`compFrameCapture`、bundle bake は従来経路のまま。

## A/B 1 — GPU内の最終copy有無（同一build、交互実行）

| format | 指標 | copy | direct | 差 | 勝敗 |
|---|---:|---:|---:|---:|---:|
| MP4 (4 pairs) | wall median | 3,458.15 ms | 3,367.15 ms | **-2.6%** | 2/4 |
| MP4 | steady median | 110.8 ms/frame | 103.45 ms/frame | **-6.6%** | 3/4 |
| WebM (3 pairs) | wall median | 3,759.4 ms | 3,350.0 ms | **-10.9%** | 3/3 |
| WebM | steady median | 121.1 ms/frame | 102.4 ms/frame | **-15.4%** | 3/3 |

- tracked `drawImage`: **407 → 383**（24 framesで24回削減）。
- direct run は全て `gpuFrames=24` / `gpuDirectSurfaceFrames=24`。
- output metadata decode: MP4/WebMとも1280×720で成功。静止fixtureの出力bytesもcopy/directで一致（MP4 5,791 bytes、WebM 46,545 bytes）。

## A/B 2 — browser video export の CPU既定 vs GPU+direct（MP4、4 pairs）

| 指標 | CPU | GPU+direct | 差 | 勝敗 |
|---|---:|---:|---:|---:|
| wall median | 4,015.45 ms | 3,469.4 ms | **-13.6%** | 4/4 |
| steady median | 119.55 ms/frame | 103.7 ms/frame | **-13.3%** | 3/4 |

この結果と既存の normal/blend/mosaic parity gate を根拠に、`alpha=false` のMP4/WebMだけGPU compositorを明示選択する。GPU非対応・context失敗・unsupported adjustmentはCanvas2Dへfallbackする。

## parity / isolation

- `verify-gpu-direct-video-frame.mjs`: WebGL direct canvas と従来Canvas2D copyから作った `VideoFrame` をRGBA展開して比較。
  - normal: 230,400 samples、maxAbs=0、differing=0。
  - blend: 230,400 samples、maxAbs=0、differing=0。
- GPU normal parity: 3 frames、CPU比 maxAbs=0 / mean=0。
- scale=0.5 MP4: `gpuFrames=6`、`gpuDirectSurfaceFrames=0`、640×360 metadata decode成功。
- alpha WebM: `gpuDirectSurfaceFrames=0`を確認。現環境では生成blobのmetadata decodeが失敗する既知ブラウザ制約があり、直結の合否には使用していない。

## test

- `npm run typecheck`: PASS。
- targeted: 16/16 PASS（GPU mapping/direct flag、backpressure、video encode config）。
- player再ビルド + freshness: PASS。
- full Vitest: 1349/1350。唯一のfailは既存の `effects.test.ts` liquidChrome再登録漏れで、本差分と無関係（単独再実行でも同じ）。

## 結論

最終surface copy削除単体はMP4で小〜中、WebMで中程度の改善。GPU compositorのvideo export既定利用まで含めると、このheavy fixtureのwall中央値は **13.6%短縮**した。残る支配コストは foreignObject SVG decode / `toDataURL` / layer capture であり、次の本丸は plan Phase 3 の layer-local surface cache と direct surface adapter。
