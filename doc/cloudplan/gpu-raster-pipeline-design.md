# GPU Raster Pipeline — 具体実装計画（設計フェーズ / 実装前）

> 元ブリーフ: `gpurasterpipelineoptimizationideas1.md`（Opus 4.8 low への設計依頼）を、実在の symbol / call path と突き合わせて「そのまま着手できる粒度」へ落としたもの。
> **この文書は設計・計画であり、コードはまだ変更していない。** 着手は implementation-loop（spec 先行）に従い、Phase 単位でユーザー確認を挟む。
> 前提: `resolve()` / project schema / INV-1〜6 / Plugin API v1 は不変。GPU 化は「描画・キャッシュ・出力の実装詳細」に閉じる。

---

## 0. 調査サマリ（実コード確認済み・推測と分離）

以下はすべて実ファイルを読んで確認した**事実**。

### 現行のピクセル経路（confirmed）

| 経路 | 実体（symbol / file） | ピクセル処理の中身 |
|---|---|---|
| **preview live**（軽量 comp・大多数） | `DomRenderer.renderFrame` → `applyObject`（`src/runtime/DomRenderer.ts:1107`） | DOM/CSS のみ。`executionPath:"live"` effect は CSS/SVG `filter`・`backdrop-filter` を直付け。**ラスタ化しない**（最速） |
| **preview raster**（重い） | `DomRenderer.runRasterPipeline`（`DomRenderer.ts:1887`） | `captureElementToCanvas`（foreignObject）→ `canvasToRasterBuffer`（`getImageData`）→ `processRasterChainAsync`（CPU `processPixels`）→ `presentRasterCanvas`（`putImageData` オーバーレイ canvas） |
| **preview adjustment raster** | `DomRenderer.runAdjustmentRasterPipeline`（`DomRenderer.ts:1950`） | `captureAdjustmentBackdrop` → CPU chain → `putImageData` |
| **track matte（live）** | `scheduleTrackMatteCompose`（`DomRenderer.ts:791`）→ `composeTrackMatteToCanvas`（`trackMatteDom.ts`） | Canvas2D `destination-in/out`。正準純関数 `applyTrackMatte(RgbaBuffer)`（`trackMatteApply.ts:15`）は CPU per-pixel |
| **export composite**（mp4/webm/png/precomp） | `compositeExportFrame`（`exportComposite.ts:273`） | z 昇順で `master` Canvas2D に累積。レイヤ: `captureLayerNode`→foreignObject。blend: `mctx.globalCompositeOperation = blendModeToCompositeOp()` + `drawImage`。調整: `applyAdjustmentToMaster`（`getImageData`→CPU chain→`putImageData`） |
| **exporter loop** | `exporter.ts:203` / `encodeVideoFrames:398` | `renderFrame`→`flushRasterEffects`→`flushVideoFrames`→`compositeExportFrame`→ `createImageBitmap(canvas)`→`new VideoFrame(bitmap)`→`encoder.encode`→`backpressureEncoderQueue`（`encodeQueueSize` 監視） |
| **RAM preview / precomp raster / bundle bake** | `compFrameCapture.ts`（`createCompFrameCaptureContext` / `captureCompFramePng`） | オフスクリーン `DomRenderer` を `exportCompositeMode:true` で駆動し `compositeExportFrame` を共有 |
| **既存 WebGL** | `geom3d/geom3dGl.ts`（3D extrude text・`WeakMap<canvas,state>`）/ `videoAlphaGl.ts`（video alpha 合成・`MAX_GL_ALPHA_CONTEXTS=8`） | **どちらも per-layer context**。context-lost handler あり。Chrome の ~16 context 上限をページ全体で共有 |

### キャッシュ表現（confirmed）

- `frameRenderCache`（`FrameRenderCache` interface）の実体 `TieredFrameRenderCache`:
  - **L1 memory**: `Map<string, RasterBuffer>`（`RasterBuffer = {data:Uint8ClampedArray,width,height}` 生 RGBA）
  - **L2 disk**: `encodeRaster`/`decodeRaster` で**生 RGBA バイト**（PNG 圧縮ではない、ヘッダ + そのまま）
  - キー: `{objectId, frame:layer-local, propsHash:entry.fxSig}`（`DomRenderer.ts:1905`）

