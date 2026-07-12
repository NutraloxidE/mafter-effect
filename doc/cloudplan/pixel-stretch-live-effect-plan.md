# Pixel Stretch（ピクセルストレッチ）ライブエフェクト 実装プラン — grok-build-0.1 用

> **ステータス**: 実装用ドラフト（ユーザー未承認）。本ファイルは `doc/mafter-effect-spec.md`（SSoT）を置き換えない。
> **実装担当**: grok-build-0.1（本プランは Ticket 単位の作業票として書かれている。Ticket を順番に、1 つずつ実行すること）。
> **前提**: ライブエフェクト（`executionPath: "live"`）として実装する。raster 版は本プランのスコープ外。
> 作成: 2026-07-12 / Claude Code（設計・調査担当）

---

## 0. grok-build-0.1 が最初に読む結論

- 新エフェクト **`pixelStretch`（label: "Pixel Stretch"）** を 1 本追加する。レイヤーの指定位置にある **1px（可変）の帯をサンプリングし、指定方向へ引き伸ばす（スメアする）** 定番グリッチエフェクト。
- 実装方式は **`feOffset`（subregion crop）+ `feTile` + `feMerge` の SVG filter**。**`feDisplacementMap` は使わない。`feImage` / PNG data URI も使わない。**
  - 理由1（品質）: displacement map 方式は 8bit チャンネル量子化により、stretch 長 L に対して約 `2L/255` px 刻みのバンディングが出る（L=500px で約 4px 刻み）。ピクセルストレッチの「1 行がクリスプに伸びる」見た目が壊れる。feTile はピクセル完全コピーなので量子化が存在しない。
  - 理由2（速度）: `feTile` はこのリポジトリで実測済みの最速経路。`mosaicLite` 改定7 が「feImage ネスト文書 → feTile」への置換で `MainFrame.Draw` を 97% 削減した実績がある（`doc/cloudplan/mosaic-lite-phase-a-bench-report.md` §6.7、`src/runtime/effectSvg.ts:631` のコメント）。本エフェクトは feImage すら使わないため、さらに軽い。
- **`DISPLACEMENT_EFFECT_TYPES` / `FAST_DISPLACEMENT_EFFECT_TYPES` / `LIVE_DISPLACEMENT_EFFECT_TYPES` には入れない**（`feDisplacementMap` 非使用のため displacement 用の region clamp・raster capture 配線が一切不要）。既存の `linearWipe` / `pixelSortLite` と同じ「素の live SVG filter」枠で扱う。
- **§5 データスキーマ / INVARIANT / `project.json` 直列化形式の変更は不要**（§6 の影響表を参照）。もし実装中にこの前提が崩れたら、**その Ticket を中断してユーザーへ確認する**（勝手に進めない）。
- `src/runtime/` を触るため、完了前に **`npm run build:player` が必須**（CLAUDE.md「bundle player の再ビルド」節）。
- 触るファイルは原則 **4 つ + spec + progress** のみ: `src/runtime/effectSvg.ts` / `src/runtime/fastEffects.ts` / `test/pixelStretch.test.ts`（新規）/ `verify-pixel-stretch.mjs`（新規）。**`DomRenderer.ts` / `effectChain.ts` / `effectRaster.ts` / `effectRouting.ts` / `exporter` 系は Ticket PS-5b（条件付き）以外で編集禁止。**

---

## 1. エフェクト定義（ビジュアル仕様）

### 1.1 挙動

- レイヤー内の `position`（0..1 正規化）にある **幅 `sampleWidth` px の帯（strip）** をサンプリングする。
  - `direction` が `down` / `up` のとき strip は**横帯**（幅 = レイヤー幅 w、高さ = sampleWidth）。
  - `direction` が `right` / `left` のとき strip は**縦帯**（幅 = sampleWidth、高さ = レイヤー高 h）。
