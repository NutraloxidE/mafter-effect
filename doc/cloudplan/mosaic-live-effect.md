# モザイク（ブロックピクセレート）エフェクト 設計・実現可能性プラン

> **ステータス**: ドラフト（未承認）。本ファイルは `doc/mafter-effect-spec.md`（SSoT）を置き換えない。
> §5 データスキーマ・INVARIANT に触れる項目は **ユーザー承認が必須**（CLAUDE.md 運用体制）。結論から言うと、本エフェクトは **§5/INV 変更ゼロ**で実装可能（§5参照）。
> 作成日: 2026-07-06 / 対象ブランチ: `claude/shape-editing-design-plan-b58rmg`

---

## 0. TL;DR（先に結論）

- **「モザイク」は実装可能。見立てを3段階で訂正している（今回が最終版）**:
  1. 最初「liveでは構造的に不可能」と結論づけたが、ユーザー指摘（displacementで網目状に潰す方式）を受けて撤回。
  2. 次に「その技法（`feImage`+`feDisplacementMap`）は`wave`/`ripple`/`turbulentDisplace`が既に採用していて、全て`executionPath:"raster"`（自己ラスタライズ）」と分かり、「正真正銘のlive」という主張を撤回した。
  3. **さらに調査した結果、②の前提そのものが誤りだったと判明**: `wave`/`ripple`/`turbulentDisplace`が`raster`である理由は「liveでは原理的にドリフトする」からではなく、**単に「フィルタ領域の外側パディング帯が未定義値を返し、そこが定数変位として写り込んでいた」というバグ**だった（`doc/mafter-effect-spec.md:2719`）。フィルタ領域を レイヤーの実寸`(0,0,w,h)`ちょうどにクランプ（パディングなし）すれば、live CSS filterの重心ドリフトはraster版と**小数点2桁まで一致**することが実機計測（`verify-fast-drift-spike.mjs`）で証明済み。これが実際に`fastWave`/`fastRipple`/`fastTurbulentDisplace`が`executionPath:"live"`・raster捕獲ゼロで動いている仕組み（spec:2271, 2719, 2738）。
  → **最終結論: モザイクのグリッドスナップ版は、`fastTurbulentDisplace`と全く同じ仕組み・同じ軽さで正真正銘"live"にできる。** ただし変位マップ自体を「レイヤー全域で常に定義される」タイル状パターン（`<pattern>`、`feTurbulence`の`stitchTiles`と同じ発想）として作り、フィルタ領域を`(0,0,w,h)`にクランプする、という設計上の条件を満たす必要がある。
- **3つの選択肢を検討**:
  - **選択肢A**: `raster` 実行経路・真のブロック平均化（`blockAverage()` 既存実装を流用）。**保証された正しさ**、DOM→canvasキャプチャ＋JS側ピクセルループを伴う。
  - **選択肢B**: 汎用SVGフィルタでの近似（非推奨・却下） — 手続き的マップを合成する既存SVG手法では `SourceGraphic` 自体をブロック平均化できない（§2.1）。
  - **選択肢C（ユーザー提案・最終的に正真正銘の"live"と確認）**: `feDisplacementMap` で「各ブロック内の全ピクセルをブロック中心へ向けてグリッドスナップさせる」変位マップを流し込み、**最近傍サンプリングによる疑似モザイク**を作る。`fastWave`/`fastRipple`/`fastTurbulentDisplace`と同じ`executionPath:"live"`・raster捕獲ゼロで実装できる。
- **推奨**: 選択肢A（raster・JSでの`blockAverage`ループ、保証された正しさ）と選択肢C（live・ネイティブSVGフィルタでのグリッドスナップ、`fastTurbulentDisplace`同等の軽さ）を、`pixelSorter`/`pixelSortLite`と同型の「真値/軽量近似」ペアとして両方設計する。Cは選択肢Aと違いraster捕獲自体が発生しないため、**素で`fastTurbulentDisplace`と同じ重さ**になる見込み（§7「重さについて」参照）。

---

## 1. エフェクトアーキテクチャの現状（コード根拠）

### 1.1 `EffectDef` の2軸: `executionPath` と `previewBakeRequired`

`src/runtime/plugin.ts:56-70` の契約:

