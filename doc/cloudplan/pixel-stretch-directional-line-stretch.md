# Pixel Stretch（Directional Line Stretch）— 独立作業票

> **位置づけ**: acid-digi-hyper-live-effects-plan（-Detailed）とは **独立したエフェクト**。
> acid-digi プラン Ticket D-1 の `pixelStretch` spike（線形ランプ・pivot 中心の縦スミア）は
> **本票の設計で置き換え（supersede）**、acid-digi プランからは切り離す。§5/INV 変更ゼロ。
> 作成日: 2026-07-13 / 対象ブランチ: `feature/acid-digi-hyper-phase-a-posterize-gradientmap`

---

## 0. なぜ独立票にしたか（整理の結論）

「pixelStretch」を巡って **別物の3つ** が混ざっていたので分離する。

| # | 名称 | 何をするか | 本票での扱い |
|---|---|---|---|
| ① | **acid-digi D-1 spike `pixelStretch`**（現行実装） | pivot 中心の対称線形ランプ変位。近傍スミア＋遠方は量子化された剛体シフトコピー | **廃止**（②へ置換）。ユーザー実機判断で「意図と別物」と確定 |
| ② | **`pixelStretch`（本票・Directional Line Stretch）** | あるライン（列/行）を境に、その**ライン上の色を一方向へそのまま塗り延ばす**（今日の参照画像そのもの） | **本票 §2 で実装**（Sonnet 5 委任可の粒度） |
| ③ | **Datamosh Trail / Pixel Smear**（前回フィードバック） | 明るいピクセル/輪郭を起点に、ランダム長で横方向へ複製・残像化。前フレーム混合的な有機スミア | **別エフェクトとして分離・保留**（本票 §3・将来票） |

**要点**: 参照画像（②）は「有限帯の綺麗な決定論ストレッチ」であり、前回フィードバック（③）の
「ランダム長・複数ライン・残像ブレンド＝datamosh 寄り」とは狙う見た目が異なる。両者を1つのエフェクトに
詰め込むと params が破綻するため、**② を正統な `pixelStretch` とし、③ は別型として切り離す**。

前提制約（ユーザー指定）: **ライブ性を高レベルで維持**。したがって②は既存 fast-displacement 経路
（`feImage`(生 PNG) + `feDisplacementMap`）の上だけで完結させ、ラスタ化・毎フレーム nested SVG は使わない
（§2.5/§7c 非該当。plain `feImage` stretch なので feTile-1px 縮小罠にも非該当）。

---

## 1. 参照する既存配線（本票内で自己完結・acid-digi §2 と重複記載しない）

② は displacement 系なので «4 配線点» を踏むが、`pixelStretch` は **既に 3 Set に登録済み**
（`DISPLACEMENT_EFFECT_TYPES` / `FAST_DISPLACEMENT_EFFECT_TYPES` / `LIVE_DISPLACEMENT_EFFECT_TYPES`）。
本票の改修は **helper の中身差し替え + EffectDef の params 変更 + `effectChain.ts` の scale 参照キー変更** が中心で、
Set 追記は不要（type 文字列 `"pixelStretch"` は据え置き）。

- `displaceWithMap(uri, scale, w, h)` は `xChannelSelector="R" yChannelSelector="G"` 固定。
  → **横ストレッチは R、縦ストレッチは G に書く**（現行 D-1 のチャンネル取り違えバグをこの規約で構造的に解消）。
- `feDisplacementMap` は **pull 型**：出力ピクセル `p` は入力 `p + scale·(ch − 0.5)` をサンプルする。

---

## 2. `pixelStretch`（Directional Line Stretch）実装チケット — Sonnet 5 委任可

### 2.1 中核の数学
横ストレッチ（direction=`right`、ソース列 `cx = linePos·w`）で「帯内の全列がソース列 cx を引く」には各列 x で

```
x + scale·(R − 0.5) = cx   ⇒   R = 0.5 + (cx − x)/length      （scale = length）
```

- `x < cx`（帯の手前）: `R = 0.5`（変位0＝原画そのまま）
- 帯内（`cx ≤ x ≤ cx+length`）: `R = 0.5 + (cx − x)/length`（0.5→0）。全列が cx を引く＝**同色ストレッチ**
- `x > cx+length`: `R = 0.5`（原画に復帰＝**有限帯**）

