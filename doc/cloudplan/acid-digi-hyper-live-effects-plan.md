# Acid / Digi / Hyper — モダン系 live エフェクト群 設計プラン

> **ステータス**: ドラフト（未承認）。本ファイルは `doc/mafter-effect-spec.md`（SSoT）を置き換えない。
> §5 データスキーマ・INVARIANT に触れる項目は **ユーザー承認が必須**（CLAUDE.md 運用体制）。結論から言うと、本プランの全エフェクトは **§5/INV 変更ゼロ**で実装可能（§6参照）。
> 作成日: 2026-07-12 / 対象ブランチ: `claude/new-effect-plan-nmsfyt`

---

## 0. TL;DR（先に結論）

近年のモダングラフィック（Acid Graphics / Y2K リバイバル / hyperpop / デジタルグリッチ）の定番ルックを、**可能な限り `executionPath:"live"`（raster capture ゼロ）** で実装する 9 エフェクト + 1 プリセット概念を提案する。

| Tier | エフェクト | 実行経路 | 技法 | コスト感 |
|---|---|---|---|---|
| **1** | `chromaSplit` — RGB分離/色収差 | **live** | feColorMatrix + feOffset + feBlend | 極小 |
| **1** | `posterize` — 階調量子化 | **live** | feComponentTransfer discrete | 極小 |
| **1** | `gradientMap` — サーマル/Acid カラーマップ | **live** | saturate(0) + feComponentTransfer table | 極小 |
| **1** | `hyperGlow` — しきい値ブルーム | **live** | threshold + feGaussianBlur + screen | 小〜中 |
| **1** | `scanlines` — CRT/VHS 走査線 | **live** | feImage タイルパターン + blend | 極小 |
| **2** | `noiseGrain` — 動的フィルムグレイン | **live** | feTurbulence + seeded per-frame | 小 |
| **2** | `glitchSlice` — 水平スライスグリッチ | **live** | 行ストリップ変位マップ（fast* 方式） | 小 |
| **2** | `pixelStretch` — ピクセル引き伸ばし | **live**（要スパイク） | ランプ変位マップ | 中 |
| **3** | `liquidChrome` — Y2K 液体クローム | **live**（要スパイク） | feTurbulence + feSpecularLighting + gradientMap | 中 |
| — | 「VHS」等の**ルックプリセット** | — | 既存エフェクトのスタック定型 | — |

- **9 本すべて live で設計できる**。raster capture（DOM→canvas + readback）が必須になるものは本プランには含めない。
- 根拠は mosaic プラン（[mosaic-live-effect.md](mosaic-live-effect.md) §1.5）で確立済みの知見: **「フィルタ領域を `(0,0,w,h)` にクランプし、変位マップをレイヤー全域で定義すれば、live CSS filter の displacement は raster と小数2桁一致でドリフトしない」**（`fastWave` / `fastRipple` / `fastTurbulentDisplace` / `mosaicLite` の実績、spec:2271, 2719, 2738）。
- **§5 スキーマ変更ゼロ / INV 変更ゼロ**。`EffectInstance.type` は open string（`src/core/schema.ts:101-106`）で、`EffectDef` 登録（`builtinEffects.ts` / `fastEffects.ts`）だけで完結する。
- 時間履歴が必要な **datamosh / slit-scan / echo 系は却下**（§8）。`resolve()` 純関数（INV-1）と両立しないため、フレーム履歴アーキテクチャの導入という別議論になる。

---

## 1. 美学的ターゲット（何を「Acid / Digi / Hyper」と呼ぶか）

| 潮流 | 視覚言語 | 対応エフェクト |
|---|---|---|
| **Acid Graphics**（Y2K リバイバル、酸性デザイン） | 液体クローム、毒々しいグラデーション（thermal / acid green）、金属質タイポ | `liquidChrome`, `gradientMap` |
| **Digi / グリッチ** | RGB ずれ、走査線、スライス破壊、圧縮ノイズ | `chromaSplit`, `scanlines`, `glitchSlice`, `noiseGrain` |
| **Hyper**（hyperpop / maximalist） | 過剰ブルーム、白飛びグロウ、ポスタリゼーション、彩度爆発 | `hyperGlow`, `posterize`, `gradientMap`(hue cycle) |
| **CRT / VHS ノスタルジア** | 走査線 + 色収差 + 揺れ + グレイン | プリセットスタック（§5） |