```ts
export interface EffectDef {
  type: string;
  label: string;
  category?: string;
  previewBakeRequired: boolean;      // 推論禁止・必ずリテラルで明示
  executionPath: "live" | "raster";  // 推論禁止・必ずリテラルで明示
  params: ParamDescriptor[];
  bundleExportDefault?: "live" | "bake";
  apply(props, ctx: EffectRenderCtx): EffectFilter | null; // 純関数
  processPixels?(input: RasterBuffer, props, ctx): RasterBuffer; // raster専用・純関数(INV-1)
}
```

`EffectFilter` は `{kind:"css"}` | `{kind:"svg", primitives}` | `{kind:"raster"}` の3種（`plugin.ts:37-40`）。

### 1.2 既存エフェクトの分布（`src/runtime/builtinEffects.ts`）

| type | category | executionPath | 備考 |
|---|---|---|---|
| `blur`/`tint`/`opticsCompensation`/`linearWipe`/`angularWipe`/`ditherDissolve` | 各種 | `live` | 純CSS/SVGフィルタチェーン |
| `wave`/`turbulentDisplace`/`ripple` | ディストーション | `raster` | displacement系。座標系ドリフト回避のため自前ラスタライズ（§1.4） |
| `pixelSortLite` | スタイライズ | `live` | ストリーク**近似**（真のピクセル並べ替えではない。spec 2411-2416で明記） |
| **`pixelSorter`** | スタイライズ | **`raster`** | **真のピクセル並べ替え**。`processPixels` で `pixelSort.ts` を呼ぶ |

`pixelSorter`/`pixelSortLite` の「同一見た目を raster=真値・live=近似」で2本立てにする前例は、モザイクの設計判断に直接使える。

### 1.3 ラスタ経路の実体（`DomRenderer.ts` 内 `runRasterPipeline`/`runAdjustmentRasterPipeline`）

`effectChain.ts` の `resolveEffectChain()`（純関数）が `effects[]` を走査し、`apply()` が `{kind:"raster"}` を返したものを `rasterChain` としてバケット分けする。`rasterChain.length > 0` の場合:

1. 対象 DOM 部分木（or 調整レイヤーなら背面バックドロップ）を `captureElementToCanvas`（foreignObject 経由、exporterと共有）でキャンバスへキャプチャ。
2. `canvasToRasterBuffer` で `Uint8ClampedArray` バッファ化。
3. `processRasterChainAsync` が各エフェクトの `processPixels(buffer, props, ctx)` を配列順に適用（`pixelSorter` のみ Worker pool へオフロード、他は現状メインスレッド同期実行）。
4. 結果をオーバーレイ `<canvas>` として提示、`frameRenderCache` にキャッシュ。

この経路は「通常レイヤーの raster エフェクト」「調整レイヤーの `adjustmentMode:"raster"`」「export 時の `exportComposite.ts` 合成」の3箇所すべてが同じ `processPixels` を呼ぶため、選択肢Aを乗せれば INV-2（プレビュー/エクスポート一致）はほぼ自動的に担保される。

### 1.4 SVGフィルタの既存資産（`effectSvg.ts`、950行）

- `feImage` を使い、手続き的な変位マップ（gradient / turbulence / 事前生成PNG）を data URI として `feDisplacementMap` に食わせる方式が `wave`/`ripple`/`turbulentDisplace` で確立済み（`feImageLayer()` ヘルパ、L19-21 — マップはレイヤーの実座標 `(0,0,w,h)` に固定、ドリフト防止の鉄則）。**重要**: これらは §1.2 の表のとおり `executionPath:"raster"` — つまりこのSVGフィルタは「ライブのDOM要素に直接 `filter:` として適用」ではなく、**`captureElementToCanvas` でDOM→canvasへ自己ラスタライズしたあと、`rasterizeFilteredImage`（`src/runtime/effectRaster.ts` の `applyFilterChainToBuffer()` 経由）でそのラスタ画像にSVGフィルタを適用**する構成。理由は次の §1.5 を参照。
- `<pattern patternUnits="userSpaceOnUse">` + `<rect>` セルによる**ハードエッジな繰り返しタイル**生成が `ditherPatternMaskSvg()`（L660-684）で確立済み（Bayer 8×8 / blue-noise 64×64）。なめらかなグラデーションPNGではなく矩形セルの直接積み上げなので、アンチエイリアスされないクリスプな境界を持つ。
- **`feTile`・`feFlood`・`feMorphology` はコードベースのどこにも未使用**（意図的な選択。`effectSvg.ts:697` に「wipeと同型のSVG filter primitives（`feTile`不使用）」と明記）。

