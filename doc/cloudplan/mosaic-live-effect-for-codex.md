# モザイク（ブロックピクセレート）エフェクト Codex 実装プラン

> **ステータス**: Codex 向け再解釈ドラフト（未承認）。本ファイルは `doc/mafter-effect-spec.md`（SSoT）を置き換えない。
> §5 データスキーマ・INVARIANT・`project.json` 直列化形式に触れる変更は、`AGENTS.md` / `CLAUDE.md` の運用どおり **実装前にユーザー承認が必須**。
> 本プランの結論では、モザイクエフェクトは **§5/INV/project.json 直列化形式の変更なし**で実装できる見込み。
> 元文書: `doc/cloudplan/mosaic-live-effect.md` / Codex 再解釈日: 2026-07-09

---

## 0. Codex が先に読む結論

- **実装候補は2本立て**にするのが妥当。
  - `mosaic`: `executionPath:"raster"`。既存 `blockAverage()` を使う真のブロック平均化。重いが正確。
  - `mosaicLite`: `executionPath:"live"`。`feDisplacementMap` でブロック中心へグリッドスナップする軽量近似。`fastTurbulentDisplace` と同じ live CSS filter 系の経路を使う。
- **まず実装するなら `mosaicLite` を推奨**。ユーザーが求めている「live turbulent displacement と同格の軽さ」に直接答える案で、既存の Fast* displacement 系の知見を使える。
- **ただし `mosaicLite` は実機計測が完了条件**。理論上は live でよいが、モザイク固有の変位マップ形状で本当にドリフトしないか、境界が十分クリスプかは Playwright/実ブラウザ計測で確認する。
- **選択肢B（汎用SVG合成のみで SourceGraphic を平均化する案）は不採用**。SVG filter の通常合成だけでは入力ピクセルをブロック平均値へ置換できない。
- **SSoT への扱い**: 実装前に `doc/mafter-effect-spec.md` へ「新規エフェクトとしての振る舞い」を散文で追記する。§5 型・INVARIANT・直列化形式は変えない。

---

## 1. 元文書からの重要な訂正ポイント

元文書は、モザイク live 化について段階的に見立てを訂正している。Codex は以下を前提にしてよい。

1. 最初の「live では構造的に不可能」という判断は撤回済み。
2. `feImage` + `feDisplacementMap` が必ず raster 経路を必要とする、という判断も撤回済み。
3. displacement 系の過去のドリフト真因は「live であること」ではなく、**フィルタ領域のパディング帯で変位マップが未定義値を返すこと**だった。

既存 spec では、フィルタ領域をレイヤー実寸 `(0,0,w,h)` にクランプすると live CSS filter の centroid drift が raster 版と小数2桁まで一致する、という実測知見が記録されている（元文書では `doc/mafter-effect-spec.md:2719` を一次根拠としている）。

したがって `mosaicLite` は次の2条件を満たせば、`fastWave` / `fastRipple` / `fastTurbulentDisplace` と同型の live effect として成立する見込み。

1. 変位マップがレイヤー全域で常に定義されること。
2. フィルタ領域を `(0,0,w,h)` へクランプし、パディング帯を作らないこと。

---

## 2. Codex 実装方針

### 2.1 推奨ルート

Codex が実装へ進む場合は、次の順序を推奨する。

1. `doc/mafter-effect-spec.md` に spec 散文を追記する。
2. `mosaicLite` を先に実装し、live 経路での軽さとドリフトなしを検証する。
3. 必要なら `mosaic` を追加し、真のブロック平均化版として対になるエフェクトにする。

`mosaicLite` から始める理由は、ユーザー要求の中心が「live で軽いモザイク」にあり、`mosaic` は既存 `blockAverage()` を流用できるため技術リスクが低いから。

### 2.2 実装前に必ず読むもの

- `AGENTS.md`
- `CLAUDE.md`
- `progress.md`
- `doc/mafter-effect-spec.md`
- `.agents/skills/implementation-loop/SKILL.md`
- `.agents/skills/implement-visual-effect/SKILL.md`
- 必要に応じて `.agents/skills/debug-visual-render-bug/SKILL.md`

視覚エフェクトの追加なので、Codex は `implement-visual-effect` の計測駆動フレームワークを使う。単に型チェックと unit test が通っただけでは完了にしない。

