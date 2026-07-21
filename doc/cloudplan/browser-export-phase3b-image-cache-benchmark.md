# Browser Export Phase 3b — static image capture cache

> 計測日: 2026-07-20  
> fixture: 1280×720 / MP4 / 24 frames / GPU direct / 最前面に320×180 PNG image 1枚  
> A/B: solid/text cacheは両群ON、image cacheだけOFF→ON

## 変更

- effect無し・matte無し・2Dの静的imageをbounded foreignObject capture cacheへ追加。
- resolved asset/fit/transform/opacityに加え、実DOM `<img>` の`currentSrc`・natural sizeをcache keyへ含める。
- `<img>` が未読込、natural size 0、src差替えの場合はcache対象外またはmiss。
- video/canvas/HTML/plugin/geom/nested/adjustment/effect付きレイヤーは引き続き対象外。

## A/B（可視image、同一build、3 pairs）

| 指標 | image cache OFF | ON | 差 | 勝敗 |
|---|---:|---:|---:|---:|
| wall median | 3,250.9 ms | 2,795.8 ms | **-14.0%** | 3/3 |
| steady median | 92.7 ms/frame | 77.6 ms/frame | **-16.3%** | 3/3 |
| SVG image decode | 243 | 220 | **-23** | 全run一致 |
| tracked drawImage | 315 | 292 | **-23** | 全run一致 |

- -23 = static image 1枚 × 残り23 frames。
- MP4 outputは全OFF/ON runで **14,035 bytes**、1280×720 metadata decode成功・一致。
- GPU directは全run 24/24 frames。

## Gate

- unit: imageはsignature対象、videoは対象外、image cache A/B seam、transform変化miss。
- resource gate: `complete && naturalWidth>0 && naturalHeight>0`。`currentSrc/src + natural size`をsignatureへ追加。
- cacheはDOMレイヤーごと直近1枚のみ。asset/source変更で置換され、履歴は増えない。
- typecheck / player rebuild / freshness PASS。full Vitestは1355/1357（既知liquidChrome +既知flaky projectBins）。projectBinsを含む関連38 testsは単独再実行で全PASS。

## 結論

静的画像1枚でもforeignObjectのSVG decodeを23回正確に除去し、wall/steadyとも二桁短縮した。次はvideoを単純cacheしてはならないため、presented frameを毎フレーム直接canvas/GPUへ渡すadapterとして別フェイズで扱う。