### 1.5 wave/ripple/turbulentDisplace はなぜraster、fastWave/fastRipple/fastTurbulentDisplaceはなぜliveで済むのか（真因の訂正）

`.claude/skills/implement-visual-effect/SKILL.md` はCSS `filter:`＋`foreignObject`キャプチャの座標系ドリフト問題を警告しており、当初この文書でも「liveなdisplacementは原理的にドリフトするためraster必須」と説明した。**しかしspecの改訂履歴（`doc/mafter-effect-spec.md:2719`）を確認したところ、この理解は誤りだった。**

> 改定理由（旧 改定2 = 全経路 raster を覆す）: 旧版はかつての「未エフェクトの素矩形が右下に露出する」ドリフトを raster で隠していた。実機計測スパイク（`verify-fast-drift-spike.mjs`）で**真因は raster の有無ではなく filter region の pad 帯**と判明。`feImage` map は (0,0,w,h) 外で未定義 → pad 帯で channel≈0 → 定数 `−scale/2` 変位が内容を引きずる。raster は出力を W×H にクリップするので隠れていただけ。**region を (0,0,w,h) にクランプすると live CSS filter の centroid drift は raster と小数2桁まで一致**（3 effect × amount 0/50/100/155・turbulent含む）。よって Fast* は raster コスト（per-frame capture + readback）無しで同等のドリフト無しを達成できる。

つまり**真因は「liveであること」ではなく「フィルタ領域のパディング帯が未定義値（≈定数変位）を返すこと」**だった。`feImage`ベースの変位マップは指定した`(0,0,w,h)`の外側で未定義になるため、フィルタ領域をそれより広く取る（パディングを持たせる）と、パディング帯で一定の`-scale/2`変位がかかり続け、それがraster版では出力をW×Hにクリップすることで偶然隠れていただけ——という話。フィルタ領域を`(0,0,w,h)`ちょうどにクランプ（`svgDisplaceFilterMarkup(..., compFixed=true)`）すれば、live版もraster版と小数点2桁まで一致するドリフトの無さを達成できることが実機で証明されている（spec:2271, 2738: 「filter region は (0,0,w,h) クランプが正準」「live CSS filter 完結 displacement（raster capture 対象外）。Fast* + opticsCompensation」）。

`wave`/`ripple`/`turbulentDisplace`（フル版）が今もrasterのままなのは、この知見が判明する前からの構成を変える動機がなかった（フル版は`quality`パラメータや正確な正弦/同心円形状が要求されるため、そもそも精度面でrasterのままにする理由が別にある）だけであり、**「liveでは不可能」という技術的な壁ではない**。

**これは選択肢Cにとって重要**: `mosaicLite`のグリッドスナップ変位マップを「レイヤー全域で常に定義される」タイル状パターン（`<pattern patternUnits="userSpaceOnUse">`——`feTurbulence`の`stitchTiles`が生成域全体を埋めるのと同じ発想）として作り、フィルタ領域を`(0,0,w,h)`にクランプすれば、**`fastTurbulentDisplace`と全く同じ仕組みで、raster捕獲ゼロの正真正銘のliveエフェクトにできる**。§2.3で設計を更新する。

---

## 2. 実現可能性の検討過程（3つの選択肢）

### 2.1 選択肢B（非推奨・却下）: 汎用SVGフィルタ合成のみでの近似

既存の全SVGオンリーエフェクトは「手続き的なマップ」を `SourceGraphic` に**合成**しているだけで、`SourceGraphic` 自身の実ピクセル値を読んでブロック単位に置き換える（平均する）ものは一つもない。`feComposite operator="in"` はアルファでマスクするだけで、色を代表値に差し替えることはできない。**`SourceGraphic` の中身を「読んで」処理する一般的な合成手法は存在しない**ため、この方向での近似は却下する。

### 2.2 選択肢A: `executionPath:"raster"`、真のブロック平均化