- strip を `direction` の向きへ `length` px ぶん**反復コピーして敷き詰める**（sampleWidth=1 なら全コピーが同一行/列 = 連続スメアに見える）。
- stretch 領域の外は**元画像のまま**（恒等）。stretch 領域は元画像の上に重なる（上書き）。
- stretch は**レイヤー境界 (0,0,w,h) 内にクリップ**される。レイヤー外へは伸びない（v1 制限。§9 Q4）。
- `length <= 0` のときエフェクトは**完全な恒等**（`apply()` が `null` を返し、filter 自体を生成しない）。
- strip 内の透明ピクセルは透明のままスメアされる（alpha も含めてコピー）。

### 1.2 パラメータ（ParamDescriptor — 既存 kind のみ使用・§5 変更なし）

| key | label | kind | default | min | max | step | animatable |
|---|---|---|---|---|---|---|---|
| `direction` | Direction | `enum` | `"down"` | — | — | — | **false** |
| `position` | Position | `scalar` | `0.5` | `0` | `1` | `0.01` | true |
| `length` | Length | `scalar` | `300` | `0` | `4000` | `1` | true |
| `sampleWidth` | Sample Width | `scalar` | `1` | `1` | `64` | `1` | true |

- `direction` の options: `["down", "up", "right", "left"]`。斜め角度は v1 非対応（`feTile` は回転できない。§9 Q5）。
- `position` はレイヤー寸法に対する正規化値。`fastRipple` の `centerX/centerY` と同じ流儀。
- animatable なパラメータは既存のエフェクト param キーフレーム機構（§27.5 resolve / §27.6 Inspector / §27.7 Timeline）にそのまま乗る。**新規 UI 実装は不要**（Inspector ピッカー・foldout・ScrubNumber はすべて registry 駆動で自動）。

### 1.3 filter graph（確定・この通りに実装する）

`direction = "down"`（vertical 軸）の場合:

```
s     = clamp(round(sampleWidth), 1, 64)
y0    = round(clamp01(position) * (h - s))        // strip 上端（常にレイヤー内）
zoneH = min(round(length), h - y0)                 // レイヤー下端でクリップ
zoneY = y0
```

```xml
<feOffset in="SourceGraphic" dx="0" dy="0"
          x="0" y="{y0}" width="{w}" height="{s}" result="strip"/>
<feTile in="strip"
        x="0" y="{zoneY}" width="{w}" height="{zoneH}" result="stretched"/>
<feMerge>
  <feMergeNode in="SourceGraphic"/>
  <feMergeNode in="stretched"/>
</feMerge>
```

- `feOffset dx=0 dy=0` は**恒等プリミティブ + primitive subregion によるクロップ**として使う（`feTile` の反復単位は「入力プリミティブの subregion」なので、strip の subregion 指定がタイル定義になる）。
- `direction = "up"`: `zoneH = min(round(length), y0 + s)` / `zoneY = y0 + s - zoneH`。タイル格子は strip 位置に固定なので、上方向でも strip のコピーが上へ敷かれる（sampleWidth=1 なら全コピー同一で位相の問題なし。s>1 のとき遠端に部分タイルが出るのは仕様として許容）。
- `direction = "right"` / `"left"`: x/y と w/h を入れ替えた鏡像（strip は `x="{x0}" y="0" width="{s}" height="{h}"`）。
- `zoneH <= 0`（または horizontal で `zoneW <= 0`）になったら `apply()` は `null` を返す。
- **`feDisplacementMap` をこの文字列に含めてはならない。** `DomRenderer.createSvgFilterElement()`（`src/runtime/DomRenderer.ts:1526`）は primitives 文字列に `feDisplacementMap` が含まれるかどうかで filter region を (0,0,w,h) にクランプする分岐を持つ。pixelStretch は既定 region（-25%..150%）で正しく動く設計であり、誤ってこの分岐に入れない。
- filter 全体の出力はレイヤー境界内で完結する（feMerge の SourceGraphic がレイヤー実寸、stretched もレイヤー内 subregion）。region clamp は不要。

### 1.4 決定論（INV-1 / INV-2）