方向4種は軸と符号の切替のみ：

| direction | 軸 | チャンネル | ソース | 帯 |
|---|---|---|---|---|
| right | X | **R** | 列 cx | [cx, cx+len] |
| left  | X | R | 列 cx | [cx−len, cx] |
| down  | Y | **G** | 行 cy | [cy, cy+len] |
| up    | Y | G | 行 cy | [cy−len, cy] |

### 2.2 生 PNG バッファ（冗長軸を潰す＝軽量ライブの担保）
- 横 (`right`/`left`)：値は x のみ依存 → **`w×1`** 生 RGBA（`feImageLayer` が y 方向へ定数ストレッチ）。1920×1 ≒ 7.6KB。
- 縦 (`down`/`up`)：**`1×h`**。
- glitchSlice の 1×h 最適化と同型（[[svg-displacement-map-collapse-redundant-axis]]）。plain `feImage` stretch のため
  feTile-1px 縮小罠（[[svg-fetile-1px-source-vanishes-under-css-scale]]）は**非該当**。

### 2.3 精度メモ（仕様として明記）
帯内で使う R レンジは `[0.5, 0]` の半分のみ（無変位域を厳密に 0.5 に固定する制約上、片側しか使えない）。
256 階調を `length` px に割り当てるため `length ≤ 256` はほぼ厳密、`length=300` で約 ±0.6px の
ソース位置ゆらぎ（軽い滲み）。ストレッチ表現として許容。**scale を増やして精度を稼ぐ改変は不可**
（無変位域が 0.5 でなくなり原画がズレる）。

### 2.4 パラメータ（新スキーマ・旧 `amount`/`pivot` は破棄）

| key | label | kind | default | range | animatable |
|---|---|---|---|---|---|
| `direction` | Direction | enum | `"right"` | right/left/down/up | no |
| `linePos` | Line Pos | scalar | 0.5 | 0–1 | yes |
| `length` | Length | scalar | 300 | 0–2000, step 1 | yes |

`length===0` → `apply` は `null`。`scale = length`。ラベルは `"Pixel Stretch"`（`(spike)` を外す）。

### 2.5 改修ファイル（順序厳守）
1. **`src/runtime/effectSvg.ts`** — `pixelStretchDisplaceMapPng` を全面差し替え：
   ```ts
   export function pixelStretchDisplaceMapPng(opts: {
     w: number; h: number;
     direction: "right" | "left" | "down" | "up";
     linePos: number; length: number;
   }): { uri: string; scale: number } {
     const horiz = opts.direction === "right" || opts.direction === "left";
     const len = Math.max(1, Math.round(opts.length));
     const n = Math.max(1, Math.round(horiz ? opts.w : opts.h));
     const line = Math.round(clamp01(opts.linePos) * n);
     const toSource = opts.direction === "right" || opts.direction === "down"; // 帯が line の後方
     const rgba = new Uint8Array(n * 4);
     for (let i = 0; i < n; i++) {
       // 帯内: |i - line| ∈ [0, len] かつ 正しい向き
       const signedD = toSource ? i - line : line - i; // 0..len が帯
       const inBand = signedD >= 0 && signedD <= len;
       // 帯内は R/G を 0.5 → 0 に落とし、全ピクセルが line をサンプルする
       const ch = inBand ? Math.round((0.5 - (signedD / len) * 0.5) * 255) : 128;
       const o = i * 4;
       rgba[o] = horiz ? ch : 128;     // R (X 変位)
       rgba[o + 1] = horiz ? 128 : ch; // G (Y 変位)
       rgba[o + 2] = 0;
       rgba[o + 3] = 255;
     }
     const [pw, ph] = horiz ? [n, 1] : [1, n];
     return { uri: rgbaToPngDataUri(rgba, pw, ph), scale: len };
   }
   ```
   > 実装者は「帯内の全ピクセルが厳密に `line` をサンプルする（`i + scale·(ch/255 − 0.5)` が `line` に ±1px 収束）」を
   > 単体テストの真値として詰める。`left`/`up` の符号は上式で処理済み。