既存の `pixelSortLite`（グリッチ系）・`mosaicLite`（ピクセレート）と合わせると、この 9 本で「モダン系ルック」の一次領域をほぼカバーできる。

---

## 2. アーキテクチャ前提（コード根拠・再掲最小限）

- **`EffectDef` 契約**（`src/runtime/plugin.ts:56-70`）: `executionPath: "live" | "raster"` 必須明示。`apply(props, ctx)` は純関数で `{kind:"css"} | {kind:"svg", primitives} | {kind:"raster"}` を返す。
- **live displacement の正準構成**（mosaic プラン §1.5 で確定）:
  1. 変位マップは**レイヤー全域 `(0,0,w,h)` で常に定義される**こと（`<pattern patternUnits="userSpaceOnUse">` タイル or `feTurbulence stitchTiles` 相当）。
  2. フィルタ領域を `(0,0,w,h)` にクランプ（`svgDisplaceFilterMarkup(..., compFixed)` 系）。パディング帯を作らない。
  3. これで raster capture ゼロ・ドリフトゼロ。`LIVE_DISPLACEMENT_EFFECT_TYPES`（`effectSvg.ts:67`）への登録を忘れない。
- **乱数**: `Math.random` 禁止（INV-1）。`phaseToSeed()`（`effectSvg.ts:230`）の系譜で **`seed` パラメータ + `ctx.frame` から決定論的に導出**する。
- **再ビルド**: 本プランのコードはすべて `src/runtime/` 配下 → **実装セッションでは `npm run build:player` 必須**（CLAUDE.md「bundle player の再ビルド」）。

---

## 3. Tier 1 — 純 live・低コスト・即効性大（先行実装推奨）

### 3.1 `chromaSplit` — RGB Split / Chromatic Aberration

グリッチ・hyperpop の最頻出ルック。R/G/B チャンネルを別方向にオフセットして再合成する。

- **executionPath**: `live` / **previewBakeRequired**: `false` / **category**: スタイライズ
- **技法**: `feColorMatrix`（各チャンネル分離）→ `feOffset`（angle+amount から dx/dy 算出、G は原点固定・R/B を対称オフセットが AE 系の定番）→ `feBlend mode="screen"` ×2 で再合成。アルファは `SourceGraphic` のアルファを `feComposite in` で維持（透明レイヤー縁の発色暴れ防止）。
- **params**:

| key | kind | default | range | animatable |
|---|---|---|---|---|
| `amount` | scalar | 4 | 0..100 (px) | ✅ |
| `angle` | scalar | 0 | deg | ✅ |
| `mode` | enum | `"rgb"` | `rgb` / `rb`（G固定） | ❌ |

- **identity**: `amount === 0` → `return null`。
- **リスク**: 低。全 primitive 既使用実績あり（`feColorMatrix`/`feMerge` は tint、`feOffset` は displacement 系マップ生成で使用）。オフセットでフィルタ領域からはみ出す分は amount 上限 100px + region クランプで縁のみ欠け（AE も同挙動）。

### 3.2 `posterize` — 階調量子化

- **executionPath**: `live` / **previewBakeRequired**: `false` / **category**: カラー補正
- **技法**: `feComponentTransfer` の `type="discrete"` を R/G/B に適用。`tableValues` は `levels` 個の等間隔値を `apply()` 内で文字列生成（純関数）。アルファは素通し。
- **params**: `levels` (scalar, default 6, 2..32, step 1, animatable ✅)。
- **identity**: `levels >= 256` 相当は実質恒等だが range 上限 32 なので `levels <= 1` → clamp、恒等条件は設けない（AE 準拠で常時適用）。※ 実装時に `levels` が最大値でも視覚差が出るため null 返しはしない。
- **リスク**: 極小。`feComponentTransfer` は tint で使用実績あり。

### 3.3 `gradientMap` — Gradient Map / Acid Colorize

輝度→任意グラデーションへの写像。thermal（サーモグラフィ）、acid green、cyberpunk duotone まで一本でカバーする、本プランの**キーストーン**。