- 乱数なし・シードなし。出力は `props`（direction/position/length/sampleWidth）と `ctx.width/height` のみの純関数。
- 同一 frame → 同一 primitives 文字列 → preview / browser export / bundle player で同一描画（INV-2）。`DomRenderer.applyFilterTokens` は primitives 文字列一致で `<defs>` 再構築をスキップするため（`DomRenderer.ts:1487-1492`）、パラメータ静止時の per-frame コストはゼロに近い。

---

## 2. 不採用にしたアーキテクチャ（grok は再検討しないこと）

| 案 | 却下理由 |
|---|---|
| displacement map（線形ランプ PNG + `feDisplacementMap`） | 8bit 量子化で `2·length/255` px 刻みのバンディング。length=500 で約 4px。クリスプな 1px スメアにならない。過去の displacement drift 対策（region clamp・bias）の複雑さも背負う。 |
| `<pattern>` を含むネスト SVG 文書を `feImage` で参照 | mosaicLite 改定6 で実測済みの罠。backdrop-filter 下で Chrome がネスト文書を毎フレーム再ラスタライズし `MainFrame.Draw` ≈21ms/frame（`mosaic-lite-phase-a-bench-report.md` §6.7）。 |
| raster (`executionPath:"raster"` + `processPixels`) | ユーザー要件が「ライブエフェクト前提」。scrub/再生の軽さが目的なので raster 化しない。正確版が将来必要になっても本プランの範囲外。 |
| CSS `transform: scaleY()` 等での DOM 複製 | エフェクトは EffectDef 契約（filter 片を返す純関数）で表現する（§27.2）。DOM 構造をいじる実装は INV-3 / パイプラインに反する。 |

---

## 3. 配線マップ（触る場所・触らない場所）

### 3.1 変更するファイル

| ファイル | 変更内容 |
|---|---|
| `doc/mafter-effect-spec.md` | §27.2 live 一覧（行 2236 付近の表）に `pixelStretch` を追記。§27.3 builtin 一覧と `previewBakeRequired` 初期値リスト（行 2252 付近）に追記。`##### pixelStretch — Pixel Stretch` 散文サブセクションを §27.3 の wipe/pixelSortLite 群の近くに新設。§27.12 の displacement 経路 SSOT には**含まれない**ことを 1 行明記。 |
| `src/runtime/effectSvg.ts` | 純関数 `pixelStretchFilter(opts): string` を追加（§1.3 の filter graph を生成）。補助の座標計算を export してテスト可能にする（例: `pixelStretchZone(direction, position, length, sampleWidth, w, h)` → `{ strip: {x,y,w,h}, zone: {x,y,w,h} } | null`）。 |
| `src/runtime/fastEffects.ts` | `PIXEL_STRETCH_EFFECT_DEF: EffectDef` を追加し `registerFastEffects()` で登録（既存 4 効果と同じ流儀。ファイル名は "fast" だが live 系 builtin の登録場所として既に mosaicLite が居るためここに置く）。 |
| `test/pixelStretch.test.ts`（新規） | 純関数テスト（§7.1）。 |
| `verify-pixel-stretch.mjs`（新規） | Playwright 実機検証（§7.2）。既存 `verify-dither-dissolve.mjs` / `verify-fast-export-parity.mjs` の harness を流用する。 |
| `progress.md` | セッション末の記録（§7.4）。 |

### 3.2 変更してはならないファイル（PS-5b 発動時のみ例外）

- `src/runtime/DomRenderer.ts` / `src/runtime/effectChain.ts` / `src/runtime/effectRaster.ts` / `src/runtime/effectRouting.ts` / `src/runtime/previewDisplacement.ts` / `src/editor/previewCompAnalysis.ts` — displacement 配線と export capture の共有パイプライン。pixelStretch は displacement ではないので**触る必要がない**。
- `src/runtime/effectSvg.ts` 内の `DISPLACEMENT_EFFECT_TYPES` / `FAST_DISPLACEMENT_EFFECT_TYPES` / `LIVE_DISPLACEMENT_EFFECT_TYPES` — **追加しない**。
- `src/core/schema.ts` — §5 型。変更禁止（変更が必要になったら停止・ユーザー確認）。
- `src/editor/effectCategories.ts` — 既存カテゴリを使うため変更不要（§9 Q1 で新カテゴリ案が採用された場合のみ、表示順配列への 1 行追加を許可）。
- exporter / rasterCapture / compFrameCapture / videoElementSync — 全経路共有コード。編集禁止。

