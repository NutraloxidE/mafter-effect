# Acid / Digi / Hyper — 実装作業票（Codex / Sonnet 委任用 詳細版）

> **親ドキュメント**: [acid-digi-hyper-live-effects-plan.md](acid-digi-hyper-live-effects-plan.md)（設計・世界観・却下理由の SSoT）。本ファイルはそれを **make-plan-for-codex** 形式の作業票へ分解したもの。設計判断は親を正とし、ここでは重複しない。
> **ステータス**: ドラフト（未承認）。§5/INV 変更ゼロ（親 §6 で確認済み）。
> 作成日: 2026-07-12 / 対象ブランチ: `claude/new-effect-plan-nmsfyt`

---

## 0. 「丸投げできるか？」への回答（結論）

**設計プラン（親ファイル）を Sonnet 5 / Codex にそのまま丸投げするのは不可。** 理由:

1. **設計レベルで、実装レベルでない。** 親は技法を抽象的に書く（「`feComponentTransfer discrete`」）だけで、各エフェクトの **正確な SVG primitive 文字列を実装者が導出**する必要がある。ゼロ平均ノイズ・アルファ維持・`tableValues` 生成・チャンネル分離行列は導出ミスが起きやすく、丸投げは分散が大きい。
2. **displacement 系は「登録だけでは動かない」配線が 4 箇所ある。** `glitchSlice` / `pixelStretch` は `EffectDef` 登録に加えて `effectSvg.ts` の 3 Set（`DISPLACEMENT_EFFECT_TYPES` / `FAST_DISPLACEMENT_EFFECT_TYPES` / `LIVE_DISPLACEMENT_EFFECT_TYPES`）と `effectChain.ts:65-82` の scale 分岐への追記が必須。どれか漏らすと raster に誤ルートされる／region がクランプされず素矩形が露出する（add-layer-component-type スキルが警告する「片側だけ壊れる」事故）。Codex は登録だけして「完了」と誤宣言しがち。
3. **9 本一括は Codex を焼く。** make-plan-for-codex の worked example どおり「3 Phase 相当」を一度に渡すと 30 分で usage 警告。
4. **spike 2 本（`pixelStretch` / `liquidChrome`）は human 検証必須。** 8-bit 量子化アーティファクトの許容判断・`feSpecularLighting` の INV-2 経路一致は headed browser 実ピクセルでしか判定できず、Codex に自己完了宣言させてはいけない。
5. **`src/runtime/` を触るので `npm run build:player` が必須。** これを prompt に明記しないと HTML bundle 経路に古い player が残る（CLAUDE.md）。

### 委任可否マトリクス（エフェクト単位）

| エフェクト | 丸投げ可否 | 委任先 | 条件 |
|---|---|---|---|
| `posterize` | ✅ 可 | Codex medium | 本票 Ticket A-1 を単体で渡す |
| `gradientMap` | ✅ 可 | Codex medium | Ticket A-2（pure table 関数を先に分離） |
| `chromaSplit` | ✅ 可 | Codex medium | Ticket A-3 |
| `scanlines` | ⚠️ 条件付き | Codex medium | Ticket B-1（**§2.5 生 PNG + `feTile` 必須**・Claude が §2.5 diff レビュー + human 重さ verify） |
| `noiseGrain` | ⚠️ 可（要ゲート） | Codex medium | Ticket B-2 + ゼロ平均 verify を完了条件から除外し Claude 側で受け入れ |
| `hyperGlow` | ✅ 可 | Codex medium | Ticket B-3 |
| `glitchSlice` | ⚠️ 条件付き | Codex medium | Ticket C-1（4 配線点 + **§2.5 生 PNG マップ**を prompt に列挙・Claude が diff レビュー必須） |
| `pixelStretch` | ❌ 不可（先に spike） | Claude + human | Ticket D-1 spike の go/no-go 後に票化 |
| `liquidChrome` | ❌ 不可（先に spike） | Claude + human | Ticket D-2 spike（INV-2）後に票化 |

**要するに**: 純 primitive チェーンの 5 本（`posterize`/`gradientMap`/`chromaSplit`/`hyperGlow`/`noiseGrain`）は本票を 1 枚ずつ渡せば Codex/Sonnet に丸投げ可（`noiseGrain` のみゼロ平均を Claude 受け入れ）。**`feImage` を使う 2 本（`scanlines`/`glitchSlice`）は §2.5（生 PNG + `feTile` / 生 PNG マップ）を prompt に明記し Claude の diff レビュー + human 重さ verify 必須**。spike 2 本は委任不可。

> **§2.5 の由来**: 本詳細版は初版で `scanlines` を「`<pattern>` の feImage 化」、`glitchSlice` を「SVG `<rect>` マップ」で設計していたが、mosaic ブランチから取り込んだ implement-visual-effect §7c（`feImage`(ネスト SVG 文書) は毎フレーム再ラスタ・実測 200 倍）に該当するため、両 Ticket を生 PNG ベースへ訂正した（§2.5）。純 primitive の 5 本は §7c 非該当。