- **executionPath**: `live` / **previewBakeRequired**: `false` / **category**: カラー補正
- **技法**: `feColorMatrix type="saturate" values="0"` で輝度化 → `feComponentTransfer type="table"` の R/G/B `tableValues` に、**グラデーション定義を N=17 点サンプリングした値**を書き込む。`phase` でサンプル位置を巡回シフトすると**ヒュー・サイクリング**（hyper 系の色相うねり）が keyframe 1 本で作れる。`amount` で `feMerge`/`feComposite arithmetic` による原色とのミックス。
- **params**:

| key | kind | default | range | animatable |
|---|---|---|---|---|
| `preset` | enum | `"thermal"` | `thermal` / `acid` / `cyber` / `chrome` / `duotone` | ❌ |
| `colorA` | color | 黒 | — | ✅（duotone 時の暗部） |
| `colorB` | color | 白 | — | ✅（duotone 時の明部） |
| `phase` | scalar | 0 | 0..360 | ✅ |
| `amount` | scalar | 1 | 0..1 | ✅ |

- preset のグラデーション定義は `effectSvg.ts` 側に純データ（stop 配列）で持つ。`duotone` のみ `colorA`/`colorB` を参照。
- **identity**: `amount === 0` → `return null`。
- **リスク**: 低。テーブルサンプリングは純計算。preset 数は後から増やせる（データ追加のみ）。

### 3.4 `hyperGlow` — しきい値ブルーム

「白飛び寸前の発光」。ネオン・hyperpop の核。CSS `drop-shadow` と違い**明部だけ**が滲む。

- **executionPath**: `live` / **previewBakeRequired**: `false` / **category**: スタイライズ
- **技法**: `feComponentTransfer`（linear slope/intercept で `threshold` 以下を黒に落とす）→ `feGaussianBlur stdDeviation=radius` → `feComponentTransfer`（`intensity` 倍）→ 任意で `feColorMatrix` による `tint` → `feMerge`（SourceGraphic + glow を screen 相当で加算）。2 パス目のブラー（radius×2, 低強度）を足すと安価に「コア+ハロー」の 2 層グロウになる。
- **params**:

| key | kind | default | range | animatable |
|---|---|---|---|---|
| `threshold` | scalar | 0.7 | 0..1 | ✅ |
| `radius` | scalar | 24 | 0..200 (px) | ✅ |
| `intensity` | scalar | 1.5 | 0..8 | ✅ |
| `tint` | color | 白(=無着色) | — | ✅ |
| `quality` | scalar | 1 | 0.1..1 | ✅（2層目の省略・stdDeviation 粗化） |

- **identity**: `intensity === 0 || radius === 0` → `return null`。
- **リスク**: 中の下。`feGaussianBlur` の大 radius はコストが乗るため `quality` ノブ（§27.4 既存規約）を必ず付ける。フィルタ領域クランプにより**グロウがレイヤー矩形外に伸びない**制約が付く（AE と異なる）。→ 初版は「矩形内グロウ」を仕様として明記。矩形外への滲みが必要になったら filter region 拡張の可否を別スパイクで検証（displacement と違い、マップ未定義問題は起きないので pad 拡張は原理上安全。ただし `verify-fast-drift-spike.mjs` 同型の実測を先に取る）。

### 3.5 `scanlines` — CRT / VHS 走査線

- **executionPath**: `live` / **previewBakeRequired**: `false` / **category**: スタイライズ
- **技法**: `ditherPatternMaskSvg()`（`effectSvg.ts:660-684`）と同型の `<pattern patternUnits="userSpaceOnUse">` で「暗ラインタイル」を feImage 化 → `feBlend mode="multiply"`（または `feComposite arithmetic` で `opacity` 制御）。`phase` でパターンの y オフセットを動かすと**ロール（縦流れ）**になる。`direction` enum で縦線（LED 格子風）も。
- **params**:

| key | kind | default | range | animatable |
|---|---|---|---|---|
| `lineHeight` | scalar | 3 | 1..64 (px) | ✅ |
| `duty` | scalar | 0.5 | 0.05..0.95（暗部比率） | ✅ |
| `opacity` | scalar | 0.35 | 0..1 | ✅ |
| `direction` | enum | `"horizontal"` | horizontal / vertical | ❌ |
| `phase` | scalar | 0 | 0..360（1周=1タイル分ロール） | ✅ |

