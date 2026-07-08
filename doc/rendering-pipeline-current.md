# 現在のレンダリングパイプライン

日付: 2026-07-09

この文書は、現在の実装における「1 フレームが解決され、表示または書き出されるまで」の経路を整理したスナップショットです。特に preview 再生経路と、alpha チャンネルを持つ動画アセットの扱いに焦点を当てています。新しい仕様を定義するものではありません。正本は引き続き `doc/mafter-effect-spec.md` です。

## 1 フレームの全体像

```mermaid
flowchart TD
  Project["Project / TimelineComposition"]
  Frame["Frame（整数）"]
  Resolve["resolve(comp, frame)\nResolvedScene"]
  Dom["DomRenderer.renderFrame(scene, frame)\n兄弟 DOM / matrix3d / opacity / z-index"]

  Project --> Resolve
  Frame --> Resolve
  Resolve --> Dom

  Dom --> Preview{"Preview パネル"}
  Dom --> Export{"Browser export\nmp4 / webm / png-seq"}
  Dom --> Capture{"compFrameCapture\nRAM preview / precomp raster / bundle bake"}
  Dom --> Bundle{"HTML bundle player"}

  Preview --> PreviewLive["画面上の live DOM\nPreviewPanel"]
  PreviewLive --> PreviewCache{"RAM preview cache を使う？"}
  PreviewCache -->|"hit かつ live 編集なし"| CacheOverlay["cached PNG overlay\nlive DOM は非表示"]
  PreviewCache -->|"miss / live 編集中"| LiveVisible["live DomRenderer 出力"]

  Export --> ExportStep["exportVideoStep=true\npause + 決定論的 seek"]
  ExportStep --> FlushVideo["flushVideoFrames()\nwaitForVideoFrame / rVFC"]
  FlushVideo --> Composite["compositeExportFrame()\nroot capture または z-order compositor"]
  Composite --> Encode["VideoEncoder + muxer\nまたは PNG sequence zip"]

  Capture --> CaptureStep["exportVideoStep=true\n同じ offscreen DomRenderer 方針"]
  CaptureStep --> CaptureFlush["primeMountedVideos + flushVideoFrames"]
  CaptureFlush --> CapturePng["compositeExportFrame()\nPNG bytes"]

  Bundle --> BundlePlay["runtime player\nresolve + DomRenderer"]
  BundlePlay --> BundleClock["実時間 clock / audio clock\n再生中は previewVideoPlayback=true"]
```

共有される前提:

- preview / export / capture / bundle は、scene 解決の核として同じ `resolve(comp, frame)` を使う。
- 大きな分岐は `DomRenderer.renderFrame` の後にある。preview / bundle は live media playback を使える一方、決定論的な export / capture は `exportVideoStep=true` を立て、media frame を待ってから rasterize する。

## Preview 経路

```mermaid
flowchart TD
  UI["PreviewPanel"]
  Render["performPreviewRender(frame)"]
  Resolve["resolve(renderComp, frame,\nexpressions + optional previewCamera)"]
  Dom["DomRenderer.renderFrame"]
  FlushRaster["flushRasterEffects"]
  Screen["live DOM を表示"]
  CacheWrite["cachePlaybackFrame / cacheScrubbedFrame"]
  CacheRead["RAM preview cache lookup"]
  Overlay["cached blob URL overlay"]

  UI -->|"frame change / scrub / React effect"| Render
  Render --> CacheRead
  CacheRead -->|"hit かつ live 編集なし"| Overlay
  CacheRead -->|"miss または live 編集中"| Resolve
  Resolve --> Dom
  Dom --> FlushRaster
  FlushRaster --> Screen
  FlushRaster --> CacheWrite

  UI -->|"play"| Barrier["syncMountedVideosForPlay"]
  Barrier --> PlaybackFlag["previewVideoPlayback=true"]
  PlaybackFlag --> Render
  PlaybackFlag --> Clock["PreviewAudioClock または rAF loop"]
  Clock -->|"setFrame / draft direct render"| Render
  Clock --> Sync["computePlaybackSyncState"]
  Sync -->|"video が遅い"| Hold["timeline を hold"]
  Sync -->|"video が先行"| PauseVideo["video を pause（seek しない）"]
```