---

## 1. Plan intake summary

- **Source document**: `doc/cloudplan/acid-digi-hyper-live-effects-plan.md`
- **Goal**: モダン系（Acid/Digi/Hyper）live エフェクトを最小配線で追加する。
- **Known Phases**: 親 §7 の Phase A（カラー3種）/ B（発光・質感3種）/ C（グリッチ）/ D（spike）/ E（プリセットレシピ散文）。
- **Known WPs**: WP-A（非 displacement カラー）/ WP-B（非 displacement 発光・ノイズ）/ WP-C（live displacement）/ WP-D（spike）。
- **Required gate files**: なし（DRAFT 承認のみ）。§5/INV 変更ゼロなので decision-record 不要。
- **Required status files**: `progress.md`（各 WP 完了時に追記）。
- **Hard forbidden areas**: `src/core/schema.ts`（§5）/ `DomRenderer.ts` の raster pipeline / `exporter.ts` / serialization。非 displacement Ticket は `builtinEffects.ts` と新規 helper のみ。
- **Allowed file policy**: 1 Ticket = 原則 1〜3 ファイル。pure function を先に分離。
- **Required commands**: `npm run typecheck` / `npm test -- <name>` / `npm run build:player`（runtime 変更後・全 Ticket 共通）。
- **Required generated artifacts**: `public/player.js`（`build:player` の出力・commit 対象）。
- **Human verification required**: `noiseGrain` ゼロ平均目視 / `pixelStretch` 量子化アーティファクト / `liquidChrome` INV-2 経路一致 / **`scanlines`・`glitchSlice` の §2.5 重さ（実 Chrome + CDP Tracing で `MainFrame.Draw` ベースライン同等）**。
- **Ambiguities**: 親 §9 の 4 未決事項（preset ラインナップ・hyperGlow の滲み範囲・spike 並行可否）。
- **First safe action**: Ticket A-1（`posterize`・最小・純 CSS/SVG・displacement 非該当）。

---

## 2. 配線の実体（実装前に必ず読む・コード根拠）

Codex/Sonnet が「どこを触れば動くか」を推測しないための地図。**この節が本票の核。**

### 2.1 非 displacement live SVG エフェクトの配線（最小）

`{kind:"svg", primitives}` を返す `EffectDef` を `builtinEffects.ts` に登録し `registerBuiltinEffects()` に 1 行足すだけ。**それ以外の配線は不要**。根拠:

- `DomRenderer.applyEffects` → `resolveEffectChain`（`effectChain.ts:95-110`）が registry の `def.apply()` を呼び、`{kind:"svg"}` を `svgFilters` に積む。
- `createSvgFilterElement`（`DomRenderer.ts:1497-1524`）が filter 要素を生成。**primitives に `feDisplacementMap` を含まない場合、region は自動で `x=-25% y=-25% width=150% height=150%`**（L1516-1521）。
  - → **重要な訂正（親 §3.4）**: 非 displacement エフェクトのフィルタ領域は矩形の 1.25 倍まで自動で確保される。**`hyperGlow` のグロウはレイヤー矩形の外へ ~25% 滲む**（親の「矩形内に収まる」は誤り）。150% を超える滲みだけがクリップされる。初版仕様は「グロウは矩形の 125% 領域まで」で確定してよい。
- InspectorPanel のエフェクト追加メニューは registry 駆動（`category` 文字列でグルーピング）。**個別 UI 作業は不要**。既存 category（"カラー補正" / "スタイライズ" / "ディストーション"）を再利用する。
- InspectorPanel は `ParamDescriptor.kind`（`scalar`/`color`/`enum`/`bool`）でコントロールを自動生成。新 kind を作らない限り UI 追記ゼロ。

### 2.2 live displacement エフェクトの配線（4 箇所・漏らすと壊れる）

`glitchSlice` / `pixelStretch` は `feDisplacementMap` を primitives に含めるため、**以下 4 箇所すべて**に手を入れる。1 つでも漏らすと「raster に誤ルート」or「region 未クランプで素矩形露出」。

1. **`src/runtime/effectSvg.ts`** の 3 Set に type 文字列を追加:
   - `DISPLACEMENT_EFFECT_TYPES`（L47）→ 追加必須。これに入ると `createSvgFilterElement` が region を `(0,0,w,h)` クランプ（L1505-1515）。
   - `FAST_DISPLACEMENT_EFFECT_TYPES`（L59）→ Draft Preview Fast Path 対象にする。
   - `LIVE_DISPLACEMENT_EFFECT_TYPES`（L67）→ **これに入れないと `DomRenderer.ts:2092-2097` / `effectRouting.ts:32` が raster 必須と判定して live で skip される。**
