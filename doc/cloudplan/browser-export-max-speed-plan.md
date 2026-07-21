# Browser Export Maximum-Speed Plan

> 調査日: 2026-07-19  
> 対象: browser export（MP4 / WebM / PNG sequence）。headless / bundle / preview は無回帰対象。  
> 状態: **調査・計画のみ。未実装。** 既存 `gpu-raster-pipeline-design.md` Phase 0–4 を前提に、その先を export wall-clock 最短化へ再編する。

## 0. 結論

最大効果を狙う順序は次のとおり。

1. **実 MP4/WebM を stage 別に再計測**し、capture / video seek / composite / encode / mux / audio の critical path を固定する。
2. **コピーと待機の即効改善**: `createImageBitmap` 中間コピー、16ms polling backpressure、不要な frame ごとの task yield を実測つきで除去する。
3. **既存 WebGL2 compositor を export の最終 surface まで貫通**させ、GL canvas → 2D canvas → bitmap → `VideoFrame` の中間 surface をなくす。
4. **最大の本丸は foreignObject capture 回数の削減**。レイヤー内容を local surface としてキャッシュし、transform / opacity / z / blend は GPU compositor で毎フレーム適用する。
5. solid / image / video / canvas 系は foreignObject を通さない **direct surface adapter** を持ち、HTML / text / plugin のみ foreignObject fallback に残す。特に video の `<video>` → canvas → JPEG data URL → SVG decode を除去する。
6. DOM capture は main thread に残るため、Worker は encode / mux / PNG 圧縮へ限定し、transferable `VideoFrame` と bounded queue で重ねる。

目標は「GPU へ全面書き換え」ではなく、**同じ `resolve()` と同じ z 順 semantics を使いながら、重複 rasterization と CPU/GPU 往復を消すこと**である。

## 1. 現状の確定事実

### 1.1 現行 critical path

```text
resolve(frame)
  → DomRenderer.renderFrame
  → flushRasterEffects
  → flushVideoFrames (deterministic seek)
  → nextTick
  → compositeExportFrame
      ├ fast: root foreignObject capture ×1
      └ slow: layer foreignObject capture ×N
               → Canvas2D または flag-off の WebGL2 compositor
  → createImageBitmap(canvas)
  → VideoFrame(bitmap)
  → VideoEncoder.encode
  → encodeQueueSize polling
  → muxer ArrayBufferTarget
```

根拠となる symbol:

- `src/runtime/exporter.ts`: `encodeVideoFrames`, `backpressureEncoderQueue`, `runMp4`, `runWebm`
- `src/runtime/exportComposite.ts`: `compositeExportFrame`, `captureLayerNode`, `compositeGpuOps`
- `src/runtime/rasterCapture.ts`: `captureElementToCanvas`, `inlineCanvasBitmaps`, `inlineVideoFrames`
- `src/runtime/compositor/WebGL2Compositor.ts`: `finish`

### 1.2 既存ベースライン

`bench-gpu-raster-export-baseline.json` の 1280×720 / 9+4 layer / PNG sequence / 24 frame:

| 指標 | 実測 |
|---|---:|
| wall | 253.8 ms/frame（約 3.9 fps） |
| SVG image decode | 70.8 ms/frame、13 calls |
| Canvas2D `drawImage` | 63.4 ms/frame、23 calls |
| `toDataURL` | 15.3 ms/frame |
| `getImageData` | 14.1 ms/frame |
| `putImageData` | 2.0 ms/frame |

capture + Canvas2D accumulate だけで約 134 ms/frame。これは total の約 53% であり、API wrapper に現れない DOM clone / XML serialize / resolve / effect / scheduler 時間も残る。

重要な制約:

- この baseline は PNG で、WebCodecs / mux / audio を含まない。
- 既存 GPU backend は normal / 15 blend / mosaic adjustment まで実装済みだが、**dev flag 既定 OFF**、かつ GPU 後に 2D canvas へ `drawImage` する。
- raster effect が GPU registry 非対応、CSS filter chain を含む、nested compositor などでは CPU fallback が残る。
- video export は各 frame を deterministic seek する。`play()` に戻す最適化は禁止（過去に前後振動と重複 frame を起こした）。

