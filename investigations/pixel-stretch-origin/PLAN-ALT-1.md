# PLAN-ALT-1 — pixelStretch サンプル線の手動バイアス（`lineBias`）

対象 Issue: [ISSUE.md](ISSUE.md)
前提: [PLAN.md](PLAN.md) の ink-basis 自動測定（`failed/pixelstretch-ink-basis-attempt-1`）は**残差あり**で失敗。
ズレは相変わらず「若干、奥（ライン後方＝ストレッチが伸びる側）がサンプルされる」。

> **この PLAN の狙い**
> ink bbox の自動推定に頼らず、**サンプル線を px 単位で手動オフセットできるパラメータ**を足す。
> ユーザーが実機で目視調整し、収束した値を**フィードバックとして返す → その値を default（基準値）としてコードに焼く**。
> つまり本 PLAN は「調整ツマミを出す WP-1〜2」と「返ってきた基準値を焼く WP-3」に分かれる。

---

## 設計決定（この PLAN の正）

### AD-1. バイアスは ink 測定と独立・純粋な線オフセット
`linePos` の解決結果（現状 `Math.round(clamp01(linePos) * n)`）に、**符号付き px オフセット `lineBias` を加算するだけ**。
ラスタ測定・型分岐・ctx 拡張は一切足さない（PLAN.md の WP-2〜5 の配線を導入しない）。
`line` は 1D（ストレッチ軸上）なので、**軸方向の符号付き 1 値で上下左右すべてを表現できる**:

- direction=`right`/`left` → `lineBias` は **x 方向** px（+ で右、− で左）
- direction=`down`/`up` → `lineBias` は **y 方向** px（+ で下、− で上）

「奥がサンプルされる」= ストレッチが伸びる側にズレている、なので**伸びと逆向きの符号**で詰める想定。
実際の符号・大きさは実機調整で決める（WP-2 の目的）。

### AD-2. `linePos`（相対）はそのまま。`lineBias`（絶対 px）は独立ツマミ
- `linePos` = 0..1 の相対位置（既存・アニメート可）。
- `lineBias` = px の微調整（新規・アニメート可・default は WP-3 で確定するまで `0`）。
- 合成: `line = round(clamp01(linePos) * n + lineBias)`、その後 `[0, n-1]` に clamp。

### AD-3. スキーマ・直列化に触れない
effects props は free-form（§5 スキーマ・project.json 直列化の対象外）。
`EffectRenderCtx` / `EffectDef` にも新フィールドを足さない（PLAN.md との差分＝**ずっと軽い**）。
INV 表・§5 型は無変更。

### AD-4. INV-2 は構造的に自動満足
`lineBias` は `pixelStretchDisplaceMaps` 内の純粋な数値演算のみ。preview / browser export / headless export は
同じ `pixelStretchPrimitives` を通るため、追加の一貫性配線なしで一致する（INV-1/INV-2 準拠）。

---

## WP-1: コア — `lineBias` を線計算に加算

**ファイル: [src/runtime/effectSvg.ts](../../src/runtime/effectSvg.ts)**

1. `PixelStretchOpts`（`effectSvg.ts:166`）に optional 追加:
   ```ts
   /** サンプル線の手動オフセット(px, 符号付き)。ストレッチ軸に沿って加算。未指定=0。 */
   lineBias?: number;
   ```
2. `pixelStretchDisplaceMaps`（`effectSvg.ts:183`）の `line` 計算を変更:
   ```ts
   const rawLine = clamp01(opts.linePos) * n + (opts.lineBias ?? 0);
   const line = Math.max(0, Math.min(n - 1, Math.round(rawLine)));
   ```
   帯・target の式はそのまま（`line` の定義だけ変わる）。既存の暗黙 clamp（`target[i]` が
   `line±offset` で range 外に出ないこと）は `line` を `[0,n-1]` に収めたことで従来どおり保たれる。

**完了条件（回帰ゲート）:** `lineBias` 未指定 or `0` のとき stage1/stage2 出力が**変更前と bit 同一**。
既存の [measure-directions.mjs](measure-directions.mjs) / [measure-tilted.mjs](measure-tilted.mjs) が従来値のまま。

---

## WP-2: パラメータ露出（調整ツマミを実機に出す）

**ファイル: [src/runtime/fastEffects.ts](../../src/runtime/fastEffects.ts)（`PIXEL_STRETCH_EFFECT_DEF`, `fastEffects.ts:196`）**

1. `params` に追加（`linePos` の直後）:
   ```ts
   { key: "lineBias", label: "Line Bias", kind: "scalar", default: 0, animatable: true, min: -200, max: 200, step: 1 },
   ```
   > `default: 0` は**暫定**。WP-3 で実測基準値に差し替える（変えるのは default だけ）。