2. **`src/runtime/effectChain.ts:65-82`** の scale 算出分岐に新 type の変位量パラメータ名を追加（`fxMaxDisplaceScale` に反映されないと region クランプの参照スケールがずれる）。例: `glitchSlice` は `maxShift`、`pixelStretch` は `h` オーダー。
3. **`EffectDef` 登録**（`fastEffects.ts` の `registerFastEffects()` 推奨 = 軽量 displacement の既存置き場）。
4. **変位マップ helper**（`effectSvg.ts` に純関数追加）— レイヤー全域 `(0,0,w,h)` で定義される map を作る（未変位域は中間グレー 0.5）。`feImageLayer` + `svgDataUri` の既存様式に従う。

**受け入れ計測**: 変位 amount を 0/中/大で振り、**重心ドリフトが raster 版と小数2桁一致**（`verify-fast-drift-spike.mjs` と同型）。これは human/headed browser 側で確認し、Codex に自己宣言させない。

### 2.3 乱数の規約（INV-1）

`Math.random` 禁止。`seededRandom`（`exprHelpers.ts`・`effectSvg.ts:5` で import 済み）と `phaseToSeed`（`effectSvg.ts:230`）を使う。フレームアニメーションは `ctx.frame` を seed に混ぜて決定論導出。

### 2.4 既存ヘルパ（再利用する部品）

| 部品 | 場所 | 用途 |
|---|---|---|
| `svgDataUri(svg)` | `effectSvg.ts:10` | SVG 文字列 → data URI |
| `feImageLayer`（内部） | `effectSvg.ts:19` | map/mask を `(0,0,w,h)` 固定で feImage 化 |
| `rgbaToPngDataUri` | `pngDataUri.ts`（`effectSvg.ts:6` で import 済み） | **Uint8 バッファ → 生 PNG data URI（§2.5 の feTile/マップ焼きに使う）** |
| `ditherPatternMaskSvg`（内部・参考） | `effectSvg.ts:697` | `<pattern>` タイル様式（**§2.5 の理由で feImage には渡さない**・様式参照のみ） |
| `seededRandom` | `exprHelpers.ts` | 決定論乱数 |
| `num` / `str` / `bool` / `rgba` | `builtinEffects.ts:28-52` | props パース（コピーして使う既存パターン） |

### 2.5 `feImage` は「ネスト SVG 文書」を渡さない — 生 PNG + `feTile`（重さ・implement-visual-effect §7c）

**本プラン策定後に mosaic ブランチから取り込んだ確定知見**（`.claude/skills/implement-visual-effect/SKILL.md` §7c、[mosaic-lite-phase-a-bench-report.md](mosaic-lite-phase-a-bench-report.md) §6.7）。**scanlines / glitchSlice の当初設計はこの罠に該当していたため、下記 Ticket で訂正済み。**

- **罠**: `feImage` の参照先が `<pattern>` / `<linearGradient>` / `mix-blend-mode` / `<rect>` 群等を含む**ネスト SVG 文書**だと、`filter:` / `backdrop-filter:` の下で Chrome がそのネスト文書を**毎フレーム再ラスタライズ**し、`MainFrame.Draw` が桁で膨らむ（mosaicLite 実測 54ms、ベースライン比 ~200 倍）。map が静的でも起きる。
- **正**:
  - **タイル可能な模様（scanlines）** → タイル 1 個を `rgbaToPngDataUri()` で**生 PNG に焼き**、`feImage`(生 PNG) → native **`feTile`** で全域に敷く。
  - **タイル不可の全域マップ（glitchSlice：スライスごとに値が違う）** → レイヤー実寸の**生 PNG を 1 枚**作り `feImage` に渡す（`feTile` なし）。
  - どちらも **`<pattern>` / SVG `<rect>` 群を `feImage` に渡さない**。
- **教訓の正確な形**: 「`feImage`=重い」ではなく「`feImage`(**ネスト SVG 文書**)=重い」。**生 PNG を渡す `feImage` は軽い**。
- **verify（human/headed browser・Codex 自己宣言不可）**: 実 Chrome（`channel:"chrome", headless:false`）+ 実マウスドラッグ scrub + CDP `Tracing`（`MainFrame.Draw` を**エフェクト無しベースライン対照付き**で合算）。`requestAnimationFrame` / headless / `page.screenshot()` は不可（GPU/compositor コストを隠す）。CPU プロファイラでは支配コストが見えない。

---

## 3. WP-A — 非 displacement カラー3種（丸投げ可・優先）

**共通 Allowed files**: `src/runtime/builtinEffects.ts` ＋ 各 Ticket の新規 helper/test。
**共通 Forbidden**: `schema.ts` / `DomRenderer.ts` / `effectChain.ts` / `exporter.ts` / 既存 `EffectDef` の挙動変更。
**共通コマンド**: `npm run typecheck` → `npm test -- <name>` → `npm run build:player`。

### Ticket A-1 — `posterize`