Preview 専用の挙動:

- 停止中 / scrub 中の preview は video 要素を muted にし、export と同じ frame-center target へ seek する。
- 再生中の preview は `previewVideoPlayback=true` を立て、video 要素は native `play()` に任せる。小さな drift では毎フレーム seek しない。
- 再生同期ゲートは、video が遅れていると timeline を hold し、video が先行していると video だけを pause できる。
- video warm-up、cut-boundary の要素 pooling、lookahead warm-up は preview / bundle 専用の最適化。export / capture では使わない。
- `previewCamera` override は editor 専用。export / bundle / nested capture には渡さない。
- RAM preview cache は、表示上 live DOM を cached image overlay に差し替えることがある。これは preview 表示の最適化であり、export 経路ではない。

## Export / capture 経路

```mermaid
flowchart TD
  ExportCall["exportComposition / captureCompFramePng"]
  Offscreen["offscreen container を作る"]
  Renderer["new DomRenderer"]
  Options["setPreviewRenderOptions\nexportCompositeMode=true\nexportVideoStep=true"]
  RenderFrame["renderFrame(resolve(comp, frame), frame)"]
  FlushRaster["await flushRasterEffects"]
  FlushVideo["await flushVideoFrames"]
  Capture["compositeExportFrame"]
  Output{"output"}
  Mp4["mp4: H.264 VideoEncoder\nopaque output"]
  Webm["webm: VP9 VideoEncoder\nconfig.alpha 時は alpha keep"]
  Png["png-seq: PNG frames in zip"]
  CapturePng["captureCompFramePng:\nPNG bytes"]

  ExportCall --> Offscreen --> Renderer --> Options --> RenderFrame
  RenderFrame --> FlushRaster --> FlushVideo --> Capture --> Output
  Output --> Mp4
  Output --> Webm
  Output --> Png
  Output --> CapturePng
```

Live preview との違い:

- `exportVideoStep=true` により、video 同期は `pause()` + frame-center target への決定論的 seek になる。
- `flushVideoFrames()` は seek / decode / present を待ってから capture し、その後 split / packed alpha canvas を再合成する。
- `compositeExportFrame()` は、条件に応じて root capture か z-order compositor を使う。adjustment layer、CSS blend、nested composite、3D 文脈が絡む場合は compositor 経路に入る。
- `rasterCapture.inlineExportMedia()` は、SVG `foreignObject` rasterize の前に live canvas を PNG data に、live `<video>` を現在フレームの静止画に置き換える。split / packed alpha の video 要素は直接 inline せず、合成済み canvas を inline する。
- mp4 は opaque。webm は `config.alpha` が true のとき VP9 `alpha: "keep"` で最終フレームの alpha を保持できる。PNG sequence は `config.alpha` が true のとき各 PNG が alpha を保持する。

## Alpha 付き動画の扱い

```mermaid
flowchart TD
  VideoComp["video component"]
  AssetMeta{"asset alpha metadata"}
  Normal["通常 video\n表示される <video> 1 本"]
  Split["split alpha\ncolor <video> + alpha <video>"]
  Packed["packed alpha\npacked <video> 1 本"]

  VideoComp --> AssetMeta
  AssetMeta -->|"alpha metadata なし"| Normal
  AssetMeta -->|"meta.alphaPath"| Split
  AssetMeta -->|"packed layout"| Packed

  Split --> SplitSync["2 本の video を同じ target へ同期\nplayback: alpha genlock rate\nexport: deterministic seek"]
  SplitSync --> SplitCanvas["compositeSplitAlpha\nRGB は color、A は alpha mask"]
  SplitCanvas --> SplitShow["color video を隠し\nalpha canvas を表示"]

  Packed --> PackedQuality{"quality selection"}
  PackedQuality -->|"preview / bundle"| PreviewProxy["preview quality / proxy tier"]
  PackedQuality -->|"exportStep"| ExportQuality["packedExportQuality\n(default original)"]
  PreviewProxy --> PackedCanvas
  ExportQuality --> PackedCanvas
  PackedCanvas["compositePackedAlpha\n1 本の video から color rect と mask rect を読む"]
  PackedCanvas --> PackedShow["packed video を隠し\nalpha canvas を表示"]
```