- **アルゴリズムは実装済み・テスト済み**: `src/runtime/pixelSort.ts:202-236` の `blockAverage(buffer, blockSize)` — 指定 `blockSize × blockSize` の各ブロックについて R/G/B/A を合計し丸めた平均値を書き戻す。既に `test/pixelSort.test.ts:68-70` で「ブロック内が均一になる」ことをピン止め済み。
- 現状は `pixelSorter` エフェクトの `sortBlocks` パラメータ（AE Pixel Sort の "Sort Blocks" 相当）の前処理としてのみ間接的に使われている。
- **やること**: `blockAverage()` を共有ヘルパへ抽出（or そのままimport）し、`mosaic` という独立 `EffectDef` として `builtinEffects.ts` に登録するだけ。新規アルゴリズム開発が不要。
- **メリット**: 数学的に厳密（ブロック内は完全に同一色）。INV-2はraster経路の共有機構により自動担保。
- **デメリット**: 毎フレーム DOM→canvas キャプチャに加えJS側のピクセルループ（`blockAverage()`）を伴う（`frameRenderCache` で同一フレームの再計算は回避される。§7で選択肢Cとの処理コスト比較）。

### 2.3 選択肢C（ユーザー提案・fastTurbulentDisplace型と確認）: `executionPath:"live"`、displacementによるグリッドスナップ

**原理**: `feDisplacementMap` は「出力ピクセルの位置ごとに、変位マップの値だけずらしてソースをサンプリングする」ため、変位マップを「ブロック内のどのピクセルも、そのブロックの中心点へ向かって引き戻す」鋸歯状（sawtooth/staircase）パターンにすれば、**ブロック内の全ピクセルが同じ代表点（ブロック中心）の色をサンプリングする**——実質的に最近傍サンプリングによるモザイクになる。ブロック平均ではなく代表点抽出だが、多くのリアルタイムシェーダ・ゲームエンジンの "pixelate" 実装（`floor(uv*blockCount)/blockCount` によるUVスナップ）と同じ原理であり、見た目上は十分「モザイク」として通用する。

**実装方法（§1.5の真因訂正を踏まえた最終設計）**: `fastWave`/`fastRipple`/`fastTurbulentDisplace` と全く同じ構成——`executionPath:"live"` として登録し、`apply()` が返すSVGフィルタをDOM要素へ直接 `filter:` として適用する（raster捕獲は一切発生しない）。ドリフト回避に必要なのは以下の2点のみ（§1.5で判明した真因への対処）:
1. 変位マップを **`<pattern patternUnits="userSpaceOnUse">` によるレイヤー全域で常に定義されるタイル**として生成する（`ditherPatternMaskSvg`と同系統の技法だが、こちらは変位マップとして`feDisplacementMap`に渡す）。`feTurbulence`の`stitchTiles`が生成域全体を隙間なく埋めるのと同じ発想——「フィルタ領域のどこでも未定義値が出ない」ことが重要。
2. フィルタ領域を `svgDisplaceFilterMarkup(..., compFixed=true)` と同様に **レイヤー実寸`(0,0,w,h)`ちょうどにクランプ**する（パディングを持たせない）。

- マップの中身は `blockSize` 周期で反復する鋸歯状パターン。R/Gチャンネルに「ブロック中心へ向かう変位量」を符号化する。
- クリスプさの担保に `ditherDissolve` の `<pattern>` + `<rect>` ハードエッジタイル手法（なめらかなグラデーションではなく矩形セルの直接積み上げ）を流用する。

**メリット**:
- **`fastTurbulentDisplace`と同じ仕組みで、正真正銘のlive（raster捕獲ゼロ）**。DOM→canvasキャプチャという中間ステップが一切発生しないため、選択肢Aより明確に軽い（§7）。
- 座標ドリフトは「liveだから起きる」ものではなく「フィルタ領域パディング帯の未定義値」が真因（§1.5・spec:2719）。上記2条件を満たせば、raster版と小数点2桁まで一致するドリフトの無さが実機で証明済みの手法をそのまま継承できる。
- 既存の displacement 系エフェクトのアーキテクチャ資産（`feImageLayer`/`compFixed`固定座標、`userSpaceOnUse`フィルタ領域指定）をそのまま再利用できる。