---

## 3. `mosaicLite` 設計

### 3.1 目的

`mosaicLite` は、真のブロック平均化ではなく、ブロック中心の代表点へソースサンプリング位置をスナップする **軽量近似モザイク** として定義する。

これは多くの pixelate shader と同じ発想で、UV を `floor(uv / blockSize) * blockSize + center` に丸める処理を、SVG displacement map で表現する。

### 3.2 EffectDef 案

```ts
const MOSAIC_LITE_EFFECT_DEF: EffectDef = {
  type: "mosaicLite",
  label: "Mosaic (Lite)",
  category: "ディストーション（軽量）",
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

### 3.3 SVG filter の必須条件

`mosaicGridSnapFilter()` は `src/runtime/effectSvg.ts` に追加する想定。

- `blockSize` 周期の鋸歯状または階段状の変位マップを生成する。
- R/G チャンネルに、各ピクセルがブロック中心をサンプリングするための X/Y 変位を符号化する。
- `<pattern patternUnits="userSpaceOnUse">` など、レイヤー全域で未定義領域が出ない生成方法を使う。
- `svgDisplaceFilterMarkup(..., compFixed=true)` と同等に、filter region を `x=0 y=0 width=w height=h` へ固定する。
- `executionPath:"live"` のため、DOM→canvas の raster capture を発生させない。

### 3.4 配線候補

- `src/runtime/fastEffects.ts` または既存の lightweight effect 登録箇所に `MOSAIC_LITE_EFFECT_DEF` を追加する。
- `src/runtime/effectSvg.ts` に `mosaicGridSnapFilter` 相当の純関数を追加する。
- `DISPLACEMENT_EFFECT_TYPES` / `LIVE_DISPLACEMENT_EFFECT_TYPES` に含めるか確認する。既存 displacement 系との一貫性を優先するなら含める。
- `effectCategories` は「ディストーション（軽量）」を再利用できるなら変更しない。

---

## 4. `mosaic` 設計

### 4.1 目的

`mosaic` は真のブロック平均化を行う raster エフェクト。見た目の正しさを優先する版で、処理は重い。

### 4.2 EffectDef 案

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
    if (blockSize <= 1) return input;
    return blockAverage(input, blockSize);
  },
};
```

### 4.3 実装メモ

- `src/runtime/pixelSort.ts` の `blockAverage()` は既存実装・既存テストがある。
- 共有化するなら新規 `src/runtime/mosaic.ts` へ純関数を切り出し、`pixelSort.ts` と `mosaic` の両方から使う。
- `executionPath:"raster"` のため、通常レイヤー raster・調整レイヤー raster・export composite が同じ `processPixels` を呼べる。INV-2 の観点では既存経路に乗せやすい。
- 初期実装で Worker pool 対応は必須にしない。実測で重さが問題になったら検討する。

---

## 5. §5 / INV / project.json への影響

| 項目 | Codex 判断 |
|---|---|
| §5 `EffectInstance` 型 | 変更不要。既存の `type: string` / `props` で表現可能。 |
| §5 `ParamKind` / `EffectDef` 型 | 変更不要。`blockSize` は既存 `scalar` で表現可能。 |
| INV-1 | 変更不要。`apply()` / `processPixels()` は props と入力 buffer にのみ依存する純関数にできる。 |
| INV-2 | 変更不要。`mosaic` は既存 raster 共有経路、`mosaicLite` は Fast* と同じ filter region clamp により担保する。 |
| INV-3 | 変更不要。Renderer は既存 `ResolvedScene` / effect contract を使う。 |
| project.json 直列化形式 | 変更不要。`EffectInstance.props.blockSize` が追加されるだけ。 |

Codex はこの前提が崩れる実装案を見つけた場合、その場で止まり、ユーザーへ確認すること。特に §5 型追加・INVARIANT 変更・直列化形式変更は勝手に進めない。

---

## 6. 検証ゲート

### 6.1 Unit / 型チェック

- `npm run typecheck`
- `npm test`
- `blockSize=1` または最小値で恒等に近い挙動を確認する unit test
- `mosaicLite` の変位マップ生成が `blockSize` ごとに正しい座標へスナップすることを確認する純関数 test
- effect routing / category / pipeline 表示に既存 test がある場合は追加・更新