### effect の内訳（confirmed・`builtinEffects.ts`）

- `executionPath:"raster"`（CPU `processPixels` を持つ）＝ GPU 移行の主要対象: **`wave` / `turbulentDisplace` / `ripple` / `pixelSorter` / `mosaic`**。
- `executionPath:"live"`（CSS/SVG filter で完結・ラスタ不要）: blur / tint / posterize / chromaSplit / gradientMap / noiseGrain / hyperGlow / scanlines / opticsCompensation / linearWipe / angularWipe / ditherDissolve / pixelSortLite。
- `pixelSorter` は既に `globalRasterWorkerPool`（Worker）へオフロード済み（`rasterProcessAsync.ts:25`）。
- `EffectDef`（`plugin.ts:62`）: `executionPath:"live"|"raster"` と `kind` は**独立軸**（コメントで明示）。`processPixels?(RasterBuffer,...)` は CPU 契約。

### 主要ボトルネック（confirmed / 一部推測を明示）

1. **[confirmed] foreignObject capture の直列コスト**: `captureElementToCanvas`（`rasterCapture.ts:193`）は 1 レイヤあたり `canvas.toDataURL("image/png")`（inline）+ `XMLSerializer` + base64 SVG + `Image` decode + `drawImage` + `getImageData`。export の z 順経路ではこれが**レイヤ数ぶん**走る。
2. **[confirmed] `getImageData`/`putImageData` 往復**: `applyAdjustmentToMaster`（`exportComposite.ts:243`）と preview の `presentRasterCanvas`（`DomRenderer.ts:1859`）で master/overlay を CPU バッファに落として戻す。
3. **[confirmed] CPU per-pixel effect**: `processRasterChainAsync` → `processPixels`（mosaic/wave/ripple 等）が `Uint8ClampedArray` を走査。
4. **[confirmed] track matte CPU**: `applyTrackMatte` が per-pixel。live は Canvas2D compose。
5. **[推測・要 Phase 0 計測] blend 累積**: Canvas2D `globalCompositeOperation`+`drawImage` はブラウザ実装が GPU 化していることが多く、真のコストは「合成自体」より「**レイヤごとに個別 capture してシリアライズすること**」の可能性が高い。Phase 0 で切り分ける。
6. **[confirmed] per-layer WebGL context 圧**: geom3d + video alpha が per-layer context を消費し ~16 上限に張り付く（`DomRenderer.ts:2102` / `geom3dGl.ts:103` のコメントが実障害を記録）。**新規 compositor context はこの予算に必ず参加させる**。

---

## 1. 中核判断（Decision）

> **`DomRenderer` と foreignObject capture は残し、`exportComposite.ts` の z 順コンポジタと preview の raster overlay 合成を、共有 WebGL2 compositor を差し込める seam に置き換える。**
> 最初の GPU 化対象は「合成（transform/opacity/normal composite → matte → blend → adjustment）」であり、DOM capture は Phase A では foreignObject のまま。builtin raster effect の GPU 化はその後。HTML-in-Canvas 直接 capture は最後の optional。

理由（元ブリーフ §18 と一致・実コードで裏付け）:

- `compositeExportFrame` は既に**オフ DOM・ステートレス・z 昇順累積**で、GPU compositor の理想的な最初の宿主。既存の `ExportCompositeSource` interface（`getExportLayers` / `hasAdjustmentLayers` / …）がそのまま合成入力になる。
- preview の軽量 comp は live DOM のまま（元ブリーフ §10.1）。GPU compositor が効くのは **raster / blend / matte / adjustment を含む重い comp** だけ ＝ 回帰面が限定される。
- CPU 経路（`Canvas2DCompositor` として現行ロジックを包む）を parity/fallback の基準として常設 ＝ INV-2・非対応環境・context lost に耐える。

---

## 2. アーキテクチャ（責務境界と新 seam）

### 2.1 新規ディレクトリ `src/runtime/compositor/`