### 3.3 自動で配線される場所（コード変更不要・確認のみ）

- Inspector のエフェクト追加ピッカー: `groupEffectsForPicker()` が registry から自動生成。
- パラメータ UI / キーフレーム: ParamDescriptor 駆動で自動。
- effectChain: `resolveEffectChain()` は registry の `apply()` を呼ぶだけ。pixelStretch は displacement 集合外なので `fxMaxDisplaceScale` に寄与しない（正しい挙動）。
- Draft Preview Fast Path（§27.12）: 対象外（`FAST_DISPLACEMENT_EFFECT_TYPES` に入れないため）。live filter は Draft でもそのまま適用される — `linearWipe` と同じ扱い。

---

## 4. EffectDef 実装案（このまま書き起こしてよい）

```ts
// src/runtime/fastEffects.ts に追加
const PIXEL_STRETCH_EFFECT_DEF: EffectDef = {
  type: "pixelStretch",
  label: "Pixel Stretch",
  category: "スタイライズ", // §9 Q1 の推奨。ユーザー裁定で変わり得る
  previewBakeRequired: false,
  executionPath: "live",
  params: [
    { key: "direction", label: "Direction", kind: "enum", default: "down", animatable: false, options: ["down", "up", "right", "left"] },
    { key: "position", label: "Position", kind: "scalar", default: 0.5, animatable: true, min: 0, max: 1, step: 0.01 },
    { key: "length", label: "Length", kind: "scalar", default: 300, animatable: true, min: 0, max: 4000, step: 1 },
    { key: "sampleWidth", label: "Sample Width", kind: "scalar", default: 1, animatable: true, min: 1, max: 64, step: 1 },
  ],
  apply(props, ctx: EffectRenderCtx) {
    const length = Math.max(0, num(props["length"], 0));
    if (length === 0) return null;
    const primitives = pixelStretchFilter({
      direction: str(props["direction"], "down"),
      position: Math.min(1, Math.max(0, num(props["position"], 0.5))),
      length,
      sampleWidth: Math.min(64, Math.max(1, Math.round(num(props["sampleWidth"], 1)))),
      w: Math.max(1, ctx.width),
      h: Math.max(1, ctx.height),
    });
    if (!primitives) return null;
    return { kind: "svg", primitives };
  },
};
```

`pixelStretchFilter()`（`src/runtime/effectSvg.ts`）は §1.3 の座標計算＋文字列生成のみ。`Math.random` / `Date.now` / DOM 参照は禁止（INV-1）。ファイル冒頭の「純関数・INV-1」規約に従う。

---

## 5. パフォーマンス期待値と計測

- 期待値: mosaicLite 改定7（feImage 1 枚 + feTile）で `MainFrame.Draw` ≈0.6ms/frame。pixelStretch は feImage デコードすら無いので**同等以下**を期待する。
- パラメータをアニメートしたときのみ primitives 文字列が変わり `<defs>` が再構築されるが、生成は文字列連結のみ（PNG 焼きなし）で無視できるコスト。
- **scrub / 再生で preview が重いと感じた場合のみ**、`.claude/skills/implement-visual-effect/SKILL.md` の live effect 計測手順（実 Chrome + CDP screencast / Tracing）で `MainFrame.Draw` を計測する。計測せずに実装を変えないこと。

---

## 6. §5 / INV / project.json への影響（変更ゼロが完了条件）