**デメリット/リスク（要実測）**:
- 真のブロック平均化ではなく代表点抽出のため、選択肢A（raster・JS真値）と厳密には一致しない（見た目は近い）。
- 変位マップ自体を「レイヤー全域で常に定義される」タイルとして正しく構築できているか（§1.5の条件1）、フィルタ領域が正しく`(0,0,w,h)`にクランプされているか（条件2）は、`verify-fast-drift-spike.mjs`と同種の実機計測で個別に確認する必要がある——**理論上は解決済みの問題だが、モザイク固有の変位マップ形状で同じ結果になるかは実装時の検証が前提**。
- ブロック境界のクリスプさ（アンチエイリアス具合）は変位マップの解像度設定次第で実測確認する（§5検証計画）。

### 2.4 結論

**選択肢A（raster・JSでの真値`blockAverage`）と選択肢C（live・ネイティブSVGフィルタでのグリッドスナップ、`fastTurbulentDisplace`型）を、`pixelSorter`/`pixelSortLite`と同型の「真値/軽量近似」ペアとして両方設計する方向を推奨する。**

- `mosaic`（`executionPath:"raster"`, `processPixels`でJS実装）— 真のブロック平均化、保証された正しさ。DOM→canvasキャプチャを伴う。
- `mosaicLite`（`executionPath:"live"`, `apply()`がSVGフィルタを返す・fastTurbulentDisplace型）— displacementグリッドスナップ、raster捕獲ゼロで`fastTurbulentDisplace`と同等の軽さ。カテゴリは「スタイライズ（軽量）」または既存の「ディストーション（軽量）」に相乗り。

"軽さ"を優先するならCから着手するのが合理的——ただし§1.5の2条件（タイルの全域定義・フィルタ領域クランプ）を満たした実装になっているか、実機計測で個別に確認することが前提。

---

## 3. 設計詳細

### 3.1 選択肢A: `mosaic`（`EffectDef` 登録案、`pixelSorter` を雛形に）

```ts
const MOSAIC_EFFECT_DEF: EffectDef = {
  type: "mosaic",
  label: "Mosaic",
  category: "スタイライズ",
  previewBakeRequired: true,
  executionPath: "raster",
  params: [
    { key: "blockSize", label: "Block Size", kind: "scalar", default: 16, animatable: true, min: 1, max: 512 },
  ],
  apply() {
    return { kind: "raster" };
  },
  processPixels(input, props) {
    const blockSize = Math.max(1, Math.round(props["blockSize"] as number));
    if (blockSize <= 1) return input; // 恒等（blurのblurriness===0と同じ境界パターン）
    return blockAverage(input, blockSize);
  },
};
```

`blockAverage()` は `pixelSort.ts` から共有エクスポートするか、既存コードへの影響を避けるため新規 `mosaic.ts` に純関数として切り出し `pixelSort.ts`/`mosaic.ts` 両方から参照する（後者を推奨、既存の `pixelSorter` を触らずに済む）。

### 3.2 選択肢C: `mosaicLite`（`EffectDef` 登録案、`fastTurbulentDisplace` を雛形に — `executionPath:"live"`）

```ts
const MOSAIC_LITE_EFFECT_DEF: EffectDef = {
  type: "mosaicLite",
  label: "Mosaic (Lite)",
  category: "ディストーション（軽量）", // fastWave/fastRipple/fastTurbulentDisplaceと同カテゴリに相乗り
  previewBakeRequired: false, // fastWave/fastRipple/fastTurbulentDisplaceと同じ実績値
  executionPath: "live", // fastTurbulentDisplaceと同型: raster捕獲ゼロ、DOM要素へ直接filter適用
  params: [
    { key: "blockSize", label: "Block Size", kind: "scalar", default: 16, animatable: true, min: 2, max: 256 },
  ],
  apply(props, ctx) {
    return { kind: "svg", primitives: mosaicGridSnapFilter(props["blockSize"] as number, ctx) };
  },
};
```