```
src/runtime/compositor/
 ├ RasterCompositor.ts     # interface + RasterSurface 型（CPU/GPU union）
 ├ Canvas2DCompositor.ts   # 現行ロジックを包む reference backend（Phase 1）
 ├ WebGL2Compositor.ts     # 共有 context・texture/FBO pool・shader passes（Phase 2+）
 ├ glContextBudget.ts      # videoAlphaGl の MAX_GL_ALPHA_CONTEXTS と統合した予算会計
 ├ glResourcePool.ts       # width×height×format×usage キーの texture/FBO/program pool
 └ shaders/                # normal / blend(15) / matte(4) / adjustment passthrough / builtin effects
```

### 2.2 型（public API に WebGLTexture を晒さない）

```ts
// RasterCompositor.ts — 内部専用。Plugin API v1 には出さない。
export type RasterSurface =
  | { kind: "cpu"; canvas: HTMLCanvasElement }          // 既存経路互換
  | { kind: "gpu"; texture: WebGLTexture; w: number; h: number; owner: WebGL2Compositor };

export interface CompositeLayer {
  surface: RasterSurface;         // capture 結果（foreignObject canvas or 直 texture）
  blendMode: BlendMode;
  opacity: number;                // straight alpha
  isAdjustment: boolean;
  exportChain: ExportChain | null;  // 既存型を再利用（exportComposite.ts:38）
  trackMatte?: { matte: RasterSurface; mode: TrackMatteMode } | null;
}

export interface RasterCompositor {
  beginFrame(w: number, h: number, bg: string): void;
  compositeLayer(layer: CompositeLayer): Promise<void>;   // 内部で matte→effect→blend
  getResult(): CanvasImageSource;    // preview present / VideoFrame / PNG readback の共通出力
  dispose(): void;
}
```

- `getResult()` は preview では visible WebGL canvas、export では `new VideoFrame(glCanvas)` の入力、PNG では `readPixels` の対象を返す**唯一の出口**（元ブリーフ §5.3・§7）。
- `ExportChain` / `ExportLayer` / `NestedCompositeMeta`（`exportComposite.ts`）は**そのまま流用**。新しい合成入力型は作らない。

### 2.3 fallback rule（確定）

| 条件 | backend |
|---|---|
| WebGL2 生成失敗 / context lost 中 / tainted source / 対応外 CSS | `Canvas2DCompositor`（＝現行 `compositeExportFrame` の逐次ロジック） |
| chain 内に GPU 実装の無い raster effect が1つでもある | **その chain は CPU（案A・§7）**。合成自体は GPU 継続可 |
| それ以外（raster/blend/matte/adjustment を含む重い comp） | `WebGL2Compositor` |
| 軽量 comp（raster/blend/matte/adjustment 無し） | **従来どおり live DOM / 単一 foreignObject**（compositor を通さない） |

---

## 3. execution backend 軸の導入（executionPath は変更しない）

元ブリーフ §4.2 を厳守。`executionPath:"live"|"raster"` に `"webgl"` を**足さない**。

代わりに **engine-private な GPU 実装レジストリ**を別に持つ（Plugin API v1 非破壊・serialize しない）:

```ts
// compositor/gpuEffectRegistry.ts（新規・engine 内部）
export interface GpuEffectPass {
  type: string;                          // builtin effect type と一致
  render(gl: WebGL2RenderingContext, src: WebGLTexture, dst: WebGLFramebuffer,
         props: Record<string, unknown>, ctx: EffectRenderCtx): void;
}
const gpuEffectPasses = new Map<string, GpuEffectPass>();
```

- builtin effect は **CPU `processPixels`（reference・不変）＋ engine-private `GpuEffectPass`（任意）** の二本立て。
- third-party plugin v1 は CPU `processPixels` のまま（GPU 版は将来 capability として別設計）。
- どの effect が GPU 可能かは `gpuEffectPasses.has(type)` で判定。`EffectDef` には触らない。

---

## 4. 最小導入フェーズ（symbol / 受け入れ / rollback 付き）

各 Phase は独立に revert 可能。**既存 verify を緑に保ったまま**進める。

### Phase 0 — 計測（コード変更なし）

