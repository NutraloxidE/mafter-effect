# モザイク（ブロックピクセレート）エフェクト 設計・実現可能性プラン

> **ステータス**: ドラフト（未承認）。本ファイルは `doc/mafter-effect-spec.md`（SSoT）を置き換えない。
> §5 データスキーマ・INVARIANT に触れる項目は **ユーザー承認が必須**（CLAUDE.md 運用体制）。結論から言うと、本エフェクトは **§5/INV 変更ゼロ**で実装可能（§5参照）。
> 作成日: 2026-07-06 / 対象ブランチ: `claude/shape-editing-design-plan-b58rmg`

---

## 0. TL;DR（先に結論）

- **「モザイク」は実装可能。ただし当初の見立てを2段階で訂正している** — ①最初に「liveでは構造的に不可能」と結論づけたが、レビュー時のユーザー指摘（displacementで網目状に潰す方式）を受けて撤回。②その後、その"live"方式が使う技法（`feImage`+`feDisplacementMap`）は実は既存の `wave`/`ripple`/`turbulentDisplace` が既に採用していて、かつ座標ドリフト回避のため**すべて `executionPath:"raster"`（自己ラスタライズ）**であることが判明したため、「正真正銘のlive」という主張も撤回した（§1.5）。**最終結論: 両方とも `raster` 実行経路だが、片方はJSでの真値計算、もう片方はブラウザネイティブのSVGフィルタ処理**、という構図。
- **3つの選択肢を検討**:
  - **選択肢A**: `raster` 実行経路・真のブロック平均化（`blockAverage()` 既存実装を流用）。**保証された正しさ**、DOM→canvasキャプチャ＋JS側ピクセルループを伴う。
  - **選択肢B**: 汎用SVGフィルタでの近似（非推奨・却下） — 手続き的マップを合成する既存SVG手法では `SourceGraphic` 自体をブロック平均化できない（§2.1）。
  - **選択肢C（ユーザー提案）**: `feDisplacementMap` で「各ブロック内の全ピクセルをブロック中心へ向けてグリッドスナップさせる」変位マップを流し込み、**最近傍サンプリングによる疑似モザイク**を作る。`wave`/`ripple`と同じ `raster`（自己ラスタライズ）実行経路で登録し、ピクセル処理自体はブラウザネイティブのSVGフィルタエンジンに任せる。
- **推奨**: 選択肢A（raster・JSでの`blockAverage`ループ）と選択肢C（raster・ネイティブSVGフィルタでのグリッドスナップ）を、`pixelSorter`/`pixelSortLite` と同型の「JS実装/ネイティブフィルタ実装」ペアとして両方設計する。DOM→canvasキャプチャのコスト自体はA・Cで同等だが、Cはキャプチャ後のピクセル処理をブラウザネイティブに任せるため**Aより軽い**見込み（§7「重さについて」参照）。

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

### 1.5 なぜ wave/ripple/turbulentDisplace は「live」ではなく「raster + 自己ラスタライズ」なのか

`.claude/skills/implement-visual-effect/SKILL.md` が明記する、このコードベースで実際に確認された不具合: **CSS `filter:`/`backdrop-filter:` を生DOM要素に直接適用し、それを `foreignObject` 経由でキャプチャする組み合わせには座標系ドリフトがある**。displacement量（strength）を上げるほど、内容の重心が本来の位置からズレていく——preview/exportの精度が要求される場面ではブラックボックスの合成に頼らず「自己ラスタライズ」（要素をcanvasへキャプチャ→そのラスタ画像に対してSVGフィルタを `<image filter="url(#...)">` として適用）に切り替えるべき、というのがこのコードベースの確立した知見（スキル本文 L43-52）。`wave`/`ripple`/`turbulentDisplace` は過去にこの問題を踏み、この対処で解決した実例そのもの。

**これは選択肢Cにとって重要**: `mosaicLite` が使う技法（`feImage`+`feDisplacementMap`）は、まさにこの「過去に一度liveで失敗し、rasterに直した」技法と同一系統。したがって選択肢Cを最初から「wave/rippleと同じ raster + 自己ラスタライズ構成」で設計すれば、**ゼロから座標ドリフトの検証をする必要がなく、既に確立済みの対処パターンをそのまま継承できる**（§8で詳述）。逆に、もし本当に「生DOM要素への直接CSS filter適用」として作ってしまうと、wave/rippleが最初に踏んだのと同じ座標ドリフトを再現するリスクが高い。

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

### 2.3 選択肢C（ユーザー提案・再検討の結果、有力）: `executionPath:"raster"`（wave/ripple型・自己ラスタライズ）、displacementによるグリッドスナップ