- **Owner / Model / Size**: Codex medium / 15 分 / 1〜2 ファイル。
- **Purpose**: 階調量子化エフェクトを 1 本追加。
- **Allowed files**: `src/runtime/builtinEffects.ts`、`test/posterize.test.ts`（新規）。
- **Pre-read**: 本票 §2.1、`builtinEffects.ts` の `TINT_EFFECT_DEF`（feComponentTransfer の前例）。
- **Implementation scope**:
  - 純関数 `posterizeTable(levels: number): string` を `builtinEffects.ts` 内（or 隣接 helper）に追加。`levels` 個の等間隔値 `0, 1/(L-1), …, 1` をスペース区切りで返す。`L<2` は `L=2` にクランプ。
  - `EffectDef`:
    ```ts
    const POSTERIZE_EFFECT_DEF: EffectDef = {
      type: "posterize",
      label: "Posterize",
      category: "カラー補正",
      previewBakeRequired: false,
      executionPath: "live",
      params: [
        { key: "levels", label: "Levels", kind: "scalar", default: 6, animatable: true, min: 2, max: 32, step: 1 },
      ],
      apply(props) {
        const levels = Math.max(2, Math.round(num(props["levels"], 6)));
        const t = posterizeTable(levels);
        const primitives = [
          `<feComponentTransfer in="SourceGraphic">`,
          `<feFuncR type="discrete" tableValues="${t}"/>`,
          `<feFuncG type="discrete" tableValues="${t}"/>`,
          `<feFuncB type="discrete" tableValues="${t}"/>`,
          `</feComponentTransfer>`,
        ].join("");
        return { kind: "svg", primitives };
      },
    };
    ```
  - `registerBuiltinEffects()` に `globalPluginRegistry.registerEffect(POSTERIZE_EFFECT_DEF);` を追加、export 一覧にも追記。
- **Explicit non-goals**: identity（null 返し）は不要（AE 準拠で常時適用）。displacement セットに触らない。
- **Tests**: `test/posterize.test.ts` — `posterizeTable(4)` が `"0 0.3333333333333333 0.6666666666666666 1"` 相当（許容誤差比較）、`posterizeTable(2)` が `"0 1"`、`levels<2` クランプ。
- **Stop conditions**: allowed 外を触る必要が出たら停止・報告。
- **Completion report**: 変更ファイル / test 結果 / typecheck / build:player の `public/player.js` 更新有無。
- **Prompt to Codex**（雛形）:
  ```
  Implement only Ticket A-1 (posterize) from doc/cloudplan/acid-digi-hyper-live-effects-plan-Detailed.md.
  Allowed files: src/runtime/builtinEffects.ts, test/posterize.test.ts
  Forbidden: schema.ts, DomRenderer.ts, effectChain.ts, effectSvg.ts, exporter.ts; do not change existing EffectDef behavior or existing test expectations; do not touch DISPLACEMENT_EFFECT_TYPES sets.
  Run: npm test -- posterize ; npm run typecheck ; npm run build:player
  Stop if you need any file outside the allowed list.
  Report changed files, test result, typecheck, whether public/player.js changed. Do not continue to the next ticket.
  ```

### Ticket A-2 — `gradientMap`

- **Owner / Model / Size**: Codex medium / 25 分 / 2 ファイル。
- **Purpose**: 輝度→グラデーション写像（thermal/acid/cyber/chrome/duotone）。
- **Allowed files**: `src/runtime/effectSvg.ts`（純データ + table 関数）、`src/runtime/builtinEffects.ts`、`test/gradientMap.test.ts`（新規）。
- **Pre-read**: 本票 §2.1、`TINT_EFFECT_DEF`（saturate→transfer の前例）。
- **Implementation scope**:
  - `effectSvg.ts` に純データと純関数を追加（**pure function を先に分離**）:
    - `GRADIENT_MAP_PRESETS: Record<string, {stop: number; r: number; g: number; b: number}[]>`（thermal/acid/cyber/chrome。値は 0..1）。
    - `gradientMapTable(preset, phaseDeg, colorA, colorB): {r: string; g: string; b: string}` — N=17 点を等間隔サンプル、`phaseDeg/360` 分だけ巡回シフト、`duotone` のみ colorA→colorB 線形補間。各チャンネル 17 値スペース区切り。
  - `EffectDef`（`apply` は saturate(0) → `feComponentTransfer type="table"` → `feComposite arithmetic` で amount ミックス）:
    ```
    <feColorMatrix in="SourceGraphic" type="saturate" values="0" result="gray"/>
    <feComponentTransfer in="gray" result="mapped">
      <feFuncR type="table" tableValues="{r}"/>
      <feFuncG type="table" tableValues="{g}"/>
      <feFuncB type="table" tableValues="{b}"/>
    </feComponentTransfer>
    <feComposite in="mapped" in2="SourceGraphic" operator="arithmetic" k1="0" k2="{amount}" k3="{1-amount}" k4="0"/>
    ```
  - params: `preset`(enum, 既定 thermal) / `colorA`(color, 黒) / `colorB`(color, 白) / `phase`(scalar 0..360) / `amount`(scalar 0..1, 既定1)。`amount===0` → `return null`。