- **やること**: 代表 comp（§8 fixture A〜G）で `compositeExportFrame` / `runRasterPipeline` / `captureElementToCanvas` / `processRasterChainAsync` の実時間を `performance.now()` で区間計測（一時 instrumentation、コミットしない）。
- **切り分け対象**: capture(foreignObject serialize+decode) vs getImageData/putImageData vs CPU effect vs blend drawImage の比率。特に §0-5（blend の真のコスト）を確定。
- **成果物**: `doc/cloudplan/gpu-raster-bench-phase0.md`（現状 flame・ボトルネック表・優先順）。
- **受け入れ**: 数値がそろい、Phase 2 の投資対効果が定量化される。
- **rollback**: instrumentation を捨てるだけ。

### Phase 1 — seam 抽出（挙動 byte 不変）✅ 実装済み（2026-07-17）

> **実装記録**: `src/runtime/compositor/RasterCompositor.ts`（interface）+ `Canvas2DCompositor.ts`（reference backend）を新設。`exportComposite.ts` の `compositeExportFrame` / `compositeContainer` の master 累積 + `applyAdjustmentToMaster` を compositor へ移設（同一 Canvas2D オペレーション・同順）。capture 系（`captureLayerNode` / perspective / nested 再帰）は据置き。検証: `bench-gpu-raster-parity.mjs`（`captureCompFramePng` の golden pixel-hash）で **全フレーム byte-identical PASS**、`npx tsc --noEmit` 緑、vitest 1311/1312（唯一の fail `effects.test.ts liquidChrome 再登録` は既存・無関係）、`playerBuildFreshness` 緑（exportComposite は player 非 import のため build:player 不要）。diff は exportComposite.ts −51/+10 + 新規 2 ファイルのみ。


- **変更 symbol**:
  - `exportComposite.ts` の `compositeExportFrame` を、`RasterCompositor` 経由に**内部リファクタ**。既存の逐次ロジックを `Canvas2DCompositor` にそのまま移設（`makeCanvas`/`blendModeToCompositeOp`/`drawImage`/`applyAdjustmentToMaster` を backend メソッド化）。
  - `ExportCompositeSource` はそのまま。呼び出し側（`exporter.ts` / `compFrameCapture.ts`）は無変更。
- **不変**: `resolve()` / schema / effect semantics / 出力ピクセル。
- **受け入れ**:
  - `npm test`（`blendMode.test.ts` / `trackMatte.test.ts` / `adjustmentMode.test.ts` / `exportVideoEncode.test.ts` / `rasterCapture.test.ts`）緑。
  - `verify-blend-mode.mjs` / `verify-export-adjustment.mjs` / `verify-track-matte.mjs` の実チェック値が**現状と一致**（byte parity）。
  - **新規** `test/compositorParity.test.ts`: 同一入力レイヤ列に対し `Canvas2DCompositor` の出力が現行 `compositeExportFrame` とピクセル完全一致。
- **rollback**: `compositeExportFrame` を単一関数へ戻す（内部リファクタなので diff 局所）。

### Phase 2 — WebGL2 Compositor（capture は foreignObject のまま）

- **変更 symbol / 新規**:
  - `WebGL2Compositor.ts`: 共有 context 1つ、`glResourcePool`（texture/FBO/program）、normal composite（transform/opacity/crop）を実装。
  - 入力: `captureLayerNode` が返す `HTMLCanvasElement` → `texImage2D`（Phase A は canvas 経由 upload）。
  - `glContextBudget.ts`: `videoAlphaGl.MAX_GL_ALPHA_CONTEXTS` と**同じページ全体予算**に compositor context を登録（geom3d/alpha と食い合って ~16 上限を超えない）。生成不可なら `Canvas2DCompositor` へ。
  - context lost/restored: `videoAlphaGl.ts:228` の handler パターンを踏襲し、resource 再生成 + preview は CPU fallback / export は明示エラー。
- **不変**: DOM capture 経路、`resolve()`、blend/matte/adjustment はまだ CPU（Phase 3 で移す）。まず **normal composite のみ** GPU。
- **受け入れ**:
  - fixture A（軽量）が**回帰しない**（compositor を通さない経路のまま）。
  - fixture B（多レイヤー normal composite）で GPU 経路のピクセルが CPU backend と許容差内（§6 の許容差）。
  - GPU/CPU 切替が feature flag（`window.__mafterGpuCompositor` 等・serialize しない dev flag）で可能。
  - context 数がレイヤ数に比例しない（budget 計測で確認・INV 受け入れ §6）。