**原理**: `feDisplacementMap` は「出力ピクセルの位置ごとに、変位マップの値だけずらしてソースをサンプリングする」ため、変位マップを「ブロック内のどのピクセルも、そのブロックの中心点へ向かって引き戻す」鋸歯状（sawtooth/staircase）パターンにすれば、**ブロック内の全ピクセルが同じ代表点（ブロック中心）の色をサンプリングする**——実質的に最近傍サンプリングによるモザイクになる。ブロック平均ではなく代表点抽出だが、多くのリアルタイムシェーダ・ゲームエンジンの "pixelate" 実装（`floor(uv*blockCount)/blockCount` によるUVスナップ）と同じ原理であり、見た目上は十分「モザイク」として通用する。

**実装方法（§1.5を踏まえ訂正）**: `wave`/`ripple` と全く同じ構成——`executionPath:"raster"` として登録し、`apply()` は `{kind:"svg", primitives}` を返す。DomRendererの raster パイプラインが自動的に自己ラスタライズ（DOM→canvasキャプチャ→`rasterizeFilteredImage`でSVGフィルタ適用）を行う。**「live CSS filterとして直接適用する」という当初案は撤回する** — それはwave/rippleが最初に踏んで座標ドリフトを起こした構成そのものだから。
- マップの中身は `blockSize` 周期で反復する鋸歯状パターン。R/Gチャンネルに「ブロック中心へ向かう変位量」を符号化する。
- クリスプさの担保に `ditherDissolve` の `<pattern>` + `<rect>` ハードエッジタイル手法（なめらかなグラデーションではなく矩形セルの直接積み上げ）を流用する。

**メリット**:
- **座標ドリフトを最初から回避できる** — wave/ripple/turbulentDisplaceが既に確立した「raster + 自己ラスタライズ」構成をそのまま継承するため、ゼロから検証・対処する必要がない。
- 既存の displacement 系エフェクトのアーキテクチャ資産（`feImageLayer`固定座標、`userSpaceOnUse`フィルタ領域指定）をそのまま再利用できる。
- ブロックのピクセル処理自体はJSの手動ループではなくブラウザネイティブのSVGフィルタエンジン（多くの場合GPU処理）に任せられるため、選択肢Aの `blockAverage()`（JS配列走査）より**キャプチャ後の処理コストは軽い**見込み（§7）。

**デメリット/リスク（要実測）**:
- 真のブロック平均化ではなく代表点抽出のため、選択肢A（raster・JS真値）と厳密には一致しない（見た目は近い）。
- raster捕獲自体のコスト（DOM→canvasキャプチャ）は選択肢Aと同等に発生する（§7「重さについて」参照、「live＝捕獲なし」という当初のメリットは撤回）。
- ブロック境界のクリスプさは、wave/ripple同様の自己ラスタライズ構成であれば座標ドリフト問題は既に解決済みのパターンを継承するため大きな懸念は薄いが、変位マップ自体の解像度・アンチエイリアス設定は実装時に実測確認する（§5検証計画）。

### 2.4 結論

**選択肢A（raster・JSでの真値`blockAverage`）と選択肢C（raster・ネイティブSVGフィルタでのグリッドスナップ、wave/ripple型）を、`pixelSorter`/`pixelSortLite` と似た「JS実装/ネイティブフィルタ実装」ペアとして両方設計する方向を推奨する。**

- `mosaic`（`executionPath:"raster"`, `processPixels`でJS実装）— 真のブロック平均化、保証された正しさ。
- `mosaicLite`（`executionPath:"raster"`, `apply()`がSVGフィルタを返す・wave/ripple型）— displacementグリッドスナップ、キャプチャ後の処理をネイティブフィルタに任せるぶんAより軽量。命名は`pixelSortLite`に倣うが、実行経路は**どちらも`raster`**である点に注意（§8で訂正した通り、"live"という当初の触れ込みは撤回）。

どちらか一方のみでよい場合は、実装・検証コストの低さ（wave/ripple型の確立済みパターンをそのまま継承できる）を優先するなら `mosaicLite` から着手する順序も合理的。

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

### 3.2 選択肢C: `mosaicLite`（`EffectDef` 登録案、`wave` を雛形に — `executionPath:"raster"` に訂正）

```ts
const MOSAIC_LITE_EFFECT_DEF: EffectDef = {
  type: "mosaicLite",
  label: "Mosaic (Lite)",
  category: "スタイライズ",
  previewBakeRequired: false, // wave/ripple/turbulentDisplaceと同じ実績値
  executionPath: "raster", // wave/ripple/turbulentDisplaceと同型: SVGフィルタだがraster経路で自己ラスタライズされる
  params: [
    { key: "blockSize", label: "Block Size", kind: "scalar", default: 16, animatable: true, min: 2, max: 256 },
  ],
  apply(props, ctx) {
    return { kind: "svg", primitives: mosaicGridSnapFilter(props["blockSize"] as number, ctx) };
  },
};
```