| 項目 | 判断 |
|---|---|
| §5 `EffectInstance` 型 | 変更不要。`type:"pixelStretch"` + `props` 4 キーで表現可能。 |
| §5 `ParamDescriptor` / `EffectDef` | 変更不要。`enum` / `scalar` は既存 kind。 |
| INV-1 | 遵守。`pixelStretchFilter` は入力のみ依存の純関数。乱数なし。 |
| INV-2 | 遵守。同一 primitives が preview / export / bundle に乗る。PS-5 で実測ゲート。 |
| INV-3 | 遵守。Renderer 契約（EffectFilter）内で完結。 |
| INV-5 / INV-6 | 影響なし。 |
| project.json 直列化 | 変更不要。`EffectInstance.props` にキーが増えるだけ（既存スキーマ内）。 |

**停止条件（全 Ticket 共通）**: 上記のいずれかを変更しないと実装できないと判明した場合、作業を止めてその旨を報告し、ユーザーの指示を待つ。§5 型・INVARIANT・直列化形式は grok-build-0.1 の裁量で変更してはならない（CLAUDE.md「運用体制」）。

---

## 7. 検証ゲート（内容の定義。実行タイミングは §8 の Ticket に従う）

### 7.1 純関数テスト（`test/pixelStretch.test.ts`）

1. `length=0` → `apply()` が `null`（恒等）。
2. `direction="down"`, `position=0.5`, `sampleWidth=1`, w=200, h=100 → strip が `y=round(0.5*(100-1))=50`、zone が `y=50, height=min(length, 50)` になる（座標計算 helper を直接検証）。
3. `position=0` / `position=1` で strip がレイヤー内に収まる（`y0 ∈ [0, h-s]`）。
4. `sampleWidth` が 1 未満 / 非整数 / 65 以上を渡されても [1,64] の整数へ clamp。
5. zone がレイヤー端でクリップされる（`position=1, direction="down"` → zoneH は最大でも `s`… ではなく `h - y0 = s` に一致することを確認）。
6. `direction="up"` / `"left"` / `"right"` の鏡像座標。
7. 生成 primitives に `feDisplacementMap` が**含まれない**こと（region clamp 分岐への誤流入防止・回帰ガード）。
8. 生成 primitives に `feTile` と `feMerge` が含まれ、`feImage` が含まれないこと。
9. registry 登録: `globalPluginRegistry.getEffectDef("pixelStretch")` が取れる・category / previewBakeRequired / executionPath が仕様どおり（既存 `test/effects.test.ts` / `test/effectCategories.test.ts` に倣うか、本テストファイル内でよい）。

### 7.2 Playwright 実機検証（`verify-pixel-stretch.mjs`）

既存 `verify-dither-dissolve.mjs` 等の起動 harness（vite dev + Playwright/Chromium）をコピーして作る。検証項目:

1. **スメア正当性**: 上半分が赤・下半分が青の solid（またはテスト画像）に `direction="down", position=0.25, length=大` を掛け、stretch zone 内の全行が strip 行と同色になることをスクリーンショットの pixel 読みで assert。
2. **恒等領域**: zone 外のピクセルが effect 無し時と一致。
3. **length=0 恒等**: effect 有効 + length=0 と effect 無しのスクリーンショットが一致。
4. **アニメーション安定**: `position` を keyframe し、複数 frame で zone 位置が期待どおり動く（frame 間で意図しないズレ・ちらつきがない）。
5. **preview / export 一致（INV-2）**: 同一 frame の preview スクリーンショットと browser export（mp4 か PNG 連番）の該当 frame を比較し、strip/zone 境界位置が一致。

### 7.3 既存回帰ゲート（置き換え禁止・追加実行）

- `npm run typecheck`
- `npm test`（export / raster / bundle / effect 関連含む全部）
- `verify-fast-export-parity.mjs`（displacement 系の既存 PASS が維持されること — 共有ファイル `effectSvg.ts` を触るため）
- solid+text+image のみのコンプの browser export が従来どおり成功すること（既存 verify のいずれかで確認）
- `npm run build:player` → `test/playerBuildFreshness.test.ts` が緑
- HTML bundle export に pixelStretch が反映されること（bundle player は preview と同じ live filter 経路なので、export した zip の HTML を開いて 1 frame 目視 or 既存 `verify-bundle-export.mjs` の流儀で確認）

