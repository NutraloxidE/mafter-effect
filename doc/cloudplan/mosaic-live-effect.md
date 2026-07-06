# モザイク（ブロックピクセレート）エフェクト 設計・実現可能性プラン

> **ステータス**: ドラフト（未承認）。本ファイルは `doc/mafter-effect-spec.md`（SSoT）を置き換えない。
> §5 データスキーマ・INVARIANT に触れる項目は **ユーザー承認が必須**（CLAUDE.md 運用体制）。結論から言うと、本エフェクトは **§5/INV 変更ゼロ**で実装可能（§5参照）。
> 作成日: 2026-07-06 / 対象ブランチ: `claude/shape-editing-design-plan-b58rmg`

---

## 0. TL;DR（先に結論）

- **「モザイク」は実装可能。しかも "live"（CSS/SVGフィルタのみ・raster捕獲なし）で実現できる有力な方式がある** — 当初「liveでは構造的に不可能」と結論づけたが、レビュー時のユーザー指摘（displacementで網目状に潰す方式）で再検討し、撤回・更新した。
- **3つの選択肢を検討**:
  - **選択肢A**: `raster` 実行経路・真のブロック平均化（`blockAverage()` 既存実装を流用）。**保証された正しさ**、ただし raster 捕獲を伴うため厳密には "live" ではない。
  - **選択肢B**: 汎用SVGフィルタでの近似（非推奨・却下） — 手続き的マップを合成する既存SVG手法では `SourceGraphic` 自体をブロック平均化できない（§2.1）。
  - **選択肢C（ユーザー提案・再検討の結果、有力）**: `feDisplacementMap` で「各ブロック内の全ピクセルをブロック中心へ向けてグリッドスナップさせる」変位マップを流し込み、**最近傍サンプリングによる疑似モザイク**を作る。これは正真正銘の "live"（raster捕獲なし）で、`wave`/`ripple`（手続き的変位マップ+`feDisplacementMap`）と `ditherDissolve`（`<pattern>`によるハードエッジタイル生成）という**既存の2つの実装資産をそのまま組み合わせるだけ**で作れる。
- **推奨**: 選択肢A（raster・真値）と選択肢C（live・グリッドスナップ近似）を、`pixelSorter`/`pixelSortLite` と同型の「真値/近似」ペアとして両方設計する。ユーザーが元々求めていた"live"という性質は選択肢Cが正面から満たす。

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

- `feImage` を使い、手続き的な変位マップ（gradient / turbulence / 事前生成PNG）を data URI として `feDisplacementMap` に食わせる方式が `wave`/`ripple`/`turbulentDisplace` で確立済み（`feImageLayer()` ヘルパ、L19-21 — マップはレイヤーの実座標 `(0,0,w,h)` に固定、ドリフト防止の鉄則）。
- `<pattern patternUnits="userSpaceOnUse">` + `<rect>` セルによる**ハードエッジな繰り返しタイル**生成が `ditherPatternMaskSvg()`（L660-684）で確立済み（Bayer 8×8 / blue-noise 64×64）。なめらかなグラデーションPNGではなく矩形セルの直接積み上げなので、アンチエイリアスされないクリスプな境界を持つ。
- **`feTile`・`feFlood`・`feMorphology` はコードベースのどこにも未使用**（意図的な選択。`effectSvg.ts:697` に「wipeと同型のSVG filter primitives（`feTile`不使用）」と明記）。

---

## 2. 実現可能性の検討過程（3つの選択肢）

### 2.1 選択肢B（非推奨・却下）: 汎用SVGフィルタ合成のみでの近似

既存の全SVGオンリーエフェクトは「手続き的なマップ」を `SourceGraphic` に**合成**しているだけで、`SourceGraphic` 自身の実ピクセル値を読んでブロック単位に置き換える（平均する）ものは一つもない。`feComposite operator="in"` はアルファでマスクするだけで、色を代表値に差し替えることはできない。**`SourceGraphic` の中身を「読んで」処理する一般的な合成手法は存在しない**ため、この方向での近似は却下する。

### 2.2 選択肢A: `executionPath:"raster"`、真のブロック平均化