2. **`src/runtime/fastEffects.ts`** — `PIXEL_STRETCH_EFFECT_DEF` を新 params（`direction`/`linePos`/`length`）へ。
   `apply` は `pixelStretchDisplaceMapPng({ w, h, direction, linePos, length })` → `displaceWithMap(uri, scale, w, h)`。
   `length===0 → null`。ラベルから `(spike)` を外す。
3. **`src/runtime/effectChain.ts`** — `fxMaxDisplaceScale` の `pixelStretch` 分岐を `p["length"]` 読みへ変更
   （旧 `amount` は消えるため generic フォールバックに任せられない。**明示分岐が必要**）。
4. **`src/runtime/effectSvg.ts` の JSDoc** — `pixelStretchDisplaceMapPng` 上のコメントを本設計（Directional Line Stretch）へ書き換え。旧 pivot ランプ／R チャンネルバグの記述は破棄。

### 2.6 テスト（`test/pixelStretch.test.ts` を新スキーマへ）
- 決定論／生 PNG data URI／`scale===length`。
- **真値テスト**：`right`, `linePos=0.5`, `length=100`, w=200 → 帯内各列の R をデコードし
  `x + scale·(R/255 − 0.5)` が全て `line`（±1px）に収束。
- `down` で **G チャンネル**・**`1×h`** バッファであること。
- 冗長軸：`right` の出力が h に非依存（`w×1`）であること。
- `length=0 → null`。3 Set 配線は据え置き回帰（`has("pixelStretch")`）。

### 2.7 完了ゲート
`npm run typecheck` → `npm test -- pixelStretch` → **`npm run build:player`**（`src/runtime` を触るため必須）。
spec `doc/mafter-effect-spec.md` §27.3 `pixelStretch` を「改定2：Directional Line Stretch」へ書き換え。

### 2.8 human 受け入れ（Sonnet 完了条件から除外）
- 実機（`npm run dev`）で参照画像の見た目（あるラインから色が一方向へ引き伸ばされる）を目視確認。
- preview / export / bundle player の 1 フレーム画素一致（INV-2）。
- **ライブ性**：実 Chrome + CDP Tracing で `MainFrame.Draw` がエフェクト無しベースライン同等。

---

## 3. Datamosh Trail / Pixel Smear（③・別エフェクトとして分離・保留）

> **本票では実装しない。** 前回ユーザーフィードバック（明るいピクセル起点・ランダム長・元画像保持・
> 残像/前フレーム混合）を独立エフェクトとして切り出す将来課題。

- **狙い**: 「切ってずらす」ではなく「掴んで引きずる」有機的デジタルスミア。
- **土台候補**: 既存 `pixelSortLite`（`Light Pixel Sort (WIP)`）が「輝度しきい値ゲート＋displacement streak＋
  元画像を lumInv でマージ保持」構造を既に持ち、要件①（明るい部分起点）②（輪郭限定）④（元位置保持）に近い。
  ただし `lightPixelSortDisplaceMapSvg` は SVG `<rect>` 群を `feImage` に渡す**ネスト SVG 文書**（§2.5/§7c の
  重さ罠に該当しうる・`(WIP)` の理由と推測）で、ストリーク長も `streakLength` 一定。
- **設計上の宿題**:
  - ストリーク長のランダム化（短尺+長尺の混在・要件③⑥）。
  - map を生 PNG 化して §2.5 の重さ罠を回避（ライブ維持）。
  - 要件⑤「前フレーム混合」は `resolve()` が純関数（INV-1）で実フレーム画素にアクセスできないため、
    **本物の temporal feedback は不可**。時間差オフセットコピーの重ね合わせ等の近似で疑似する（要 spike）。
- **命名候補**: `pixelSmear` / `datamoshTrail` / `directionalSmear`。
- **ステータス**: 保留。本票②の完了後、別票として起票する。

---

## 4. acid-digi プランとの関係（整理の記録）

- acid-digi-hyper-live-effects-plan-Detailed.md の **Ticket D-1 `pixelStretch` spike は本票 §2 で置換（廃止）**。
  acid-digi プラン側の残タスクは **D-2 `liquidChrome` spike のみ**（本票は D-2 に一切触れない）。
- 本票は acid-digi プランの WP 構造（A〜E）に属さない **独立エフェクト票**。
- ③（Pixel Smear）も acid-digi プランとは無関係の将来エフェクト。