`mosaicGridSnapFilter()`（新規、`effectSvg.ts` に追加）は §1.5 の2条件を満たす純関数として実装する:
1. `blockSize` 周期の鋸歯状パターンを `<pattern patternUnits="userSpaceOnUse">` + 矩形セル（`ditherPatternMaskSvg` と同系統の技法）で構築し、**レイヤー全域を隙間なくタイル**する（`feTurbulence`の`stitchTiles`が生成域全体を埋めるのと同じ役割）。
2. これを `feImageLayer()` でレイヤー実座標 `(0,0,w,h)` に固定して読み込み、`feDisplacementMap`（`scale` は `blockSize` に比例）で `SourceGraphic` に適用。
3. フィルタ全体を包む `<filter>` 要素は `svgDisplaceFilterMarkup(..., compFixed=true)` と同様、`x="0" y="0" width="${w}" height="${h}"` にクランプし、パディング帯を持たせない（§1.5の真因対処そのもの）。

`apply()` が `{kind:"svg", primitives}` を返す点は選択肢Aの `{kind:"raster"}` と異なり、かつ `executionPath:"live"` のため、DomRendererは通常のCSS `filter:` 適用経路（`applyFilterTokens`）にそのまま乗せる——`fastWave`/`fastRipple`/`fastTurbulentDisplace`が既に通っている経路そのもの。

### 3.3 自動的に配線される箇所（両選択肢共通・変更不要と見込まれる）

- `effectChain.ts` の `resolveEffectChain()` — `live`/`raster` 双方を汎用的にバケット分け。
- `DomRenderer.ts` の `applyFilterTokens`（`mosaicLite`はここ）/ `runRasterPipeline`（`mosaic`はここ）— 既存の汎用実装がそのまま動作。
- `src/editor/pipelineAnalysis.ts` の `hasRasterExecutionPath()` — `mosaic`（raster）のみ自動的にPipelineパネルでraster表示、`mosaicLite`（live）はlive表示。
- `InspectorPanel.tsx` のエフェクトピッカー — `mosaic`は`executionPath:"raster"`のためLive調整レイヤーのピッカーから除外（`wave`/`pixelSorter`と同扱い）。`mosaicLite`は`executionPath:"live"`のため**Live調整レイヤーでも選択可能**（`fastWave`等と同扱い）。
- Params は `ParamDescriptor.kind:"scalar"` の汎用UIでレンダリングされるため専用Inspector UIコード不要。
- `src/runtime/effectSvg.ts` の `DISPLACEMENT_EFFECT_TYPES`/`LIVE_DISPLACEMENT_EFFECT_TYPES`（L47-68）— `mosaicLite`をdisplacement系として`effectChain.ts`のフィルタ領域サイジング計算に含めるかは要検討（§1.5の条件を自前で満たすなら必須ではない可能性もあるが、既存displacement系との一貫性のため合流させるのが無難）。

### 3.4 要検討・要追加

- `src/editor/effectCategories.ts` の固定順序リスト — 「ディストーション（軽量）」カテゴリ再利用なら変更不要。
- 選択肢A: Worker pool オフロード（現状 `pixelSorter` のみ対象）の要否は実測後判断。
- 選択肢C: §1.5の2条件（タイルの全域定義・フィルタ領域`(0,0,w,h)`クランプ）を満たした実装になっているか、`verify-fast-drift-spike.mjs`と同種の実機計測で個別に確認する（§2.3リスク参照）。結果次第で "Lite" の名の通り近似品質として受け入れるか、追加のクリスプ化対策（変位マップの解像度を上げる、`feComponentTransfer` で階調を潰す等）を講じるか判断。

---

## 4. §5 / INV への影響サマリ

| 項目 | 影響 |
|---|---|
| §5 `EffectInstance` 型変更 | **なし**（`type: string` / `props: Record<...>` は既に任意のエフェクトを許容する開いた契約） |
| §5 `ParamKind`/`EffectDef` 型変更 | **なし**（`scalar` で `blockSize` を表現可能。`plugin.ts` の `EffectDef`/`EffectFilter`/`RasterBuffer` は既にlive/raster双方に汎用対応済み） |
| INV-1（resolve純粋性） | 影響なし。選択肢Aの `processPixels`、選択肢Cの `apply()`（変位マップ生成）ともに props のみに依存する純関数として実装可能 |
| INV-2（preview/export一致） | 選択肢Aは既存raster経路の共有機構（normal-layer raster / adjustment raster / export合成が同一`processPixels`を共有）により自動担保。選択肢Cは`fastWave`/`fastRipple`/`fastTurbulentDisplace`が既に確立した「フィルタ領域を`(0,0,w,h)`にクランプ」という手法（§1.5・spec:2719で実機証明済み）をそのまま継承すれば、live実行でもraster版と小数点2桁まで一致するドリフトの無さを達成できる見込み |
| INV-3（レンダラ非依存） | 影響なし。既存の live/raster パイプライン契約をそのまま踏襲 |
| `project.json` 直列化形式 | 変更なし（`EffectInstance.props` に `blockSize` が乗るだけ、既存の "additive props" パターン） |