- **Explicit non-goals**: preset 追加 UI・アニメ preset は作らない。displacement セット非該当。
- **Tests**: `gradientMapTable("thermal",0,…)` が 17 値/チャンネルを返す、`phase=180` が半周シフト、`duotone` が colorA/colorB を端点に持つ、`amount` の範囲。
- **Completion report / Stop / Prompt**: A-1 と同型（allowed に effectSvg.ts を含む）。

### Ticket A-3 — `chromaSplit`

- **Owner / Model / Size**: Codex medium / 20 分 / 1〜2 ファイル。
- **Allowed files**: `src/runtime/builtinEffects.ts`、`test/chromaSplit.test.ts`（新規・オフセット算出のみ）。
- **Pre-read**: 本票 §2.1。
- **Implementation scope**:
  - 純関数 `chromaOffsetPx(amount, angleDeg): {dx: number; dy: number}` = `{dx: amount*cos, dy: amount*sin}`。
  - `apply`（G 固定・R/B を対称オフセット・screen 再合成、アルファは source に clip）:
    ```
    <feColorMatrix in="SourceGraphic" type="matrix" values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0" result="rC"/>
    <feColorMatrix in="SourceGraphic" type="matrix" values="0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0" result="gC"/>
    <feColorMatrix in="SourceGraphic" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0" result="bC"/>
    <feOffset in="rC" dx="{dx}" dy="{dy}" result="rO"/>
    <feOffset in="bC" dx="{-dx}" dy="{-dy}" result="bO"/>
    <feBlend in="rO" in2="gC" mode="screen" result="rg"/>
    <feBlend in="rg" in2="bO" mode="screen" result="rgb"/>
    <feComposite in="rgb" in2="SourceGraphic" operator="in"/>
    ```
  - params: `amount`(0..100, 既定4) / `angle`(deg, 既定0) / `mode`(enum rgb/rb, ❌)。`amount===0` → `return null`。
- **Explicit non-goals**: displacement 非該当。`mode:"rb"` は G を素通しにする分岐のみ（初版は rgb だけ実装し rb は TODO でも可 — その場合 param から rb を外す）。
- **Tests**: `chromaOffsetPx(10, 0)` → `{dx:10, dy:0}`、`angle=90` → `{dx:0, dy:10}`（誤差許容）。

---

## 4. WP-B — 非 displacement 発光・ノイズ3種（丸投げ可）

共通 Allowed/Forbidden/コマンドは WP-A と同じ（displacement セットに触らない）。

### Ticket B-1 — `scanlines`（⚠️ §2.5 必須・生 PNG タイル + `feTile`）

- **Model / Size**: Codex medium（**Claude が §2.5 diff レビュー + human が重さ verify**）/ 25 分。
- **Pre-read**: **本票 §2.5 全文**、`effectSvg.ts:6`（`rgbaToPngDataUri` import）。
- **Allowed files**: `src/runtime/effectSvg.ts`（PNG タイル焼き helper）、`src/runtime/builtinEffects.ts`、`test/scanlines.test.ts`。
- **Implementation scope**（§2.5 反映・**`<pattern>` を使わない**）:
  - 純関数 `scanlineTilePng(lineHeight, duty, opacity, direction): { uri, w, h }` — `lineHeight × lineHeight`（horizontal）の **Uint8ClampedArray を組み `rgbaToPngDataUri()` で生 PNG data URI に焼く**。暗バンド高 = `round(lineHeight*duty)`・グレー値 `255*(1-opacity)`（multiply 用）、残り行 = 白 255。`vertical` は x/y 入替（幅方向に暗バンド）。
  - `apply`（`feImage`(生 PNG) → `feTile` → multiply → source alpha clip。ロールは phase を y オフセットに）:
    ```
    <feImage href="{tileUri}" x="0" y="{-phaseOffset}" width="{tileW}" height="{tileH}" preserveAspectRatio="none" result="tile"/>
    <feTile in="tile" x="0" y="0" width="{w}" height="{h}" result="lines"/>
    <feBlend in="SourceGraphic" in2="lines" mode="multiply" result="mult"/>
    <feComposite in="mult" in2="SourceGraphic" operator="in"/>
    ```
    `phaseOffset = (phaseDeg/360)*tileH` を法 `tileH` で。**`<pattern patternUnits="userSpaceOnUse">` を feImage 化する構成は §2.5（毎フレーム再ラスタ）で不可。**
  - params: `lineHeight`(1..64,既定3) / `duty`(0.05..0.95,既定0.5) / `opacity`(0..1,既定0.35) / `direction`(enum,❌) / `phase`(0..360)。`opacity===0` → `return null`。