`mosaicGridSnapFilter()`（新規、`effectSvg.ts` に追加）は次を生成する純関数:
1. `blockSize` 周期の鋸歯状パターンを `<pattern patternUnits="userSpaceOnUse">` + 矩形セル（`ditherPatternMaskSvg` と同系統の技法）で構築し、data URI 画像化。
2. `feImageLayer()` でレイヤー実座標に固定して読み込み、`feDisplacementMap`（`scale` は `blockSize` に比例）で `SourceGraphic` に適用。

`apply()` が `{kind:"svg", primitives}` を返す点は選択肢Aの `{kind:"raster"}` と異なるが、DomRendererの `runRasterPipeline` はどちらも同じ `rasterChain` として扱い、`effectRaster.ts` の `applyFilterChainToBuffer()`（`rasterizeFilteredImage` 経由）が自己ラスタライズ後のバッファへSVGフィルタを適用する——`wave`/`ripple`が既に通っている経路そのもの。

### 3.3 自動的に配線される箇所（両選択肢共通・変更不要と見込まれる）

- `effectChain.ts` の `resolveEffectChain()` — `live`/`raster` 双方を汎用的にバケット分け。
- `DomRenderer.ts` の `applyFilterTokens`（live）/ `runRasterPipeline`（raster）— 既存の汎用実装がそのまま動作。
- `src/editor/pipelineAnalysis.ts` の `hasRasterExecutionPath()` — `executionPath==="raster"||processPixels!==undefined` の汎用判定のため、`mosaic`/`mosaicLite` 両方が自動的にPipelineパネルでraster表示される。
- `InspectorPanel.tsx` のエフェクトピッカー — 両方とも `executionPath:"raster"` のため、Live調整レイヤー（`adjustmentMode:"live"`）選択時は**どちらもピッカーから除外される**（`wave`/`ripple`/`pixelSorter`と同じ扱い）。Raster調整レイヤーでは両方使用可能。
- Params は `ParamDescriptor.kind:"scalar"` の汎用UIでレンダリングされるため専用Inspector UIコード不要。

### 3.4 要検討・要追加

- `src/editor/effectCategories.ts` の固定順序リスト — 「スタイライズ」カテゴリ再利用なら変更不要。
- 選択肢A: Worker pool オフロード（現状 `pixelSorter` のみ対象）の要否は実測後判断。
- 選択肢C: 実装前にプロトタイプでブロック境界のクリスプさを実測（§2.3リスク参照）— 結果次第で "Lite" の名の通り近似品質として受け入れるか、追加のクリスプ化対策（変位マップの解像度を上げる、`feComponentTransfer` で階調を潰す等）を講じるか判断。

---

## 4. §5 / INV への影響サマリ

| 項目 | 影響 |
|---|---|
| §5 `EffectInstance` 型変更 | **なし**（`type: string` / `props: Record<...>` は既に任意のエフェクトを許容する開いた契約） |
| §5 `ParamKind`/`EffectDef` 型変更 | **なし**（`scalar` で `blockSize` を表現可能。`plugin.ts` の `EffectDef`/`EffectFilter`/`RasterBuffer` は既にlive/raster双方に汎用対応済み） |
| INV-1（resolve純粋性） | 影響なし。選択肢Aの `processPixels`、選択肢Cの `apply()`（変位マップ生成）ともに props のみに依存する純関数として実装可能 |
| INV-2（preview/export一致） | 選択肢A・Cとも既存raster経路の共有機構（normal-layer raster / adjustment raster / export合成が同一 `processPixels`/フィルタ適用を共有）により自動担保。選択肢Cはwave/ripple/turbulentDisplaceが既に確立した「raster + 自己ラスタライズ」構成をそのまま継承するため、座標ドリフト対策をゼロから検証する必要はない見込み（§1.5・§8） |
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

- **選択肢A・C いずれも**（§1.5で訂正した通り）`executionPath:"raster"` のため、毎フレーム DOM→canvas キャプチャという中間ステップを伴う。これは **project.json を書き換えるものではない**（=プロジェクトデータとしては非破壊）が、レンダリング経路上のスナップショットが挟まる、という意味では「完全にゼロ捕獲」ではない。
- 当初「選択肢Cは捕獲なしの正真正銘のlive」と説明したが、これは§1.5・§8で訂正した通り誤りだった。とはいえ**非破壊性（プロジェクトデータを書き換えない・キーフレーム/undo可能）という一番大事な性質は変わらず両方満たす**。

## 7. 重さ（パフォーマンス）について

「グリッドスナップ（選択肢C）は重いのか」という問いには、2つの軸で答える必要がある。

### 7.1 素のcompute cost（フィルタ自体の処理コスト）

`feDisplacementMap` 自体はブラウザネイティブの処理で、`wave`/`ripple`/`turbulentDisplace` が既に本番運用されている実績から見て、単体のコストは低い（GPU寄りの合成処理が多く、大きな懸念にはなりにくい）。