- **rollback**: feature flag off で全経路 `Canvas2DCompositor`。

### Phase 3 — matte / blend / adjustment を GPU へ

- **変更 symbol / shader**:
  - **matte**: `applyTrackMatte`（`trackMatteApply.ts`）を reference に、fill+matte 2 texture の single-pass shader（alpha/luma × inverted の 4 モード）。live の `composeTrackMatteToCanvas` は GPU 経路のとき compositor に委譲。
  - **blend**: 15 種（`blendCompose.ts` の `CSS_BLEND_SET`）を master texture + layer texture の shader に。**色空間・premultiplied alpha・丸めを shader で明示**（§6 リスク）。
  - **adjustment**: `applyAdjustmentToMaster`（`exportComposite.ts:243`）の `getImageData`→chain→`putImageData` を master texture への FBO ping-pong pass に。pre CSS/SVG filter → raster chain → post の順を維持。CSS/SVG filter 部分（`applyFilterChainToBuffer`）は GPU 実装が無い間は当該 chain を CPU にフォールバック（§7 案A）。
- **不変**: z 順ステートレス合成規則、preview↔export 合成順。
- **受け入れ**:
  - `verify-track-matte.mjs` / `verify-blend-mode.mjs` / `verify-export-adjustment.mjs` が GPU 経路で許容差内 PASS、CPU 経路は byte 不変。
  - nested comp（`compositeContainer` 再帰）の parity を含む（fixture E）。
- **rollback**: matte/blend/adjustment を個別 flag で CPU backend に戻す（passes は独立）。

### Phase 4 — builtin GPU effects（CPU reference は残す）

- **対象順**（shader 化しやすさ×コスト）: `mosaic` → `tint`（color matrix・現状 live だが GPU 化容易）→ `wave`/`ripple`/`turbulentDisplace`（displacement）→ blur。`pixelSorter` は Worker のまま（GPU 化は後回し）。
- **変更**: `compositor/gpuEffectRegistry.ts` に `GpuEffectPass` を登録。`processRasterChainAsync` の GPU 版 `processRasterChainGpu`（chain 全 effect が GPU 可なら FBO ping-pong で連結、1つでも欠ければ CPU 全落ち＝§7 案A）。
- **不変**: `EffectDef.processPixels`（CPU）は reference として全 effect 分残す。`executionPath` 不変。
- **受け入れ**: effect ごとに GPU/CPU pixel parity と許容差を定義（`test/gpuEffectParity.test.ts`）。既存 displacement 系 verify が無回帰。
- **rollback**: `gpuEffectPasses` を空にすれば全 effect CPU。

### Phase 5 — preview / export 統合（readback 排除）

- **変更 symbol**:
  - export: `encodeVideoFrames`（`exporter.ts:398`）の `compositeExportFrame`→`createImageBitmap`→`VideoFrame` を、GPU 経路では `new VideoFrame(compositor.getResult() /* gl canvas */)` に短絡（`createImageBitmap` 中間を排除）。
  - preview: 重い comp は compositor の visible WebGL canvas を preview へ提示。`presentRasterCanvas` の `putImageData` を GPU 経路では使わない。
  - **`readPixels` は PNG 連番 / parity test / debug / CPU plugin bridge / 非対応 fallback に限定**（元ブリーフ §7.1）。PNG は `canvasToPngBytes` の前段でのみ readback。
  - backpressure: `backpressureEncoderQueue`（`exporter.ts:719`・`encodeQueueSize`）は維持。
- **不変**: preview↔export の合成順・clock 差のみ（元ブリーフ §11.1）。
- **受け入れ**: preview 中に `readPixels` が発生しない（instrumentation で 0 回）。export fps が Phase 0 比で改善。abort / resource cleanup（`AbortSignal` 経路）で GPU resource がリークしない。
- **rollback**: flag off で従来 `createImageBitmap`/`putImageData` 経路。