- **Explicit non-goals**: `<pattern>` / SVG rect map を使わない（§2.5）。
- **Tests**: `scanlineTilePng` が `data:image/png` を返す・tile 寸法が lineHeight・`duty` で暗バンド行数が変わる・`opacity=1` で暗値が 0 に近づく・direction で w/h 入替。primitives に `feTile` が含まれ `<pattern` を含まないこと（§2.5 回帰テスト）。
- **Human 受け入れ（Codex 完了条件から除外）**: §2.5 の実 Chrome + CDP Tracing で `MainFrame.Draw` がエフェクト無しベースライン同等。

### Ticket B-2 — `noiseGrain`（⚠️ ゼロ平均 verify は Claude/human が受け入れ）

- **Model / Size**: Codex medium / 20 分。
- **Allowed files**: `src/runtime/builtinEffects.ts`、`test/noiseGrain.test.ts`。
- **Implementation scope**:
  - `apply`（**ゼロ平均は `feComposite arithmetic` の `k4` で表現** — feComponentTransfer で -0.5 すると負値がクランプされて平均が狂うため使わない）:
    ```
    <feTurbulence type="fractalNoise" baseFrequency="{bf}" numOctaves="1" seed="{seed}" stitchTiles="stitch" result="noise"/>
    <feColorMatrix in="noise" type="matrix" values="0.33 0.33 0.33 0 0  0.33 0.33 0.33 0 0  0.33 0.33 0.33 0 0  0 0 0 0 1" result="mono"/>
    <feComposite in="mono" in2="SourceGraphic" operator="arithmetic" k1="0" k2="{amount}" k3="1" k4="{-0.5*amount}" result="grained"/>
    <feComposite in="grained" in2="SourceGraphic" operator="in"/>
    ```
    `result = SourceGraphic + amount*(noise-0.5)`（arithmetic は float 計算後にクランプ = 真のゼロ平均加算）。`monochrome:false` は `mono` 段を省く。
  - `bf = 1 / max(0.5, size)`。`seed = animated ? (baseSeed + ctx.frame) : baseSeed`（整数・INV-1 決定論）。
  - params: `amount`(0..1,既定0.15) / `size`(0.5..8,既定1) / `animated`(bool,❌) / `monochrome`(bool,既定true,❌) / `seed`(0..9999,❌)。`amount===0` → `return null`。
- **Explicit non-goals**: `Math.random` 禁止。
- **Tests**: seed 固定で primitives 文字列が決定論（同 props+frame → 同出力）、`amount=0` → null、`animated` で seed が frame 依存になる。
- **Human 受け入れ（Codex 完了条件から除外）**: amount を 0→0.3 で振っても **平均輝度・重心が不動**（ゼロ平均性）。headed browser 実測は Claude/human 側。

### Ticket B-3 — `hyperGlow`

- **Model / Size**: Codex medium / 25 分。
- **Allowed files**: `src/runtime/builtinEffects.ts`、`test/hyperGlow.test.ts`。
- **Implementation scope**:
  - 純関数 `thresholdTransfer(t): {slope: number; intercept: number}` = `{slope: 1/(1-t), intercept: -t/(1-t)}`（t→0, 1→1, 未満→クランプ0）。`t>=1` は極小 ε でガード。
  - `apply`（1 パス・threshold→blur→intensity→screen 合成、任意 tint）:
    ```
    <feComponentTransfer in="SourceGraphic" result="bright">
      <feFuncR type="linear" slope="{s}" intercept="{b}"/>
      <feFuncG type="linear" slope="{s}" intercept="{b}"/>
      <feFuncB type="linear" slope="{s}" intercept="{b}"/>
    </feComponentTransfer>
    <feGaussianBlur in="bright" stdDeviation="{radius*quality}" result="blur"/>
    <feComponentTransfer in="blur" result="glow">
      <feFuncR type="linear" slope="{intensity}"/>
      <feFuncG type="linear" slope="{intensity}"/>
      <feFuncB type="linear" slope="{intensity}"/>
    </feComponentTransfer>
    <feBlend in="SourceGraphic" in2="glow" mode="screen"/>
    ```
    `tint` が白以外なら `glow` の後に `feColorMatrix`（tint 乗算）を挿入。
  - params: `threshold`(0..1,既定0.7) / `radius`(0..200,既定24) / `intensity`(0..8,既定1.5) / `tint`(color,既定白) / `quality`(0.1..1,既定1)。`intensity===0 || radius===0` → `return null`。
- **Explicit non-goals**: 2 層ハロー（コア+ハロー）は初版で省略（TODO 可）。滲みは region 150% 自動（§2.1 の訂正どおり矩形外 ~25% まで出る・仕様として許容）。
- **Tests**: `thresholdTransfer(0.5)` → `{slope:2, intercept:-1}`、`t=0` → `{slope:1, intercept:0}`、identity 条件。

---

## 5. WP-C — live displacement（条件付き委任・Claude レビュー必須）