- **アルゴリズムは実装済み・テスト済み**: `src/runtime/pixelSort.ts:202-236` の `blockAverage(buffer, blockSize)` — 指定 `blockSize × blockSize` の各ブロックについて R/G/B/A を合計し丸めた平均値を書き戻す。既に `test/pixelSort.test.ts:68-70` で「ブロック内が均一になる」ことをピン止め済み。
- 現状は `pixelSorter` エフェクトの `sortBlocks` パラメータ（AE Pixel Sort の "Sort Blocks" 相当）の前処理としてのみ間接的に使われている。
- **やること**: `blockAverage()` を共有ヘルパへ抽出（or そのままimport）し、`mosaic` という独立 `EffectDef` として `builtinEffects.ts` に登録するだけ。新規アルゴリズム開発が不要。
- **メリット**: 数学的に厳密（ブロック内は完全に同一色）。INV-2はraster経路の共有機構により自動担保。
- **デメリット**: 毎フレーム DOM→canvas キャプチャを伴うため、厳密には"live"ではない（ただし `frameRenderCache` で同一フレームの再計算は回避される）。

### 2.3 選択肢C（ユーザー提案・再検討の結果、有力）: `executionPath:"live"`、displacementによるグリッドスナップ

**原理**: `feDisplacementMap` は「出力ピクセルの位置ごとに、変位マップの値だけずらしてソースをサンプリングする」ため、変位マップを「ブロック内のどのピクセルも、そのブロックの中心点へ向かって引き戻す」鋸歯状（sawtooth/staircase）パターンにすれば、**ブロック内の全ピクセルが同じ代表点（ブロック中心）の色をサンプリングする**——実質的に最近傍サンプリングによるモザイクになる。ブロック平均ではなく代表点抽出だが、多くのリアルタイムシェーダ・ゲームエンジンの "pixelate" 実装（`floor(uv*blockCount)/blockCount` によるUVスナップ）と同じ原理であり、見た目上は十分「モザイク」として通用する。

**実装方法**:
- `wave`/`ripple` の「手続き的な displacement map を data URI で `feImage` に食わせ `feDisplacementMap` に渡す」パターンをそのまま流用。
- マップの中身は `blockSize` 周期で反復する鋸歯状パターン。R/Gチャンネルに「ブロック中心へ向かう変位量」を符号化する。
- クリスプさの担保に `ditherDissolve` の `<pattern>` + `<rect>` ハードエッジタイル手法（なめらかなグラデーションではなく矩形セルの直接積み上げ）を流用する。

**メリット**:
- 正真正銘の "live"（CSS/SVGフィルタのみ、raster捕獲なし）。ユーザーの元の要求に正面から応える。
- 既存の displacement 系エフェクトのアーキテクチャ資産（`feImageLayer`固定座標、`userSpaceOnUse`フィルタ領域指定）をそのまま再利用できる。

**デメリット/リスク（要実測）**:
- 真のブロック平均化ではなく代表点抽出のため、raster版と厳密には一致しない（見た目は近い）。
- ブラウザがフィルタ内部で変位マップをサンプリングする際の内部解像度次第で、ブロック境界が完全にはクリスプにならず1〜2px程度なめらかになるリスクがある。これは `.claude/skills/implement-visual-effect/SKILL.md` が警告する「CSS filter + foreignObjectキャプチャの座標系ドリフト」と同系統の問題であり、**計測駆動フレームワーク（strength=blockSizeを4/16/64と振ってブロック境界のシャープネスを実機スクリーンショットで計測）による検証が実装前提**。
- 検証の結果、境界が十分にクリスプにならない場合は `pixelSortLite` と同じ位置づけの「それっぽい近似」に留まる可能性がある（これ自体は許容範囲——ユーザーは「それっぽくできない？」と近似で良い旨を示唆している）。

### 2.4 結論

**選択肢A（raster・真値）と選択肢C（live・グリッドスナップ近似）を、`pixelSorter`/`pixelSortLite` と同型の「真値/近似」ペアとして両方実装する方向を推奨する。**