### Phase 6 —（optional・保留）Experimental Direct DOM Capture

- capability detection のうえ HTML-in-Canvas 系で DOM child を直接 texture 化する adapter を `DomCaptureBackend` の背後に追加。foreignObject との parity/速度比較。**canonical path の必須条件にしない。** 非対応は自動で foreignObject fallback。
- **判定タイミング**: Phase 2〜5 の計測で「capture 自体が支配的」と確定し、かつ対応ブラウザ比率が十分なときのみ着手。

### Phase 7 —（保留）Worker / OffscreenCanvas

- Phase 2〜6 の実測後のみ判断。DOM capture は main thread 固定、compositor/encode 準備の worker 移設が transfer コストを上回るときだけ。

---

## 5. 不変条件への影響

| INV | 影響と担保 |
|---|---|
| **INV-1**（`resolve` 純関数） | 無変更。GPU は `ResolvedScene` を受けた後段のみ。乱数・DOM・network を resolve に混ぜない |
| **INV-2**（preview≡export≡headless の scene 解決一致） | scene 解決値は不変。合成は CPU/GPU で**同じ順序・同じ semantics**。GPU/CPU parity test をゲート化。`compFrameCapture`（RAM/precomp/bundle）も同一 compositor 共有 |
| **INV-3**（型はレンダラ非依存） | `SceneObject`/`Composition`/Keyframe に GPU resource を混ぜない。`RasterSurface`/texture は runtime 内部型 |
| **INV-4**（Fs パス一致） | 無関係（描画層のみ） |
| **INV-5**（整数 Frame 正準） | 無変更 |
| **INV-6**（stable ID 参照） | 無変更 |
| **preview≡export** | Phase 1 の `Canvas2DCompositor` を常設 reference にし、GPU は許容差ゲート越えでのみ有効化 |
| **project serialization** | backend 情報を `project.json` に**保存しない**（元ブリーフ §4.1・§14） |
| **Plugin API v1** | `EffectDef.processPixels(RasterBuffer)` / `executionPath` 不変。GPU は engine-private レジストリに隔離 |

> **要ユーザー確認（CLAUDE.md 運用体制）**: 本計画は INV 追加・§5 型変更・`project.json` 形式変更を**含まない**ため、実装着手のたびに spec 散文更新のみで進められる。ただし `RasterSurface` 等の内部型を §5 に載せる/載せないの判断、および将来 GPU plugin capability を公開する段は**必ず事前確認**。

---

## 6. リスクと対策

| リスク | 対策 |
|---|---|
| **pixel parity**（GPU≠CPU） | effect/合成ごとに許容差（例: 各 ch 絶対差 ≤2/255、変更面積比しきい値）を test で固定。verify script は既存の実測値ゲートを流用 |
| **premultiplied alpha** | capture canvas は straight alpha。texture upload/合成で premultiply 規約を shader コメントに明記し統一（`geom3dGl.ts` の `premultipliedAlpha:true` と混同しない） |
| **color space** | CSS/Canvas2D は sRGB。`applyFilterChainToBuffer` は `color-interpolation-filters="sRGB"`（`effectRaster.ts:48`）。shader も sRGB 空間で合成（linear 変換しない）して既存と一致させる |
| **texture memory** | `glResourcePool` を `width×height×format×usage` キーで再利用、frame 終了で返却。peak を §8 で計測 |
| **context lost** | `videoAlphaGl.ts` の handler パターン踏襲。preview は CPU fallback、export は明示エラー or 安全再試行 |
| **cross-origin / tainted** | 検出したら当該レイヤ/frame を CPU fallback（`captureElementToCanvas` は既に data: URL 化で tainted 回避済み・この不変を壊さない） |
| **video/canvas upload** | 既存 `inlineExportMedia`（canvas→toDataURL / video→JPEG）を維持し、その結果 canvas を texture 化。geom3d/alpha の per-layer context と compositor context の**予算合算**を必須にする |
| **experimental API**（Phase 6） | adapter の内側に封じ込め、無効でも Phase 1〜5 で機能成立 |
| **per-layer WebGL 枯渇** | compositor は **1 context**。budget 会計に登録。レイヤ数比例で増えないことを INV 受け入れ §6 で検証 |