### 6.2 実機 Playwright 検証

`mosaicLite` はここが最重要。

- `blockSize=4/16/64` など複数値でスクリーンショット計測する。
- ブロック境界の位置が frame 間で意図せず揺れないことを確認する。
- displacement 系で過去に起きた strength 比例の centroid drift が出ないことを、`verify-fast-drift-spike.mjs` と同種の方法で確認する。
- preview と export の同一 frame を比較し、境界位置が一致することを確認する。

### 6.3 Export / Bundle

`mosaicLite` が `src/runtime` / `src/player` から参照される runtime 変更になる場合、Codex は完了前に必ず次を行う。

- `npm run build:player`
- `playerBuildFreshness` 関連 test が通ることを確認する。
- HTML bundle export に新エフェクトが反映されることを確認する。

mp4 / webm / PNG export 経路に影響する変更では、既存 export / raster / bundle 関連 verify を置き換えず、追加で無回帰確認する。

---

## 7. Codex 用タスク分解

### Phase 0: 現状確認

- `doc/mafter-effect-spec.md` の effect / raster / Fast* displacement 記述を確認する。
- `src/runtime/plugin.ts` の `EffectDef` 契約を確認する。
- `src/runtime/fastEffects.ts` / `src/runtime/builtinEffects.ts` / `src/runtime/effectSvg.ts` の既存パターンを読む。
- `src/runtime/pixelSort.ts` の `blockAverage()` と既存 test を確認する。

### Phase 1: Spec 追記

- §5 型や INV を変えず、散文として `mosaicLite` / `mosaic` の振る舞いを追記する。
- `mosaicLite` は lightweight approximate pixelate、`mosaic` は exact raster block average と明記する。
- live displacement の成立条件として、全域定義の変位マップと `(0,0,w,h)` filter region clamp を明記する。

### Phase 2: `mosaicLite` 実装

- `mosaicGridSnapFilter` を純関数として追加する。
- `MOSAIC_LITE_EFFECT_DEF` を登録する。
- `LIVE_DISPLACEMENT_EFFECT_TYPES` 等の routing に必要なら追加する。
- unit test と routing test を追加する。

### Phase 3: `mosaic` 実装（必要なら）

- `blockAverage()` を共有しやすい形に整理する。
- `MOSAIC_EFFECT_DEF` を登録する。
- `processPixels()` の境界値 test を追加する。

### Phase 4: 実機・export 検証

- Playwright で視覚検証する。
- preview/export/bundle の無回帰を確認する。
- runtime/player 依存がある場合は `npm run build:player` を実行する。

### Phase 5: progress 更新

- 完了内容、未確認の視覚リスク、実行した検証、次の一手を `progress.md` に記録する。

---

## 8. オープン質問

- **Q1**: 初期実装は `mosaicLite` のみでよいか、それとも `mosaic` / `mosaicLite` を同時に入れるか。
- **Q2**: `blockSize` は正方形のみで開始してよいか。水平/垂直個別サイズは将来拡張でよいか。
- **Q3**: `mosaicLite` の境界が完全なブロック平均に見えない場合、軽量近似として受け入れるか、`mosaic` を正として `mosaicLite` を補助扱いにするか。
- **Q4**: `mosaic` の Worker pool 対応は初期実装に含めるか、実測後に判断するか。

Codex の推奨は、**Q1: まず `mosaicLite`、Q2: 正方形のみ、Q3: 軽量近似として受け入れつつ `mosaic` を真値版として残す、Q4: 実測後判断**。

---

## 9. 参照

- `doc/cloudplan/mosaic-live-effect.md`
- `doc/mafter-effect-spec.md`
- `src/runtime/plugin.ts`
- `src/runtime/builtinEffects.ts`
- `src/runtime/fastEffects.ts`
- `src/runtime/effectSvg.ts`
- `src/runtime/effectChain.ts`
- `src/runtime/DomRenderer.ts`
- `src/runtime/pixelSort.ts`
- `test/pixelSort.test.ts`
- `.agents/skills/implementation-loop/SKILL.md`
- `.agents/skills/implement-visual-effect/SKILL.md`