- **identity**: `opacity === 0` → `return null`。
- **リスク**: 極小。既存 dither パターン機構の直系。

---

## 4. Tier 2 — live displacement / seeded 系（fast* 方式の応用）

### 4.1 `noiseGrain` — 動的フィルムグレイン

- **executionPath**: `live` / **previewBakeRequired**: `false` / **category**: スタイライズ
- **技法**: `feTurbulence type="fractalNoise"`（高周波・1 octave）→ `feColorMatrix` で輝度ノイズ化（`monochrome` 時）→ `feComposite arithmetic` で SourceGraphic に加算（±ゼロ平均化: implement-visual-effect スキルの「プロシージャルノイズのゼロ平均性」に従い、arithmetic の intercept で −0.5 シフト）。**フレーム毎にノイズを踊らせる**には `seed` を `baseSeed + ctx.frame` から決定論的に導出（`phaseToSeed` 系譜、INV-1 適合）。`animated: false` なら固定 seed。
- **params**: `amount`(0..1, ✅) / `size`(0.5..8px, ✅) / `animated`(bool, ❌) / `monochrome`(bool, default true, ❌) / `seed`(0..9999, ❌)。
- **identity**: `amount === 0` → `return null`。
- **リスク**: 低。`feTurbulence` は turbulentDisplace / fastTurbulentDisplace で live 実績あり。**ゼロ平均性の計測**（重心・平均輝度が amount に対して不動）を verify で必ず取る。

### 4.2 `glitchSlice` — 水平スライスグリッチ

デジタルグリッチの本丸。画面を水平帯に分割し、一部の帯だけ横に飛ばす。

- **executionPath**: `live` / **previewBakeRequired**: `false` / **category**: ディストーション（軽量）
- **技法**: `lightPixelSortDisplaceMapSvg()`（`effectSvg.ts:894`）が既に確立している「行ストリップ単位の水平変位マップ」の直系。`sliceHeight` ごとの帯それぞれに、seeded 乱数（`seed` + `evolution` 由来）で「変位するか否か（`density`）」と「変位量（±`maxShift` 内）」を決め、R チャンネル一定値の帯として SVG マップに焼く → `feDisplacementMap`。マップはレイヤー全域で定義（未変位帯は 0.5 グレー）＋ region `(0,0,w,h)` クランプ = **fast* と同じ正真正銘 live**。`chromaOffset > 0` なら chromaSplit と同型の primitive を後段に連結し「ずれた帯だけ色収差」風の一体ルックに。
- **params**:

| key | kind | default | range | animatable |
|---|---|---|---|---|
| `intensity` | scalar | 0.5 | 0..1（≒density: 帯が飛ぶ確率） | ✅ |
| `maxShift` | scalar | 60 | 0..500 (px) | ✅ |
| `sliceHeight` | scalar | 24 | 2..256 (px) | ✅ |
| `evolution` | scalar | 0 | deg（回すたび別パターン） | ✅ |
| `seed` | scalar | 0 | 0..9999 | ❌ |
| `chromaOffset` | scalar | 0 | 0..50 (px) | ✅ |

- **identity**: `intensity === 0 || maxShift === 0` → `return null`。
- **リスク**: 中の下。8-bit マップ量子化により `maxShift` が大きいとき変位が ~`maxShift/127` px 刻みになるが、グリッチは元々離散的な表現なので実害なし（wave 等と違い滑らかさ不要 — むしろ好都合）。`LIVE_DISPLACEMENT_EFFECT_TYPES` への追加を忘れない。
- **エクスプレッションとの分担**: 「時々ガッと乱れる」時間演出は effect 側に持たせず、`intensity` への keyframe / expression preset（wiggle 等）で組む。ランタイム側は決定論写像に徹する。

### 4.3 `pixelStretch` — ピクセル引き伸ばし（要スパイク）

1 ラインのピクセルを画面端まで引き伸ばす、acid/editorial 系で頻出のルック。