2. `apply` 内:
   ```ts
   const lineBias = num(props["lineBias"], 0);
   return {
     kind: "svg",
     primitives: pixelStretchPrimitives({ w, h, direction, linePos, length, density, lineBias }),
   };
   ```

**完了条件:** typecheck 緑。Inspector に "Line Bias" スライダが出る（params 定義から自動生成）。
`lineBias` を動かすと帯の起点列/行がリアルタイムに px 単位で移動する。

---

## WP-2.5: ユーザー実機調整（← ここでボールをユーザーへ渡す）

Cursor/Claude はここで**停止し、ユーザーに調整を依頼する**。

1. `npm run dev` 起動。代表シナリオを開く（ISSUE の centered diamond `linePos=0.15` 系、
   および調整レイヤー + pixelStretch の実ケース）。
2. ユーザーが "Line Bias" を動かし、**起点が意図位置に一致する値**を direction ごとに記録:
   - direction=right / left / down / up それぞれで「奥ズレが消える px」
   - できれば linePos を変えても一定オフセットで合うか（＝定数バイアスで足りるか、`linePos` 依存か）を 2〜3 点で確認
3. ユーザーは値を**フィードバックとして返す**（例: `right: +6px, down: +5px, ...` / または「全方向 +6 で合う」）。

> **判断材料の記録先:** 返ってきた実測値と観察（定数で合う/linePos 依存か）を本ファイル末尾
> 「## 実測ログ」に追記してから WP-3 に進む。

---

## WP-3: 返ってきた基準値を焼く

ユーザー FB の性質で分岐:

- **A) 全 direction 共通の定数で合う場合** → `params` の `lineBias` `default` をその値に変更するだけ。
  ユーザーは以後ツマミで微調整可能。最小変更。
- **B) direction ごとに違う定数の場合** → `apply` 内で direction 別の**基準オフセット定数表**を用意し、
  `lineBias`（ユーザー入力）に加算:
  ```ts
  const DIR_BASE_BIAS = { right: 6, left: -6, down: 5, up: -5 }; // ← 実測で確定
  const lineBias = DIR_BASE_BIAS[direction] + num(props["lineBias"], 0);
  ```
  → ツマミ default は `0`（基準はコード側、ユーザー入力は差分）。
- **C) linePos 依存（定数で合わない）の場合** → 本 PLAN の手動バイアスでは根治不可。
  ink-basis（PLAN.md）へ戻すか、`linePos` に対する 1 次補正式を実測 2 点から立てる（要追加相談）。

**完了条件:** 代表シナリオで奥ズレが目視 0（±1px）。`lineBias` 未入力（＝基準のみ）で
既存 full-solid シナリオが不変（full-box は ink==box なので基準バイアスを入れると逆にズレる懸念
→ **基準バイアスは "ズレるソース" にだけ効くべき**。full solid で bias≠0 が悪さするなら B/C の適用範囲を再検討）。

> ⚠️ 注意: full solid（inset 0）は本来ズレていない。定数バイアスを全体に足すと full solid を**逆にズラす**。
> WP-2.5 で full solid でも bias が要るか必ず確認する。要らないなら「バイアスは default 0 のツマミのみ・
> 基準焼き込みはしない（ユーザーが必要時に手で入れる）」= 案 A の default 0 維持が最も安全。

---

## WP-4: spec / player / 記録

1. `doc/mafter-effect-spec.md` §27.3 pixelStretch 節に `lineBias`（手動 px オフセット）を追記。
   **§5 / INV 表は触らない。** `EffectRenderCtx` 拡張なし（PLAN.md と違い plugin API 節の変更不要）。
2. **`npm run build:player` を実行**（`src/runtime/effectSvg.ts` を触るため必須。`playerBuildFreshness` 通過）。
   HTML bundle export で `lineBias` が効くことを 1 ケース確認。
3. `progress.md` 更新: 手動バイアス導入・実測基準値・案 A/B/C のどれを採ったか・残課題。

---

## PLAN.md との関係

- PLAN.md（ink 自動測定）は**保留**。本 ALT-1 で実測バイアスを収集し、
  「定数で足りる（A/B）」なら ink 測定の複雑な配線（WP-2〜5）を**丸ごと不要にできる**。
- 「linePos 依存（C）」と判明した場合のみ、実測を根拠に ink-basis へ戻す判断をする。

## やらないこと

- ラスタ測定・alphaBBox・ctx.contentBox・needsContentBox 配線（＝PLAN.md WP-1/2/3/4/5）。
- 型別 ink 算出（font metrics 等）。
- §5 スキーマ・project.json 直列化変更。

---

## 実測ログ（WP-2.5 の結果をここに追記）

<!-- direction / linePos / 合った lineBias / 定数 or linePos依存 / full solid で bias 要否 -->