- `mosaic`（`executionPath:"raster"`）— 真のブロック平均化、保証された正しさ。
- `mosaicLite`（`executionPath:"live"`）— displacementグリッドスナップ、ユーザーが最初に求めた"live"の性質を満たす。実装前にプロトタイプで境界のクリスプさを実測し、実用に耐えるか判断する。

どちらか一方のみでよい場合は、"live"を最優先するなら `mosaicLite` から着手し、確度を実測してから `mosaic`（raster版）の要否を判断する順序も合理的。

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

### 3.2 選択肢C: `mosaicLite`（`EffectDef` 登録案、`wave`/`ditherDissolve` を雛形に）

```ts
const MOSAIC_LITE_EFFECT_DEF: EffectDef = {
  type: "mosaicLite",
  label: "Mosaic (Lite)",
  category: "スタイライズ",
  previewBakeRequired: false,
  executionPath: "live",
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

### 3.3 自動的に配線される箇所（両選択肢共通・変更不要と見込まれる）

- `effectChain.ts` の `resolveEffectChain()` — `live`/`raster` 双方を汎用的にバケット分け。
- `DomRenderer.ts` の `applyFilterTokens`（live）/ `runRasterPipeline`（raster）— 既存の汎用実装がそのまま動作。
- `src/editor/pipelineAnalysis.ts` の `hasRasterExecutionPath()` — raster版（`mosaic`）のみ自動的にPipelineパネルでraster表示。
- `InspectorPanel.tsx` のエフェクトピッカー — Live調整レイヤーでは `mosaicLite` のみ選択可能になる（`executionPath==="live"`フィルタ、既存挙動どおり）。
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
| INV-2（preview/export一致） | 選択肢Aは既存raster経路の共有機構により自動担保。選択肢Cは既存displacement系エフェクトと同じ座標系固定ルール（`feImageLayer`実座標固定・`userSpaceOnUse`）に従う限り担保される見込み（displacement系で過去に確認されたドリフト問題の再発に注意し実測） |
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

## 6. オープン質問

- **Q1**: 選択肢A（raster・真値）と選択肢C（live・グリッドスナップ近似）の**両方**を実装するか、まず選択肢C（"live"というユーザーの元の要求に直接応える方）だけプロトタイプして品質を確認してから判断するか。
- **Q2**: ブロック形状は正方形限定でよいか（AE同様、水平/垂直別サイズは将来拡張）。
- **Q3**: 選択肢Cの境界クリスプさが実測で不十分だった場合、「それっぽい近似」として受け入れるか、追加のチューニング工数をかけるか、それとも選択肢A（raster）を正とし選択肢Cは見送るか。
- **Q4**: Worker pool オフロード（選択肢Aのパフォーマンス最適化）を初期実装に含めるか、実測してから判断するか。

---

## 7. 参照

- `src/runtime/plugin.ts:37-70`（`EffectDef`/`EffectFilter`/`RasterBuffer` 契約）
- `src/runtime/builtinEffects.ts`（`PIXEL_SORTER_EFFECT_DEF`/`PIXEL_SORT_LITE_EFFECT_DEF`、`WAVE_EFFECT_DEF` を雛形として踏襲）
- `src/runtime/pixelSort.ts:202-236`（`blockAverage()` 既存実装）/ `test/pixelSort.test.ts:68-70`（ブロック均一性テスト）
- `src/runtime/effectSvg.ts:19-21`（`feImageLayer` 実座標固定）/ `effectSvg.ts:660-684`（`ditherPatternMaskSvg` ハードエッジタイル）/ `effectSvg.ts:697`（`feTile`不使用の明記コメント）
- `src/runtime/effectChain.ts`（`resolveEffectChain` 汎用live/raster振り分け）/ `src/runtime/DomRenderer.ts`（`runRasterPipeline`/`runAdjustmentRasterPipeline`）
- `.claude/skills/implement-visual-effect/SKILL.md`（計測駆動フレームワーク・displacement系ドリフト修正の実例）
- `doc/mafter-effect-spec.md` §27.1（raster効果の export フロー）/ §27.4（調整レイヤー live/raster）/ §27.10・§27.13（影響ファイル一覧の前例）