- **executionPath**: `live`（スパイク成立時）/ **category**: ディストーション（軽量）
- **技法**: 「stretch 開始線より先のピクセルはすべて開始線上をサンプルする」= 変位 `dy = -(y - y0)` の**線形ランプ変位マップ**。`feDisplacementMap` の scale はレイヤー寸法オーダー（最大 ~h px）必要で、8-bit 量子化により `h/127` px 刻みの階段が出る。
- **スパイク（実装前に必須・半日）**: 高さ 1080px 相当で階段状アーティファクトが「味」の範囲か破綻かを実機確認。破綻する場合の代替: ① `sliceHeight` を持つ「階段状ストレッチ」（glitchSlice の縦版・量子化と親和）として仕様化 ② raster 版に転換（その場合 Tier 3 へ降格）。
- **params**: `origin`(0..1, ✅) / `direction`(enum: down/up/left/right, ❌) / `amount`(0..1: 線から先をどこまで潰すか, ✅)。
- **リスク**: 中。スパイク結果次第で仕様確定。**本プラン中唯一 go/no-go 判断が残る displacement**。

---

## 5. Tier 3 — 複合・スパイク先行

### 5.1 `liquidChrome` — Y2K 液体クローム（要スパイク）

acid graphics の象徴。金属光沢が波打つ。

- **executionPath**: `live`（狙い）/ **category**: スタイライズ
- **技法（3 段合成・全部 SVG primitive）**:
  1. `feTurbulence`（低周波・`evolution` で流動）→ `feDisplacementMap`（`fastTurbulentDisplace` 既存部品）で面を波打たせる
  2. 同じ turbulence を bump map として `feSpecularLighting`（`feDistantLight`）でハイライト生成 → `feComposite` で加算
  3. `gradientMap` の `chrome` preset（暗→明→暗→明の非単調テーブル）で金属レンジへ写像
- **前提**: `feSpecularLighting` は**コードベース未使用**。ブラウザ実装差（特に `surfaceScale` 解釈と headless Chromium での一致）があるため、**INV-2（preview / export / bundle 一致）スパイクを実装前に必須**とする。不一致なら lighting 段を捨て、「turbulence 変位 + chrome gradientMap + hyperGlow」の 3 エフェクトスタック（プリセット、§5.2）に後退する — この後退版でも見た目の 8 割は出る。
- **params**: `size`(✅) / `evolution`(✅) / `highlight`(0..2, ✅) / `depth`(surfaceScale, ✅) / `seed`(❌) / `quality`(✅)。
- **リスク**: 中。スパイク結果が仕様を決める。**Tier 1–2 の後に着手**。

### 5.2 ルックプリセット（新スキーマ不要の運用提案）

「VHS」「CRT」「Acid Poster」等の完成ルックは、**新 effect 型ではなく既存エフェクトのスタック定型**として提供する:

- VHS = `chromaSplit(amount:3)` + `scanlines` + `fastWave(amplitude:2, wavelength:大)` + `noiseGrain`
- CRT = `scanlines` + `opticsCompensation(reverse)` + `hyperGlow(弱)`
- Acid Poster = `posterize(4)` + `gradientMap(acid)` + `noiseGrain(粗)`

初版は **doc/レシピ集（散文）として spec §27 に併記**するだけでよい。「ワンクリックでスタック挿入」する UI プリセット機構は将来課題（`EffectInstance[]` を挿入するだけなのでスキーマ変更不要だが、UI 設計が別トピック）。

---

## 6. Spec / INVARIANT への影響（結論: 変更ゼロ）

| 対象 | 影響 |
|---|---|
| **§5 データスキーマ** | **変更なし**。`EffectInstance { type: string, props: Record<...> }`（`schema.ts:101-106`）は open string。新型はレジストリ登録のみ。 |
| **INV-1（resolve 純関数）** | **変更なし**。全エフェクトの `apply()` は純関数。乱数は `seed` + `phaseToSeed` 系譜の決定論導出のみ。 |
| **INV-2（全経路一致）** | **変更なし（遵守対象）**。live SVG filter は preview / export / bundle で同一 primitive が流れる。`feSpecularLighting`（liquidChrome）のみ経路差リスク → スパイクで先に検証。 |
| **INV-3〜INV-6** | 影響なし。 |
| **spec 散文（§27 エフェクト表）** | **追記が必要（実装より先）**。各エフェクトの param 表・identity 条件・live 設計根拠を §27 に追加。散文追記なのでユーザー事前承認は不要だが、本プラン自体の承認を持って着手する。 |