---

## 7. CPU/GPU Hybrid の初期規則（案A 採用）

- **初期版は §12 案A**: chain 内に GPU 実装の無い raster effect が1つでもあれば、**その effect chain 全体を CPU** で実行（`processRasterChainAsync` のまま）。合成（matte/blend/adjustment 累積）自体は GPU 継続可。
- 案B（GPU→CPU→GPU bridge）/ 案C（raster boundary split + cache）は**初期スコープ外**。過剰な graph scheduler は入れない（元ブリーフ §12 末尾）。
- Phase 4 で GPU effect が増え、実 chain の混在頻度が計測で見えたら案C の boundary cache を検討（別 Phase・別確認）。

---

## 8. ベンチマーク計画

### fixture（`verify-gpu-*.mjs` として新規・外部 zip 非依存の synthetic project）

| ID | 内容 | 成功基準 |
|---|---|---|
| **A 軽量 DOM** | solid/text/image・effect 無し | live DOM 経路のまま。**遅くならない**（compositor を通さない証明） |
| **B 多レイヤー** | 20〜50 layers・opacity/transform anim・複数 blend | GPU 合成が CPU 比で frame time 改善、parity 許容差内 |
| **C track matte** | alpha/luma・animated fill+matte・1080p/4K | matte shader が `applyTrackMatte` と許容差内、readback なし |
| **D raster effect** | mosaic/wave/displacement・chain | GPU effect が CPU reference と許容差内、chain 混在で案A 動作 |
| **E adjustment** | 複数 adjustment・前後 blend・nested precomp 内 adjustment | ping-pong parity、`compositeContainer` 再帰 parity |
| **F 混在** | video / geom3d WebGL canvas / DOM text / HTML comp | context 予算内で全描画、古い context 破棄なし |
| **G export** | 5s/30fps・1080p/4K・mp4/webm・PNG 連番 | export fps 改善、`encodeQueueSize` 発散なし、PNG のみ readback |

### 計測点（Phase 0 と共通 instrumentation）

`resolve` / DOM update / DOM settle+capture / texture upload / effect passes / composite / present / cache lookup / encode queue。
記録値: average・p95 frame time / capture time / upload time / GPU pass count / texture alloc count / **context count** / peak CPU mem / est GPU mem / export fps / parity diff / dropped preview frames。

### 成功基準（元ブリーフ §16 受け入れ）

1. `resolve()`/schema 不変 2. 非対応で従来経路へ 3. 軽量 comp 無回帰 4. 重い raster comp で測定可能改善 5. preview 中 `readPixels` ゼロ 6. context がレイヤ数比例しない 7. frame ごとの GPU resource リーク無し 8. CPU plugin 混在 chain 規則明確（案A）9. preview↔export 合成順一致 10. nested/blend/matte/adjustment の parity 戦略あり 11. context lost / export abort cleanup 定義済み 12. 実験 API 無効でも成立。

---

## 9. やらないこと（非目標・元ブリーフ §14 準拠）

- HTML/CSS layout engine の WebGL 再実装 / `DomRenderer` 廃止 / `resolve()` の GPU 化。
- `project.json` への backend 保存。全 effect の一括 GPU 化。WebGPU 必須化。
- Plugin API v1 の破壊。HTML-in-Canvas への全面依存。
- 汎用 render graph / ECS / node graph の導入。preview/effect/export cache の全面統合。
- 既存 headless canonical export の削除。**既存テスト/verify を消して通す案は禁止。**

---

## 10. 「今すぐ着手すべき最小単位」

**Phase 0（計測）→ Phase 1（`Canvas2DCompositor` seam・byte 不変）** の 2 つ。

- Phase 1 は挙動を一切変えずに、以降の GPU backend を差し込める seam を作るだけ ＝ リスク最小・rollback 容易・parity test で保護。
- Phase 2 以降（実 GPU 化）は Phase 0 の数値で投資対効果を確認してから、ユーザー確認のうえ着手する。

**保留**: Phase 6（HTML-in-Canvas）・Phase 7（Worker）・§7 案B/C。WebGL2 が primary、WebGPU は現時点で対象外（必須化しない）。