### 1.3 Web platform 調査で確定したこと

- WebCodecs は `VideoFrame(CanvasImageSource, init)` を直接受ける。よって `canvas → createImageBitmap → VideoFrame` は仕様上必須ではない。  
  [W3C WebCodecs — VideoFrame IDL](https://www.w3.org/TR/webcodecs/#videoframe-interface)
- `VideoEncoder` には `encodeQueueSize` と `dequeue` event がある。16ms polling ではなく event-driven backpressure にできる。  
  [W3C WebCodecs — VideoEncoder](https://www.w3.org/TR/webcodecs/#videoencoder-interface)
- `VideoFrame` は transferable で、realm 間を underlying media resource の copy なしで移動できる。WebCodecs 自体も DedicatedWorker に exposed される。  
  [W3C WebCodecs — Transfer and Serialization](https://www.w3.org/TR/webcodecs/#transfer-and-serialization)
- `latencyMode: "realtime"` は frame drop を許す。決定論 export の既定高速モードには使えない。`quality` は bitrate/framerate 達成のための frame drop を禁止する。  
  [W3C WebCodecs — Latency Mode](https://www.w3.org/TR/webcodecs/#latency-mode)
- `hardwareAcceleration: "prefer-hardware"` は hint であり、UA が無視できる。config support と実測で採否を決める。  
  [W3C WebCodecs — Hardware Acceleration](https://www.w3.org/TR/webcodecs/#hardware-acceleration)
- Chrome も WebCodecs の frame/chunk handling を Worker に移すこと、`VideoFrame` transfer、OffscreenCanvas を案内している。ただし codec 本体はもともと非同期・off-main-thread なので、Worker 化の価値は main-thread callback / mux / copy の隔離で測る。  
  [Chrome for Developers — Video processing with WebCodecs](https://developer.chrome.com/docs/web-platform/best-practices/webcodecs)
- Remotion は frame render と encode を分離し、対応 codec では parallel encoding、複数 frame renderer の concurrency、media frame cache を使う。ただし動画 decode は線形資源になりやすく、同一 stream の無制限並列化は逆効果になりうる。Mafter の browser 内 export ではまず bounded pipeline と source-frame cache を採用し、multi-render-context は最後に検証する。  
  [Remotion `render-media.ts`](https://github.com/remotion-dev/remotion/blob/main/packages/renderer/src/render-media.ts), [Remotion concurrency discussion](https://github.com/remotion-dev/remotion/issues/4300)
- 現在の `mp4-muxer` / `webm-muxer` の置換候補として Mediabunny は browser の streaming output と WebCodecs pipeline を提供する。移行そのものを速度改善と決めつけず、長尺時の memory / finalize / GC を A/B する。  
  [Mediabunny repository](https://github.com/Vanilagy/mediabunny)

## 2. 守る契約

1. `resolve(comp, frame)` と frame mapping は変更しない（INV-1 / INV-2 / INV-5）。
2. Renderer / compositor は `ResolvedScene` 由来の値だけを使う（INV-3）。
3. strict export は全入力 frame を timestamp 順に encoder へ渡し、出力を decode 検証して欠落・重複・逆行がないことを確認する。
4. preview / browser export / headless export は scene 値を共有する。GPU と CPU の raster 差は既存許容差（通常 maxAbs 0、blend/effect maxAbs ≤2/255）以内。
5. `project.json` / §5 schema / INV は変更しない。速度設定を追加する場合も export session の非永続 config に閉じる。
6. CPU reference backend と capability fallback を消さない。
7. `latencyMode: "realtime"`、MediaRecorder、`captureStream()` は canonical export に使わない。

## 3. 実装フェーズ

### Phase 0 — Full-export profiler と比較 matrix

最初にコード最適化をせず、MP4 / WebM / PNG の wall-clock を区間計測する。

追加する計測点:

- prepare: font/image/module/audio preparation
- frame: resolve / DOM apply / raster flush / video seek+present / settle barrier
- capture: clone / media inline / XML serialize / SVG encode / image decode / canvas draw
- composite: texture upload / GPU pass / Canvas2D fallback / final surface copy
- encode: `VideoFrame` construction / `encode()` / queue wait / output callbacks
- mux/audio: audio mix / audio encode / chunk add / finalize / Blob construction
- resource: peak `encodeQueueSize`, live `VideoFrame` 数、canvas/texture alloc、JS heap、output bytes held in RAM

fixture:

| ID | 内容 | 解像度 / format |
|---|---|---|
| A | solid + text + image、fast root capture | 1080p / MP4, WebM, PNG |
| B | blend 15種 + mosaic adjustment + matte + nested | 720p, 1080p, 4K / 3 formats |
| C | 1 / 4 video layer、連続 source frame | 1080p / MP4, WebM |
| D | 3D/camera + canvas/geom + nested precomp | 1080p / MP4, PNG |
| E | 60秒 audio/video、memory stress | 1080p / MP4, WebM |

測定は cold/warm 各 3 回、median と p95、Chrome version / GPU / codec support を保存する。以後の phase は同一 harness で比較する。

**Gate**: stage 合計が wall の ±5% に収まり、GPU flag ON/OFF と `quality` / hardware hint の比較が取れること。

### Phase 1 — Copy / wait / backpressure quick wins

#### 1A. Direct `VideoFrame(canvas)`

`encodeVideoFrames` の `await createImageBitmap(canvas)` を外し、まず `new VideoFrame(canvas, ...)` を A/B。GPU path 完了後は GL canvas を直接入力する。

受け入れ:

- frame hash / encoded frame count / timestamp が現状と一致。
- `VideoFrame` construction + GC が改善しない UA では capability/perf result を根拠に rollback。

#### 1B. Event-driven encoder backpressure

`setTimeout(16)` polling を `dequeue` event + abort/error race に置換する。queue 上限は固定 6 を鵜呑みにせず 2/4/6/8 を fixture A/C で autotune し、session 中は固定する。

受け入れ:

- queue wait の oversleep を除去。
- peak live frame / memory が上限内。
- encoder close/error/abort で waiter が必ず解放される。

#### 1C. Settle barrier の局在化

`flushRasterEffects()` / `flushVideoFrames()` 後の `nextTick()` が何を待っているかを計測する。DOM serialization は同期で足りる frame では省略し、HTML comp / font / async canvas 更新など必要な frame だけ renderer が明示 `flushForCapture()` を返す。

`nextTick` の一括削除は禁止。連続 frame N と単独 frame N の pixel parity で判断する。

#### 1D. Encoder config matrix

- strict 既定: `latencyMode: "quality"` または未指定。frame drop を許さない。
- `hardwareAcceleration: "prefer-hardware"` → `isConfigSupported()` → unsupported/遅い場合 `no-preference` fallback。
- keyframe interval 30 / 60 / 120 を速度・seekability・size で比較。変更するなら §11.2 散文を先に更新する。
- `realtime` は明示 Draft export を別仕様にする場合だけ候補。canonical と同じ名前で提供しない。

### Phase 2 — GPU compositor の出口を encoder へ直結

既存 `WebGl2Compositor.finish(): HTMLCanvasElement` は GL canvas を新しい 2D canvas へ `drawImage` している。出力を所有権付き surface にする。

概念 API:

```ts
interface CompositeFrame {
  source: CanvasImageSource;
  backend: "canvas2d" | "webgl2";
  close(): void;
}
```

- MP4/WebM: `new VideoFrame(frame.source, ...)` へ直結。
- PNG: 最後にだけ 2D/readback/encode を行う。
- CPU fallback: 現在の Canvas2D canvas を `source` にする。
- GPU resource は encoder が frame を clone した直後に release できるが、UA ごとの遅延参照を実機検証する。必要なら 2–3 surface ring buffer にする。

同時に GPU registry を `wave` / `ripple` / `turbulentDisplace` 等へ広げ、CPU 固定 frame 率を計測する。CSS/SVG filter を含む chain は reference fallback を維持する。

**Gate**:

- GPU eligible fixture B/D で tracked final `drawImage` / `createImageBitmap` が 0。
- GPU vs CPU parity: normal maxAbs=0、blend/effect maxAbs≤2/255。
- context lost / abort 後に texture/FBO/VideoFrame が残らない。
- 軽量 fixture A の wall regression ≤3%。

### Phase 3 — Export Layer Surface Graph（最大効果）

foreignObject を「完成 frame 全体を毎回焼く装置」から「DOM でしか表現できない layer content の fallback rasterizer」に縮小する。

#### 3A. content と placement を分離

現在は layer capture に transform / perspective まで焼くため、position/rotation/opacity だけ変化しても再 capture になる。次の二層へ分ける。

```text
LayerContentSurface (local pixels, cacheable)
  + LayerPlacement (world transform, opacity, z, blend, matte relation)
  → shared GPU compositor
```

content signature に含めるもの:

- component content / text / HTML params / source frame
- raster/filter chain と animated effect props
- layer-local size / crop / font / image resource epoch
- matte source content（matte を capture 内で焼く間）
- nested comp content frame / nested resource epoch

含めず compositor で適用するもの:

- world transform / camera projection
- opacity / zOrder / blend mode
- comp background

3D/perspective、backdrop、mask、CSS stacking context は最初から一括移行せず、対応できない layer は既存 capture に fallback する。

#### 3B. direct surface adapters

優先順:

1. **solid**: texture upload すらせず shader color quad。
2. **image**: `ImageBitmap` / decoded image texture を asset cache から再利用。
3. **video**: deterministic seek + presented frame の `<video>` / `VideoFrame` を compositor texture source に直接渡す。現在の canvas→JPEG data URL→SVG decode をなくす。
4. **canvas/geom3d/split-alpha**: live canvas を直接 texture source にする。
5. **text**: font outline/path の direct raster を別実験。初期は foreignObject fallback。
6. **HTML comp/plugin**: foreignObject fallback。内容 signature が同じ frame は surface cache。

direct video は速度だけでなく JPEG 0.92 の中間劣化も除けるが、alpha / color space / crop / fit / 3D / track matte の parity を個別 fixture で固定する。

#### 3C. bounded surface cache

- key: `objectId + localFrame/sourceFrame + contentSignature + outputScale + resourceEpoch`
- tier: current/next-frame hot textures → ImageBitmap/canvas LRU → optional persistent compressed cache
- budget: bytes で上限管理し、解像度・同時 video 数から自動算出
- sequential export は N+1 source video decode の lookahead を 1–2 frame に限定
- miss/eviction/recapture reason を profiler に出す

**Gate**:

- transform-only animationで content recapture が初回のみ。
- video fixture C で `inlineVideoFrames` / JPEG `toDataURL` / SVG 内 video image が 0。
- static layer fixture で foreignObject decode calls が layer×frame から content-change 回数へ落ちる。
- continuous frame N == isolated frame N、preview/export parity、nested/matte/blend/adjustment 無回帰。

### Phase 4 — Worker encode/mux と bounded pipeline

**実装・Gate 判定（2026-07-20）**: DedicatedWorker の video-only MP4/WebM encode+mux、transferable `VideoFrame`、最大3枚の ack backpressure、abort/close を実装。fixture A（24f MP4、GPU direct）では Window 3844.4ms に対し Worker 3956.3ms（+2.9%）、出力 5791 bytes / 1280×720 / 0.8s は一致した。短尺では wall 改善がないため既定OFFとし、`globalThis.__mafterWorkerVideoExport = true` の明示 opt-in と benchmark counter を残す。長尺または encode-bound fixture で再評価する。

DOM/foreignObject capture は Window に残す。main thread が `CompositeFrame` から `VideoFrame` を生成し、DedicatedWorker へ transfer。Worker が VideoEncoder output と mux を担当する。

```text
main: resolve/render/capture/composite N+1
             ↓ transferable VideoFrame (bounded 2–3)
worker: encode/mux N
```

- queue は `dequeue` と Worker ack の双方で backpressure。
- abort は main→worker、worker encoder close、保留 frame close、mux target close の順。
- UI progress callback は 10–15Hz に throttleし、frame ごとの React update を避ける。
- PNG sequence は OffscreenCanvas `convertToBlob()` + ZIP/stream worker を A/B。ただし SVG DOM capture 自体は worker 化しない。

**Gate**:

- fixture A/C の main-thread busy time と wall の両方を計測。UI responsiveness だけ改善し wall が悪化する場合は optional worker mode に留める。
- transfer 後の source frame close と worker output resource close を leak test。

### Phase 5 — Audio overlap と streaming output

**実装・Gate 判定（2026-07-20）**: 音声source/metadataを同期確定し、read/decode/OfflineAudioContext mixを映像renderと重ねられるA/B経路を実装。60f音声付きMP4では直列20.20s、並行21.92s（+8.5%）だったため資源競合回避を優先し、`__mafterAudioMixOverlap=true` のopt-in（既定OFF）とした。MP4は`fastStart: "in-memory"`と、video/audio chunk上限を先に予約するregular MP4を比較。60fの2回で6120.4→5955.9ms（-2.7%）、5139.5→4758.1ms（-7.4%）、直接計測したfinalizeは2.3→1.2msだった予約方式を既定採用。音声付き予約MP4は48kHz stereo / RMS 0.085、WebMは48kHz stereo / RMS 0.083を実デコード確認。StreamTargetは現行公開APIが最終`Blob`を要求し、全出力保持を除けないため見送り。真のstreamingはFile System Access等のstream返却APIを別途設計するときに行う。

1. audio asset read/decode/mix を video render と並行化できるよう preparation と mux metadata を分離する。
2. AudioEncoder と VideoEncoder の同時実行が hardware resource contention を起こさないか A/B。
3. 長尺 export は in-memory `ArrayBufferTarget` と streaming target を比較する。
4. `mp4-muxer` / `webm-muxer` → Mediabunny migration spike は、同じ encoded chunks で mux/finalize wall、peak heap、output parity/seekability を比較してから判断する。

これは短尺の capture-bound fixtureでは後順位。60秒以上で GC / Blob finalization が支配的な場合のみ昇格する。

### Phase 6 — Experimental multi-render-context

Remotion 型の frame concurrency は最後に試す。browser 内の same-origin hidden DOM を増やしても main thread / GPU / video decoder を共有し、速くなる保証はない。

試験条件:

- video なし、HTML-heavy、frame 間独立な fixtureから開始。
- 2 render contexts で even/odd または chunk range を描き、結果を timestamp 順に bounded queue へ入れる。
- context ごとに renderer / expression engine / media resource を完全分離。
- memory 2倍、GPU context 数、font/image duplicate decode を測る。

2 contexts で wall が ≥20% 改善し、peak memory が許容内の時だけ残す。動画 fixtureで decoder 重複が出る場合は無効化する。

## 4. 優先順位と期待値

期待値は実測前の仮説で、達成保証ではない。

| 優先 | 施策 | 期待 | リスク |
|---:|---|---|---|
| P0 | full-export profiler | 投資先を確定 | 低 |
| P0 | direct VideoFrame / dequeue / settle局在化 | 5–15%、encoder-boundでは増 | 低 |
| P0 | GPU flag ON の現実測 + direct GL output | heavy composite 10–35% | 中 |
| P1 | GPU effect coverage | CPU fallback率に比例 | 中 |
| P1 | local surface cache | static/transform-heavy 1.5–3×候補 | 高（invalidation） |
| P1 | direct image/video/canvas surface | video-heavyで最大候補 | 高（parity/color/alpha） |
| P2 | worker encode/mux | responsiveness + 0–20% wall | 中 |
| P2 | streaming mux/audio overlap | 長尺 memory/finish 改善 | 中 |
| P3 | multi-render-context | fixture依存 | 高 |
| 非推奨 | WebGPU全面移行 | captureを減らさない | 高 |
| 禁止 | canonicalで realtime/MediaRecorder | frame drop/実時間依存 | INV-2/5違反 |

既存 baseline の単純な上限感では、capture decode 71ms と Canvas2D accumulate 63ms を両方大幅に落とせれば 253.8ms/frame から **2×前後**は現実的な stretch target。transform-only/static/video direct surface が効く fixture は **3×**を狙えるが、HTML が毎 frame 全内容変化する comp は foreignObject cost が残る。

## 5. 完了条件

### 性能

- fixture B 1080p strict MP4: baseline 比 wall ≥2×を stretch、最低採用線 ≥30% 改善。
- fixture C video-heavy: baseline 比 ≥1.5×、source-frame stuck/reversal 0。
- fixture A light: regression ≤3%。
- 4K / 60秒: OOM なし、queue/texture/cache が設定 budget 内。

### 正しさ

- input frame count = encoder input count。quality mode の decode 後 frame count / timestamp monotonic を検査。
- `verify-video-export-monotonic.mjs`: reversals=0 / stuckFrames=0 / onTarget 全件。
- CPU/GPU parity: normal maxAbs=0、blend/effect maxAbs≤2/255。
- preview screenshot vs MP4/PNG、continuous N vs isolated N、nested/precomp、track matte、adjustment、3D/cameraを横断。
- MP4/WebM seekability、A/V sync、alpha WebM、abort、context loss、unsupported codec fallback。

### 必須回帰ゲート

- `npm run typecheck`, `npm test`
- `bench-gpu-raster-parity.mjs`
- `bench-gpu-raster-compositor-parity.mjs`
- `bench-gpu-raster-blend-parity.mjs`
- `bench-gpu-raster-mosaic-parity.mjs`
- `verify-blend-mode.mjs`
- `verify-track-matte.mjs`
- `verify-export-adjustment.mjs`
- `verify-video-export.mjs`, `verify-video-export-monotonic.mjs`
- nested / solid+text+image / PNG / MP4 / WebM / bundle bake の関連 verify

`src/runtime` のうち player import 範囲を触る phase では `npm run build:player` と `playerBuildFreshness` を必須にする。

## 6. Spec 更新順

実装開始時は `doc/mafter-effect-spec.md` §11.2 に先に次を追記し、その後コードへ進む。

1. strict export は frame drop 禁止、決定論 timestamp、quality mode を正準とする。
2. browser exporter は CPU/Canvas2D/WebGL2/direct surface を capability 選択してよいが、scene 値と合成順を共有する。
3. direct media surface と foreignObject fallback の fidelity / color / alpha 契約。
4. export session cache と worker queue は非永続、`project.json` 非影響。

新しい永続 field、§5 型、INV の変更は不要。実装中に必要になった場合はそこで停止し、ユーザー確認を取る。

## 7. 推奨する最初の実装単位

最初の PR/作業単位は **Phase 0 + Phase 1A/1B のみ**。

理由:

- 現 baseline は PNG のため、MP4/WebM の真の encoder/mux 比率が未計測。
- direct `VideoFrame` と event-driven dequeue は仕様で裏付けられ、diff が小さく rollback 容易。
- その結果を見て Phase 2（GL direct output）と Phase 3（surface graph）の受け入れ数値を固定できる。

Phase 3 は最大効果だが、content invalidation を誤ると「特定 frame だけ古い」という最悪の回帰になる。Phase 0 profiler と continuous-vs-isolated parity harness を先に完成させてから着手する。