---

## 7. 実装順序とマイルストーン

implementation-loop スキル準拠（spec 先行 → 実装 → verify → progress 記録）。1 フェーズ = 1 PR 粒度。

| Phase | 内容 | 完了条件 |
|---|---|---|
| **A** | カラー3種: `posterize` / `gradientMap` / `chromaSplit` | 純関数テスト（テーブル生成・オフセット算出）+ verify スクリーンショット + `npm run build:player` |
| **B** | 発光・質感: `hyperGlow` / `scanlines` / `noiseGrain` | 同上 + noiseGrain ゼロ平均計測 + glow の quality ノブ動作 |
| **C** | グリッチ: `glitchSlice` | seeded 決定論テスト（同 seed+frame → 同マップ）+ INV-2 verify（preview vs export 1フレーム画素一致）|
| **D** | スパイク→確定: `pixelStretch`（半日スパイク→go/no-go）/ `liquidChrome`（feSpecularLighting INV-2 スパイク→go/後退） | スパイク記録を本ファイルに追記し、確定仕様を spec へ |
| **E** | ルックプリセットレシピを spec §27 に併記 | 散文のみ |

**全 Phase 共通ゲート**（CLAUDE.md「新描画レイヤーオブジェクトの export 正常化」準拠）:

1. `src/runtime/` を触るので毎 Phase 末に **`npm run build:player`**（playerBuildFreshness を緑に）。
2. 既存 verify（`verify-*-export*.mjs`・fast 系 displacement・blend/調整系）の**無回帰確認**。共有ファイル（`effectSvg.ts` / `fastEffects.ts` / `builtinEffects.ts`）への変更は新型追加のみ・既存関数の挙動変更なしを原則とする。
3. displacement 系（glitchSlice / pixelStretch）は `LIVE_DISPLACEMENT_EFFECT_TYPES` 更新 + region `(0,0,w,h)` クランプの実測（重心ドリフトゼロ）。
4. InspectorPanel のエフェクト追加メニューはレジストリ駆動（既存機構）なので個別 UI 作業は原則不要 — category 文字列の新設（「スタイライズ」等は既存を再利用）だけ確認。

---

## 8. 却下・将来送り（理由付き）

| 候補 | 判定 | 理由 |
|---|---|---|
| **datamosh / P フレーム破壊風** | ❌ 却下 | 前フレームの画素履歴が必要。`resolve(comp, frame)` 純関数（INV-1）と根本的に非両立。フレーム履歴バッファという新アーキテクチャの議論が先。 |
| **slit-scan / time displacement** | ❌ 却下 | 同上（複数フレームの合成）。 |
| **echo / motion trail** | ⏸ 将来 | 同上だが、「レイヤーを N 個複製 + expression で時間オフセット」で運用回避可能。プリセットレシピ側で言及。 |
| **neon edge（エッジ検出発光）** | ⏸ 将来 | `feConvolveMatrix`（Sobel）は live 可能だが大レイヤーでコスト未知。`feMorphology` 未使用方針（`effectSvg.ts:697`）とも要整合。hyperGlow で当面代替。 |
| **真の halftone（輝度変調ドット）** | ⏸ 将来 | blur + ドットタイル + discrete threshold の古典 SVG 技法で live 近似可能だが、ドット径の輝度追従精度が低い。`mosaicLite` + `posterize` で近い質感が出るため優先度を下げる。 |
| **sync roll（垂直巻き上がり）** | ❌ 却下 | wrap-around サンプリングが `feDisplacementMap` に無い。`scanlines` の phase ロール + `glitchSlice` で雰囲気は再現可能。 |

---

## 9. 未決事項（実装着手前にユーザー確認したいこと）

1. **Phase A–C の 6 本を先行承認**してよいか（スパイク不要・リスク低・§5/INV 変更ゼロ）。
2. `gradientMap` の preset ラインナップ（thermal / acid / cyber / chrome / duotone）の初期セットはこれで良いか。追加したい定番はあるか。
3. `hyperGlow` 初版の「グロウはレイヤー矩形内に収まる」制約（§3.4）を許容するか。
4. `pixelStretch` / `liquidChrome` のスパイク（Phase D）を Phase A–C と並行で回すか、後回しにするか。