### 7.4 progress 記録

`progress.md` に完了内容・実行した検証・未解決リスク・次の一手を追記（CLAUDE.md「進捗管理ルール」）。

---

## 8. grok-build-0.1 用 Ticket 分解（この順で 1 つずつ。**次の Ticket へ勝手に進んでよいが、停止条件に当たったら即中断**）

### PS-0: 現状確認（read-only・コード変更禁止）

- **目的**: 実装前提の再確認。ズレがあれば報告して停止。
- **読むもの（これ以外を漁らない）**: `CLAUDE.md` / `progress.md` の「Next steps」/ `doc/mafter-effect-spec.md` §27.0–§27.5・§27.12 / `src/runtime/plugin.ts` / `src/runtime/fastEffects.ts` / `src/runtime/effectSvg.ts`（mosaicGridSnapFilter と feTile コメント）/ `src/runtime/effectChain.ts` / 本プラン全文。
- **完了報告**: 「前提一致 / 不一致点リスト」を 5 行以内で。
- **停止条件**: `EffectDef` 契約や registry の形が本プラン §4 と食い違う場合。

### PS-1: spec 追記（doc のみ・コード変更禁止）

- **目的**: 「先に仕様、次に実装」（SSoT 維持）。
- **許可ファイル**: `doc/mafter-effect-spec.md` のみ。
- **内容**: §3.1 の表に列挙した 4 箇所。散文のみ。§5 型・INV・直列化の節は編集禁止。
- **テスト**: なし（`git diff` が doc のみであること）。
- **完了報告**: 追記した節番号の一覧。

### PS-2: `pixelStretchFilter` 純関数 + 単体テスト

- **目的**: filter graph 生成の純関数を先に固める。
- **許可ファイル**: `src/runtime/effectSvg.ts`（追記のみ・既存関数の変更禁止）/ `test/pixelStretch.test.ts`（新規）。
- **手順**: §1.3 の座標計算 helper と primitives 生成関数を追加 → §7.1 のテスト 1–8 を実装。
- **コマンド**: `npm run typecheck && npx vitest run test/pixelStretch.test.ts`（テストランナーが vitest 以外なら `npm test` の流儀に従う）。
- **停止条件**: 既存 `effectSvg.ts` の関数シグネチャを変えたくなったとき。

### PS-3: EffectDef 登録

- **目的**: registry へ配線し UI / resolve に乗せる。
- **許可ファイル**: `src/runtime/fastEffects.ts` / `test/pixelStretch.test.ts`（§7.1-9 追加）。
- **手順**: §4 のコードを追加し `registerFastEffects()` に 1 行追加 → registry テスト。
- **コマンド**: `npm run typecheck && npm test`（全件。既存テストを 1 本も壊さないこと）。
- **禁止**: `DISPLACEMENT_EFFECT_TYPES` 系 Set への追加。`effectChain.ts` の編集。

### PS-4: player 再ビルド + 実機検証スクリプト

- **目的**: 実ブラウザでの見た目と INV-2 を固定する。
- **許可ファイル**: `verify-pixel-stretch.mjs`（新規）/ `public/player.js`（`npm run build:player` の生成物として）。
- **手順**: ① `npm run build:player` ② §7.2 の verify を作成・実行 ③ 失敗したら PS-2/PS-3 の範囲内で修正して再実行。
- **コマンド**: `npm run build:player && node verify-pixel-stretch.mjs`。
- **停止条件**: 修正が §3.2 の禁止ファイルに及ぶ場合（→ PS-5b の判断材料として報告）。

### PS-5: export / bundle 無回帰確認

- **目的**: 「新型だけ直して他経路が静かに壊れる」事故の防止（CLAUDE.md「export 正常化」節）。
- **許可ファイル**: なし（実行と報告のみ）。
- **手順**: §7.3 を全部実行。加えて pixelStretch 付きコンプの browser export（mp4 または PNG 連番）で 1 frame を preview と比較（§7.2-5 と同一 harness でよい）。
- **完了報告**: 実行したコマンドと PASS/FAIL の表。