Alpha mode ごとの詳細:

| Mode | DOM / media の形 | Preview playback | Export / capture |
| --- | --- | --- | --- |
| 通常 video | 表示される `<video>` 1 本 | 再生中は native `play()`。停止 / scrub 中は muted seek | 決定論的 seek 後、現在フレームを画像として inline |
| split alpha | color `<video>` + hidden alpha `<video>` + canvas | 2 本を同じ target へ同期。必要に応じて alpha genlock rate 補正 | 2 本とも決定論的 seek。`flushVideoFrames` 後に canvas を再合成し、その canvas を capture |
| packed alpha | packed `<video>` 1 本 + canvas | media clock は 1 本だけなので companion / genlock は不要。preview は proxy quality を使える | 決定論 export では `packedExportQuality` を使える。capture 前に canvas を再合成 |

現時点の packed alpha は、`DomRenderer` 内では `<video>` ベースの経路を使っている。`src/runtime/packedFrameDecoder.ts` と `src/runtime/packedDemux.ts` には VideoDecoder ベースの preview decoder 実装があるが、このスナップショット時点では `DomRenderer` へ未配線。

## 経路差分の注意点

| 観点 | Preview | Browser export / compFrameCapture | HTML bundle |
| --- | --- | --- | --- |
| Scene resolution | expressions と editor-only `previewCamera` を渡した `resolve()` | expressions は渡すが preview camera override は渡さない | bundled runtime 内の `resolve()`。preview camera override は渡さない |
| Video time | 再生中は native `play()`。scrub / 停止中は muted frame-center seek | 常に `exportVideoStep=true`: pause + frame-center seek + present wait | 再生中は preview と同じ live playback model |
| Video warm-up / pooling | preview playback で有効 | 使わない | player-style playback で有効 |
| Alpha composition | render 中に split / packed canvas を更新。decode 未完了時は retry | `flushVideoFrames()` が待機し、capture 前に再合成 | preview と同じ live canvas 経路 |
| Adjustment / blend の export fidelity | 可能な限り live DOM / backdrop | `exportCompositeMode=true`。export-safe capture のため z-order canvas compositor | bundle export policy で bake されない限り live bundle playback |
| 最終 alpha | transparent comp の背後に checkerboard や black stage が見える場合がある | mp4 は opaque。webm / png-seq は alpha 保持可能 | host page 上の browser DOM transparency |

## コード対応表

| 領域 | ファイル |
| --- | --- |
| preview orchestration | `src/editor/panels/PreviewPanel.tsx` |
| 共通 DOM renderer と video alpha 分岐 | `src/runtime/DomRenderer.ts` |
| video seek / play 方針 | `src/runtime/videoElementSync.ts` |
| split alpha composition | `src/runtime/videoSplitAlpha.ts` |
| packed alpha composition | `src/runtime/videoPackedAlpha.ts` |
| browser export | `src/runtime/exporter.ts` |
| export / capture compositor | `src/runtime/exportComposite.ts` |
| SVG foreignObject capture と media inline | `src/runtime/rasterCapture.ts` |
| comp-frame capture / RAM / precomp raster input | `src/runtime/compFrameCapture.ts` |
| HTML bundle player | `src/player/BundlePlayer.ts` |
| packed VideoDecoder 作業中実装 | `src/runtime/packedFrameDecoder.ts`, `src/runtime/packedDemux.ts` |