### 7.2 キャプチャコスト（§1.5の訂正を踏まえた実態）

当初「選択肢Cはraster捕獲が無いので選択肢Aより軽い」と説明したが、これは撤回する。§1.5で確認した通り、`wave`/`ripple`/`turbulentDisplace` は同じ `feImage`+`feDisplacementMap` 技法を使っていながら、座標ドリフト回避のため **`executionPath:"raster"`（DOM→canvas自己ラスタライズ）を採用している**。選択肢Cも同じ技法を使う以上、同じ理由で raster 経路に乗る可能性が高い。つまり:

- **選択肢A・Cとも、毎フレームのDOM→canvasキャプチャというコストは同程度発生する**（`frameRenderCache` によるフレーム単位のキャッシュも両者で同様に効く）。
- 「live＝捕獲なしだから軽い」という当初の見立ては誤りだったため撤回する。

### 7.3 キャプチャ後の処理コスト（ここがA/Cで実際に差がつく点）

キャプチャ後、実際にピクセルを加工する部分の実装方式が異なる:

- **選択肢A**: `processPixels` 内のJS `blockAverage()` — `Uint8ClampedArray` を手動でループ処理（O(width×height)、メインスレッド、`pixelSorter`以外はWorker pool未対応）。
- **選択肢C**: `apply()` が返すSVGフィルタ（`feDisplacementMap`）を、ブラウザの合成エンジン（多くの場合GPU支援）にそのまま処理させる。JS側のピクセルループが不要。

**結論**: 捕獲コストはA・Cで同等（撤回済み）。しかし**キャプチャ後の実処理コストは、JSの手動ループを要する選択肢Aより、ブラウザネイティブに任せられる選択肢Cのほうが軽い見込み**——特に大きな解像度のレイヤーや、`sortBlocks`のように小さい`blockSize`（＝ブロック数が多い）を指定した場合にこの差が効いてくる可能性がある。

### 7.4 開発・検証コストという意味の「重さ」

もう一つの「重さ」として、実装・検証にかかる工数がある。選択肢Cは wave/ripple が既に確立した「raster + 自己ラスタライズ」パターンをそのまま継承できるため、**座標ドリフト対策をゼロから発明する必要がない**（§1.5）——この意味では選択肢Aより検証コストが軽いとも言える。ただし `implement-visual-effect` スキルの計測駆動フレームワークによる実機検証（§5）は両者とも必須で、ここを省略コストと見なすことはできない。

---

## 8. オープン質問

- **Q1**: 選択肢A（raster・JS真値）と選択肢C（raster・ネイティブSVGフィルタ近似）の**両方**を実装するか、まず選択肢C（キャプチャ後コストが軽く、wave/ripple型の確立済みパターンを継承できる方）だけプロトタイプして品質を確認してから判断するか。
- **Q2**: ブロック形状は正方形限定でよいか（AE同様、水平/垂直別サイズは将来拡張）。
- **Q3**: 選択肢Cの境界クリスプさが実測で不十分だった場合、「それっぽい近似」として受け入れるか、追加のチューニング工数をかけるか、それとも選択肢A（JS真値）を正とし選択肢Cは見送るか。
- **Q4**: Worker pool オフロード（選択肢AのJS処理をメインスレッド外に逃がす最適化）を初期実装に含めるか、実測してから判断するか。

---

## 9. 参照

- `src/runtime/plugin.ts:37-70`（`EffectDef`/`EffectFilter`/`RasterBuffer` 契約）
- `src/runtime/builtinEffects.ts`（`PIXEL_SORTER_EFFECT_DEF`/`PIXEL_SORT_LITE_EFFECT_DEF`、`WAVE_EFFECT_DEF` を雛形として踏襲）
- `src/runtime/pixelSort.ts:202-236`（`blockAverage()` 既存実装）/ `test/pixelSort.test.ts:68-70`（ブロック均一性テスト）
- `src/runtime/effectSvg.ts:19-21`（`feImageLayer` 実座標固定）/ `effectSvg.ts:660-684`（`ditherPatternMaskSvg` ハードエッジタイル）/ `effectSvg.ts:697`（`feTile`不使用の明記コメント）
- `src/runtime/effectChain.ts`（`resolveEffectChain` 汎用live/raster振り分け）/ `src/runtime/DomRenderer.ts`（`runRasterPipeline`/`runAdjustmentRasterPipeline`）
- `.claude/skills/implement-visual-effect/SKILL.md`（計測駆動フレームワーク・displacement系ドリフト修正の実例）
- `doc/mafter-effect-spec.md` §27.1（raster効果の export フロー）/ §27.4（調整レイヤー live/raster）/ §27.10・§27.13（影響ファイル一覧の前例）