### PS-5b（**条件付き** — PS-4/PS-5 で「export フレームだけ pixelStretch が消える / 空白になる」場合のみ発動）

- **背景**: browser export は foreignObject capture 経由。`mosaicLite` は capture が空白化したため、export composite の通常レイヤーだけ `rasterizeFilteredImage` で焼く特例がある（`DomRenderer.ts:1388` `forceMosaicLiteExportCapture`、spec §27.12）。pixelStretch は `feImage` を使わないため空白化しない見込みだが、実測で出た場合の対処を定義しておく。
- **手順**: ① 症状（どの経路・どの frame で消えるか）を報告して**ユーザー確認を待つ** ② 承認後: `forceMosaicLiteExportCapture` の条件を `mosaicLite` ハードコードから `FORCE_EXPORT_CAPTURE_EFFECT_TYPES: Set<string>`（`effectSvg.ts` に定義・`mosaicLite` + `pixelStretch`）へ一般化し、`DomRenderer.ts` の当該 1 箇所のみ書き換える ③ §7.3 を全部再実行（特に mosaicLite export の無回帰）。
- **禁止**: 全レイヤー・全型一律の capture 挙動変更。

### PS-6: 仕上げ

- **許可ファイル**: `progress.md` / 本プランのステータス行。
- **手順**: §7.4 の progress 追記 → 本ファイル冒頭ステータスを「実装済み（検証ログへのリンク）」へ更新 → コミット。
- **コミットメッセージ例**: `feat(effects): add pixelStretch live effect (feTile smear)` ほか Ticket 単位で分割コミット可。

---

## 9. オープン質問（実装前にユーザー裁定が望ましいもの・推奨付き）

| # | 質問 | 推奨 |
|---|---|---|
| Q1 | カテゴリは「スタイライズ」（pixelSortLite と同じグリッチ系）か「ディストーション（軽量）」か | **スタイライズ**。displacement 系配線と無関係であることをカテゴリでも示唆できる |
| Q2 | 「レイヤー端まで伸ばす」専用オプション（`toEdge` bool）を v1 に含めるか | **含めない**。`length` を大きくすれば端まで届く。要望が出たら後付け（bool 追加は破壊なし） |
| Q3 | 両方向同時 stretch（`both`）を v1 に含めるか | **含めない**。エフェクトを 2 個重ねれば表現可能（配列順 = 適用順）。 |
| Q4 | レイヤー境界の外へ stretch を伸ばす（region 拡張）か | **v1 はレイヤー内クリップ**。境界外描画は export capture / parity の検証面積を増やすため、要望が出てから別途 |
| Q5 | 任意角度対応 | **非対応のまま**。feTile は回転不可。必要なら将来 displacement-map 変種（量子化許容の別エフェクト）として設計する |

推奨のまま実装を開始してよい（ユーザーが本プラン承認時に異議を出さなかった場合、推奨 = 決定として扱う）。

---

## 10. 参照

- `doc/mafter-effect-spec.md` §27（特に §27.2 / §27.3 / §27.5 / §27.12）
- `doc/cloudplan/mosaic-live-effect-for-codex.md`（同型の live effect 追加プランの前例）
- `doc/cloudplan/mosaic-lite-phase-a-bench-report.md`（feTile が速い実測根拠）
- `src/runtime/plugin.ts`（EffectDef 契約）
- `src/runtime/effectSvg.ts`（`mosaicGridSnapFilter` = feTile 前例 / `lightPixelSortFilter` = feMerge 合成前例）
- `src/runtime/fastEffects.ts`（登録の前例）
- `src/runtime/effectChain.ts` / `src/runtime/DomRenderer.ts:1518-1545`（filter region 分岐 — 読むだけ・触らない）
- `.claude/skills/implementation-loop/SKILL.md` / `.claude/skills/implement-visual-effect/SKILL.md`
- `CLAUDE.md`（bundle player 再ビルド義務・export 無回帰ゲート・進捗管理ルール）