**結論**: 本エフェクト（選択肢A・C いずれも）は CLAUDE.md の「勝手に進めず確認が必要」な3項目（INV変更・§5型変更・project.json直列化形式変更）のいずれにも該当しない。ゴーサインが出ればそのまま実装フェーズへ進める。

---

## 5. 検証計画

`.claude/skills/implement-visual-effect/SKILL.md` の計測駆動フレームワークに従う:

1. **unit**: 選択肢A — `blockAverage()`（既存テスト流用）+ `processPixels` 境界値（`blockSize=1`で恒等等）。選択肢C — 変位マップ生成関数の純関数テスト（`blockSize`ごとのマップ座標計算が正しいこと）。
2. **既存回帰**: `npm test` 全体・`effectCategories.test.ts`（新カテゴリ追加時のみ）・`effectRouting.test.ts`。
3. **実機Playwright（最重要・特に選択肢C）**: `blockSize` を4/16/64と振り、ブロック境界のシャープネスをスクリーンショット計測（ink centroid / エッジのコントラスト測定）で確認。displacement系で過去に起きた「strength比例のドリフト」が発生しないことを確認。既存 `verify-*` スクリプト（displacement系・adjustment raster系）の無回帰確認。
4. **export一致**: mp4/PNG連番/bundle export と preview を同一フレームで比較し `blockSize` によるブロック境界位置が一致することを確認（INV-2）。

---

## 6. 非破壊性について

選択肢A・Cとも、他の全エフェクトと同じく `EffectInstance`（`SceneObject.effects[]`）として保持される。**レイヤー本体の `Component.props`/`Transform` を一切書き換えない** — `blockSize` は `AnimatedProp` としてキーフレーム可能・undo可能、エフェクトのON/OFF切替・並べ替え・削除も自由。これは `wave`/`blur`/`pixelSorter` など既存の全エフェクトと全く同じ非破壊の担保であり、モザイクだからといって特別な配慮は不要。

ただし「レンダリングパイプライン上の中間捕獲」という別軸では両者に違いがある:

- **選択肢A**は`executionPath:"raster"`のため、毎フレーム DOM→canvas キャプチャという中間ステップを伴う。これは **project.json を書き換えるものではない**（=プロジェクトデータとしては非破壊）が、レンダリング経路上のスナップショットが挟まる。
- **選択肢C**は`executionPath:"live"`（§1.5・§7で確定）のため、この中間キャプチャすら発生しない——CSS `filter:` としてDOM要素に直接適用されるだけで、`resolve()`の出力から毎フレーム完全にライブ再計算される。「非破壊性」に加え「レンダリング経路上も最も"live"に近い」という性質を両方満たす。

## 7. 重さ（パフォーマンス）について

結論から言うと——**選択肢Cは`fastTurbulentDisplace`と全く同じ仕組みなので、同じ軽さになる**（§1.5で判明した真因訂正のとおり、raster自己ラスタライズは不要）。当初「選択肢Cもraster捕獲を伴うためAと同程度重い」と説明していたが、これは§1.5の調査不足による誤りだったため撤回する。

### 7.1 選択肢C: `fastTurbulentDisplace`と同格

`mosaicLite`が`fastWave`/`fastRipple`/`fastTurbulentDisplace`と同じ「`executionPath:"live"`・フィルタ領域`(0,0,w,h)`クランプ」構成で実装できる以上、**DOM→canvasキャプチャという中間ステップ自体が発生しない**。`feDisplacementMap`自体はブラウザネイティブ処理（GPU寄りの合成が多い）で、`fastTurbulentDisplace`が実運用されている実績から見ても単体コストは低い。つまり `mosaicLite` の重さは文字通り `fastTurbulentDisplace` と同格になる見込み——ユーザーが最初に聞いた「live turbulent displacementと同じくらい軽くするのは不可能？」への答えは **「不可能ではない、同格にできる」**。