### Ticket C-1 — `glitchSlice`

- **Owner / Model / Size**: Codex medium（**Claude が diff レビュー必須**）/ 30 分 / 3〜4 ファイル。
- **Purpose**: 水平スライスグリッチ。**§2.2 の 4 配線点すべてに触る。**
- **Allowed files**: `src/runtime/effectSvg.ts`（map helper + 3 Set）、`src/runtime/effectChain.ts`（scale 分岐）、`src/runtime/fastEffects.ts`（EffectDef 登録）、`test/glitchSlice.test.ts`。
- **Forbidden**: `DomRenderer.ts`（触らず Set 経由で経路が決まる）/ `schema.ts` / `exporter.ts` / raster pipeline。
- **Pre-read**: **本票 §2.2 全文**（4 配線点）+ **§2.5**（生 PNG マップ・重さ）、`fastEffects.ts` の `FAST_WAVE_EFFECT_DEF`、`effectSvg.ts:6`（`rgbaToPngDataUri`）。
- **Implementation scope**（順序厳守）:
  1. **pure map helper** `glitchSliceDisplaceMapPng({ w, h, sliceHeight, maxShift, density, seed, evolution }): { uri, scale }` を `effectSvg.ts` に追加。**レイヤー実寸 `w×h` の Uint8ClampedArray を組み `rgbaToPngDataUri()` で生 PNG に焼く**（§2.5：`lightPixelSortDisplaceMapSvg` 系の SVG `<rect>` マップは**踏襲しない** — ネスト文書の毎フレーム再ラスタになる）。各スライス帯 `y∈[k*sliceHeight,(k+1)*sliceHeight)` について `seededRandom(seed, k, evolution)` で「飛ぶか（`< density`）」と変位量（`±maxShift` 正規化 → R チャンネル `0.5 + shift/(2*maxShift)`、G=0.5）を決め、未変位帯は R=G=0.5 の中間グレーで**全域を埋める**。`scale = maxShift`。`feImageLayer`(生 PNG) 様式。各スライスで値が違い tile 化できないため `feTile` は使わず 1 枚を渡す。
  2. `EffectDef`（`executionPath:"live"`、`apply` は `displaceWithMap(uri, scale, w, h)` を返す・`intensity===0||maxShift===0` → null）を `fastEffects.ts` に定義し `registerFastEffects()` に登録。
  3. **§2.2 の 3 Set 追記**: `effectSvg.ts` の `DISPLACEMENT_EFFECT_TYPES` / `FAST_DISPLACEMENT_EFFECT_TYPES` / `LIVE_DISPLACEMENT_EFFECT_TYPES` すべてに `"glitchSlice"` を追加。
  4. **`effectChain.ts:65-82` の scale 分岐**に `glitchSlice` の `maxShift` を追加（`fxMaxDisplaceScale` へ反映）。
  - params: `intensity`(0..1,既定0.5=density) / `maxShift`(0..500,既定60) / `sliceHeight`(2..256,既定24) / `evolution`(deg) / `seed`(0..9999,❌) / `chromaOffset`(0..50,既定0)。`chromaOffset>0` は後段に chromaSplit 型 primitive を連結（初版は省略し TODO でも可）。
- **Explicit non-goals**: raster 版は作らない。`chromaOffset` 連結は任意。map 平滑化（`fastSmoothPx`）は**掛けない**（グリッチは離散が正）。
- **Tests**（`test/glitchSlice.test.ts`）:
  - map helper が決定論（同 seed+evolution → 同 PNG data URI 文字列）。
  - map helper が **生 PNG（`data:image/png`）を返す**こと・SVG `<rect>` / `<pattern>` を含まないこと（§2.5 回帰テスト）。
  - 3 Set すべてに `glitchSlice` が含まれる（`DISPLACEMENT_EFFECT_TYPES.has("glitchSlice")` 等）— **配線漏れ回帰テスト**。
  - `intensity=0` → `apply` が null。
- **Stop conditions**: `DomRenderer.ts` を編集する必要が出たら停止（設計上不要 = 触る必要が出た時点で設計誤り）。
- **Human 受け入れ（Codex 完了条件から除外）**: ① preview と export の 1 フレーム画素一致（INV-2）、② amount 大での重心ドリフトが raster と小数2桁一致（§2.2）、③ **§2.5 の重さ verify — 実 Chrome + CDP Tracing で `MainFrame.Draw` がエフェクト無しベースライン同等**（生 PNG マップの効果確認）。headed browser 実測は Claude/human。
- **Claude レビュー観点**（make-plan-for-codex §G）: 4 配線点すべて入ったか / **map が生 PNG で SVG rect でないか（§2.5）** / `DomRenderer.ts` に触っていないか / 既存 fast 系 verify が無回帰か / `public/player.js` 再ビルド済みか。

---

## 6. WP-D — spike（委任不可・Claude + human）

**Codex に丸投げしない。** go/no-go を human 実ピクセルで決めてから本票に票を追加する。

