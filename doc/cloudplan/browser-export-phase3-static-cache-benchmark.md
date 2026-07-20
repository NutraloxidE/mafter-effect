# Browser Export Phase 3a — bounded static layer capture cache

> 計測日: 2026-07-20  
> fixture: 1280×720 / 24 frames / MP4 / GPU+direct / blend + mosaic + matte + nested  
> cache対象: effect無し2D solid/textのみ（fixture内4レイヤー）

## 実装境界

- `ResolvedObject`から world transform / opacity / component props を含むsignatureを作る。
- rendererのDOMレイヤー実体ごとに直近1 captureだけをWeakMap保持する。signature変化時は置換し、履歴を蓄積しない。
- 対象: effect無し・matte無し・2Dのsolid/text。geom textは除外。
- 対象外: image/video/canvas/geom3d/HTML/plugin/nested/adjustment/effect/matte。
- browser MP4/WebMだけopt-in。PNG、`compFrameCapture`、bundle bakeは従来どおり毎回captureする。

## A/B（同一build、cache OFF→ONを4ペア）

| 指標 | OFF median | ON median | 差 | 勝敗 |
|---|---:|---:|---:|---:|
| wall | 3,882.7 ms | 3,795.65 ms | **-2.2%** | 2/4 |
| steady frame | 121.9 ms | 107.6 ms | **-11.7%** | 3/4 |

構造カウンタは全runで完全に安定:

- SVG image decode: **311 → 219**（-92 = 4 static layers × 23 reused frames）。
- tracked `drawImage`: **383 → 291**（-92）。
- MP4 output: 全OFF/ON runで **5,791 bytes**、1280×720 metadata decode成功。
- GPU direct: ON/OFFとも24/24 frames。

wallはOS/GPU負荷の分散が大きく改善幅は小さいが、狙ったforeignObject decodeを正確に92回除去し、steady中央値は二桁改善した。

## correctness gates

- `staticLayerCaptureSignature` unit: 同値hit、transform変化miss、plain text対象、geom/effect/media/matte/3D除外。
- video monotonic実機: onTarget 25/25、reversal 0、stuck 0 PASS（video layerはcache対象外）。
- output bytes / dimensions一致。
- cacheは直近1枚でbounded。capture reject時は該当entryを削除する。
- full Vitest: 1354/1355 PASS。唯一のfailは既存`effects.test.ts` liquidChrome再登録漏れ。player freshness PASS。

## 次段

本cacheは安全優先でsolid/textだけ。次の効果が大きい順は、image decoded surfaceの直接再利用、video presented frameのdirect texture化、placementをcontent captureから分離してtransform-only animationでもcontent cacheをhitさせること。ここからはmatte/perspective/nestedのfallback設計を個別に固定する。