### 7.2 選択肢A: raster捕獲＋JSループのぶん重い

- 毎フレーム DOM→canvas キャプチャ（`captureElementToCanvas`、foreignObject経由）というコストが発生する（`frameRenderCache`でフレーム単位のキャッシュは効く）。
- キャプチャ後の処理も `processPixels` 内のJS `blockAverage()` — `Uint8ClampedArray`を手動でループ処理（O(width×height)、メインスレッド、`pixelSorter`以外はWorker pool未対応）。
- 選択肢Cにはこの2つのコストがどちらも存在しない。**AはCより明確に重い**——ただし「保証された正しさ（真のブロック平均）」というAだけのメリットとのトレードオフ。

### 7.3 開発・検証コストという意味の「重さ」

選択肢Cは`fastWave`/`fastRipple`/`fastTurbulentDisplace`が既に確立した「フィルタ領域クランプ＋全域定義タイル」パターンをそのまま継承できるため、**座標ドリフト対策をゼロから発明する必要がない**（§1.5、`verify-fast-drift-spike.mjs`という実測手法も流用可）。ただし `implement-visual-effect` スキルの計測駆動フレームワークによる実機検証（§5）は、モザイク固有の変位マップ形状で本当に同じ結果になるかを確認するために必須で、ここを省略コストと見なすことはできない。

---

## 8. オープン質問

- **Q1**: 選択肢A（raster・JS真値・重いが厳密）と選択肢C（live・`fastTurbulentDisplace`同格の軽さ・近似）の**両方**を実装するか、"軽さ"を優先してまず選択肢Cだけプロトタイプ（§1.5の2条件を満たすことを実機計測で確認）してから判断するか。
- **Q2**: ブロック形状は正方形限定でよいか（AE同様、水平/垂直別サイズは将来拡張）。
- **Q3**: 選択肢Cのプロトタイプで§1.5の2条件（タイルの全域定義・フィルタ領域クランプ）を満たしてもなお境界クリスプさが不十分だった場合、「それっぽい近似」として受け入れるか、追加のチューニング工数をかけるか、それとも選択肢A（JS真値）を正とし選択肢Cは見送るか。
- **Q4**: Worker pool オフロード（選択肢AのJS処理をメインスレッド外に逃がす最適化）を初期実装に含めるか、実測してから判断するか。

---

## 9. 参照

- `src/runtime/plugin.ts:37-70`（`EffectDef`/`EffectFilter`/`RasterBuffer` 契約）
- `src/runtime/builtinEffects.ts`（`PIXEL_SORTER_EFFECT_DEF`/`PIXEL_SORT_LITE_EFFECT_DEF`を雛形として踏襲）/ `src/runtime/fastEffects.ts`（`FAST_TURBULENT_DISPLACE_EFFECT_DEF`、選択肢Cの直接の雛形）
- `src/runtime/pixelSort.ts:202-236`（`blockAverage()` 既存実装）/ `test/pixelSort.test.ts:68-70`（ブロック均一性テスト）
- `src/runtime/effectSvg.ts:19-21`（`feImageLayer`実座標固定）/ `effectSvg.ts:28-45`（`svgDisplaceFilterMarkup`・`compFixed`フィルタ領域クランプ）/ `effectSvg.ts:47-68`（`DISPLACEMENT_EFFECT_TYPES`/`LIVE_DISPLACEMENT_EFFECT_TYPES`）/ `effectSvg.ts:493-539`（`fastWaveDisplace`）/ `effectSvg.ts:660-684`（`ditherPatternMaskSvg`ハードエッジタイル）
- `src/runtime/effectChain.ts`（`resolveEffectChain` 汎用live/raster振り分け）/ `src/runtime/DomRenderer.ts`（`applyFilterTokens`/`runRasterPipeline`）
- `.claude/skills/implement-visual-effect/SKILL.md`（計測駆動フレームワーク）
- `doc/mafter-effect-spec.md:2130`（raster型一覧）/ `:2260-2271`（重心不変・フィルタ領域クランプが正準）/ `:2719`（**§1.5の真因訂正の一次資料** — `verify-fast-drift-spike.mjs`によるraster不要の実測証明）/ `:2738`（Fast*のPipeline UI扱い）