### Ticket D-1 — `pixelStretch` feasibility spike（半日）— ✅ 完了（独立票へ supersede）

> **結果**: no-go（線形ランプ・pivot 対称スミアはユーザー実機判断で「意図と別物」）。
> 代替 ② の「Directional Line Stretch」で置換・確定。設計・実装・確定仕様は
> `doc/cloudplan/pixel-stretch-directional-line-stretch.md` を正とする（本チケットからは分離）。

- **Owner**: Claude（設計）+ human（実ピクセル受け入れ）。
- **やること**: 高さ 1080px 相当で線形ランプ変位マップ（`dy=-(y-y0)`、8-bit 量子化 `h/127` px 刻み）を試作し、階段アーティファクトが「味」か破綻かを headed browser で判定。
- **go**: 味の範囲 → `pixelStretch`（live）を C-1 同型で票化。
- **no-go 代替**: ① `sliceHeight` を持つ「階段状ストレッチ」（量子化と親和）として live 票化 ② raster 版に転換し Tier 3 降格。
- **成果物**: 判定を本ファイル §6 に追記し、確定仕様を spec §27 へ。

### Ticket D-2 — `liquidChrome` INV-2 spike

- **Owner**: Claude（設計）+ human（INV-2 経路一致）。
- **やること**: `feSpecularLighting`（**コードベース未使用**）を含む 3 段合成（turbulence 変位 + specular highlight + chrome gradientMap）を試作し、**preview / browser export / bundle player の 3 経路で一致するか**を実測。
- **go**: 一致 → `liquidChrome`（live）票化。
- **no-go 後退**: lighting 段を捨て「`fastTurbulentDisplace` + `gradientMap(chrome)` + `hyperGlow`」の 3 エフェクトスタック（プリセットレシピ §7）へ。後退版でも見た目の 8 割。
- **成果物**: 判定を本ファイルに追記。

---

## 7. WP-E — ルックプリセットレシピ（散文のみ・委任可）

- **Owner / Model**: Codex small でも可（散文）/ 10 分。
- **Allowed files**: `doc/mafter-effect-spec.md`（§27 エフェクト表への併記）のみ。
- **Implementation scope**: 親 §5.2 のレシピ（VHS / CRT / Acid Poster）を spec §27 に散文追記。**新 effect 型・スキーマ・UI プリセット機構は作らない**（将来課題）。
- **Non-goals**: コード変更ゼロ。

---

## 8. 実行順序（Claude オーケストレーション）

```
1. A-1 posterize        → Codex medium 単体委任 → Claude review → build:player 確認
2. A-2 gradientMap      → 同上（pure table 関数を先に）
3. A-3 chromaSplit      → 同上
4. B-1 scanlines        → Codex 実装（§2.5 生 PNG + feTile）+ Claude §2.5 review + human 重さ verify
5. B-2 noiseGrain       → Codex 実装 + Claude/human ゼロ平均受け入れ
6. B-3 hyperGlow        → Codex medium 単体委任 → Claude review → build:player 確認
7. C-1 glitchSlice      → Codex 実装（4 配線点 + §2.5 生 PNG マップ列挙）+ Claude diff review 必須 + human INV-2 + human 重さ verify
8. D-1 / D-2 spike      → Claude + human（委任不可）
9. E   recipes          → Codex small（散文）
10. progress.md 追記     → 各 WP 完了時
```

**各 Ticket 共通の hard gate**（make-plan-for-codex §E）:
- このTicketだけをやるようCodex prompt に明記。
- allowed / forbidden files を明記。
- `npm run build:player` を明記（runtime 変更のため）。
- 既存テスト期待値の改変禁止。
- human 受け入れ項目（ゼロ平均 / INV-2 / 量子化 / **§2.5 の重さ**）を **Codex 完了条件にしない**。
- **`feImage` を使う型（scanlines/glitchSlice）は §2.5 を prompt に明記**（生 PNG + `feTile` / 生 PNG マップ・`<pattern>`/SVG rect 禁止）。
- 次 Ticket へ勝手に進まない。

---

## 9. まとめ（ユーザー向け 3 行）

- **設計プラン丸投げは不可**（設計レベル・displacement 4 配線・spike の human 検証・9 本一括で焼ける、が理由）。
- 本詳細版なら **純 primitive の 5 本（posterize/gradientMap/chromaSplit/hyperGlow/noiseGrain）は Ticket を 1 枚ずつ渡せば Codex/Sonnet に丸投げ可**（正確な primitive・identity・test・stop condition を各票に明記済み）。
- **`feImage` を使う 2 本（scanlines/glitchSlice）は §2.5（生 PNG + `feTile` / 生 PNG マップ）を明記し Claude の diff レビュー + human 重さ verify 必須**、spike 2 本は **委任不可**。§2.5 は mosaic ブランチの implement-visual-effect §7c 知見を取り込んで訂正した。
