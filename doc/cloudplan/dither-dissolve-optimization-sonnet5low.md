# Dither Dissolve 軽量化 — 調査結果 & Sonnet 5 low 用 修整手順書

> 対象: `ditherDissolve` エフェクト（live 経路）の毎フレーム再計算コスト削減。
> 実行モデル想定: **Claude Sonnet 5（low）**。手順は逐語的に追える粒度で書く。
> spec §5 / INV は変更しない（純関数のメモ化のみ・出力バイト等価）。

---

## 0. TL;DR（結論）

- **軽量化の余地は「ある」。** 主因は blueNoise パターンで毎フレーム **4096 個の `<rect>` 文字列生成 + `encodeURIComponent`** をやり直していること。
- しかし `reveal` は **64 段に量子化**され、`w / h / pattern` はレイヤー内で固定。よって取りうるマスク文字列は **1 レイヤーにつき最大 64 通り**しかない。毎フレーム作り直すのは**純粋な無駄**。
- **推奨修整 = `ditherDissolveMask()` の出力文字列をキー `pattern|qReveal|w|h` でメモ化する**（Opt 1）。
  - 純関数のまま・決定論のまま → **INV-1 / INV-2 を壊さない**。出力は従来と**バイト等価**。
  - 再生 / スクラブ中はキャッシュヒット率ほぼ 100%。文字列生成と URI エンコードが毎フレームから消える。
- Opt 4（白セルのみ emit）は任意の追加最適化。**feTile 化（Opt 3）は今回スコープ外**（共有キャプチャ経路を触るため）。

---

## 1. 現状パイプライン（コミット確認済み）

エフェクトが有効な**毎フレーム**、以下が走る:

```
DomRenderer (毎frame)
  → DITHER_DISSOLVE_EFFECT_DEF.apply(props, ctx)      // src/runtime/builtinEffects.ts:545
     → ditherDissolveMask(reveal, w, h, pattern)      // src/runtime/effectSvg.ts:1067
        → bayerMaskSvg / blueNoiseMaskSvg
           → ditherPatternMaskSvg(w, h, reveal, pattern)  // effectSvg.ts:1027
              1) tile² 個の <rect> を文字列連結
              2) svgDataUri() = encodeURIComponent(全SVG)
           → maskComposite(...)  // feImage + luminanceToAlpha + feComposite
```

### 毎フレームの主コスト

| pattern | タイル | 生成 `<rect>` 数 | 備考 |
|---------|-------|-----------------|------|
| `ordered` | 8×8 | **64** | 軽いが encodeURIComponent は毎frame |
| `blueNoise` | 64×64 | **4096** | 数KBの文字列生成 + URIエンコード + ブラウザ SVG 再パースを毎frame |

### 重要な観察（＝最適化根拠）

- `reveal` は `quantizeDitherReveal()` で **1/64 刻み**に丸められる（`src/runtime/ditherReveal.ts:4`）。
- `w`, `h`, `pattern` はレイヤー内で不変。
- ⇒ **(pattern, qReveal, w, h) の組み合わせは有限**。同じ入力から同じ文字列を毎フレーム再生成している。
- `.cursor/plans/dither-pattern-modes.plan.md` のリスク表（105 行目）でも
  「pattern 追加でマスク SVG が重い → data URI キャッシュキーに `pattern|seed|qReveal|w|h`」
  と**メモ化が予定されていたが未実装**。今回それを入れる。

---

## 2. 修整方針（Sonnet 5 low はここだけ実装する）

### ✅ Opt 1（必須・低リスク）: `ditherDissolveMask` の結果をメモ化

`src/runtime/effectSvg.ts` の `ditherDissolveMask` に module-level `Map` キャッシュを足す。
**関数のシグネチャ・戻り値・呼び出し側は一切変えない。**

#### やること（逐語）

1. `src/runtime/effectSvg.ts` を開く。
2. `ditherDissolveMask`（1067 行目付近）の**直前**に、キャッシュ用 Map を宣言する。
3. `ditherDissolveMask` 本体の先頭でキーを組み、キャッシュにあれば返す。無ければ従来ロジックで作って `set` してから返す。

#### 参考パッチ（このまま適用してよい）

変更前:

```ts
export function ditherDissolveMask(
  reveal: number,
  w: number,
  h: number,
  pattern: DitherPattern = "ordered",
): string {
  const q = quantizeDitherReveal(reveal);
  if (q >= 1) return "";
  if (q <= 0) return maskComposite(svgDataUri(allBlackMaskSvg(w, h)), 0, w, h);
  const p = normalizeDitherPattern(pattern);
  const maskSvg = p === "blueNoise" ? blueNoiseMaskSvg(w, h, q) : bayerMaskSvg(w, h, q);
  return maskComposite(svgDataUri(maskSvg), 0, w, h);
}
```

変更後:

```ts
// §27.3 Dither Dissolve — reveal は 64 段量子化・w/h/pattern はレイヤー固定なので、
// 取りうる mask 文字列は有限。毎フレームの rect 生成 + encodeURIComponent を避けるため
// (pattern|qStep|w|h) でメモ化する。純関数・決定論のまま（INV-1 / INV-2 不変）。
const ditherMaskCache = new Map<string, string>();

export function ditherDissolveMask(
  reveal: number,
  w: number,
  h: number,
  pattern: DitherPattern = "ordered",
): string {
  const q = quantizeDitherReveal(reveal);
  if (q >= 1) return "";
  const p = normalizeDitherPattern(pattern);
  // qStep は 0..64 の整数。q<=0 の allBlack 分岐もキャッシュ対象に含める。
  const qStep = Math.max(0, Math.min(64, Math.round(q * 64)));
  const key = `${p}|${qStep}|${w}|${h}`;
  const cached = ditherMaskCache.get(key);
  if (cached !== undefined) return cached;

  let result: string;
  if (q <= 0) {
    result = maskComposite(svgDataUri(allBlackMaskSvg(w, h)), 0, w, h);
  } else {
    const maskSvg = p === "blueNoise" ? blueNoiseMaskSvg(w, h, q) : bayerMaskSvg(w, h, q);
    result = maskComposite(svgDataUri(maskSvg), 0, w, h);
  }
  ditherMaskCache.set(key, result);
  return result;
}
```

#### 守ること（Sonnet 5 low へのガード）

- **戻り値の中身を変えない。** キャッシュミス時のロジックは従来と 1:1。`q >= 1 → ""`、`q <= 0 → allBlack` の分岐順序と結果を保つ。
- **キーに w, h を必ず含める。** サイズ違いのレイヤーで同じマスクを使い回すと表示崩れ。
- **`Math.random` / `Date.now` / DOM を足さない**（INV-1）。この関数は純関数のまま。
- Map の上限は気にしなくてよい（qStep 0..64 × pattern 2 × 実在する (w,h) 数 = 現実的に数十エントリ）。無理に LRU を入れない（複雑化してバグる方が悪い）。

---

### ⭕ Opt 4（任意・小リスク）: blueNoise で「白セルのみ」emit

`ditherPatternMaskSvg` は黒背景の上に全セルの `<rect>` を敷いているが、背景を黒 1 枚にして **可視（白）セルだけ** rect を出せば、reveal が低いときの rect 数が激減する（reveal≈0.5 で約半分、低 reveal でさらに少）。

- 出力は**視覚的に同一**（黒背景 + 白セル）だが**文字列は変わる**ため、Opt 1 のキャッシュとは独立に verify のスクリーンショット無回帰確認が要る。
- Opt 1 を入れれば毎フレームコストはほぼ消えるので、**Opt 4 は「初回生成（キャッシュミス）も軽くしたい」ときだけ**やる。**判断に迷うなら Opt 1 のみで確定してよい。**
- やる場合の `ditherPatternMaskSvg` 変更点のみ:

```ts
const cells: string[] = [];
for (let y = 0; y < tile; y++) {
  for (let x = 0; x < tile; x++) {
    if (ditherVisibleAt(pattern, x, y, t)) {
      cells.push(`<rect x="${x}" y="${y}" width="1" height="1" fill="white"/>`);
    }
  }
}
// pattern 内に黒背景を 1 枚敷いてから白セルを重ねる:
// `<rect width="${tile}" height="${tile}" fill="black"/>` を cells の先頭に置く。
```

> ⚠️ Opt 4 を入れるなら `test/ditherMask.test.ts` の単調性テストは純関数 `ditherVisible*` を見ているので影響なし。ただし `verify-dither-dissolve.mjs` のスクリーンショット判定（純色ピクセル数）が閾値で通ることを必ず再確認。

---

### ❌ スコープ外（今回やらない）

- **Opt 3: feTile + PNG タイル化。** `ditherMask.ts` の `ditherTileDataUrl`（8×8 PNG）と同型で blueNoise PNG + `feTile` にすれば feImage ソースが 64×64 PNG 1 枚に縮むが、
  - plan で「feTile 不使用」が明示方針（parity 理由）。
  - **共有キャプチャ経路（rasterCapture / foreignObject / export）** に影響しうる → CLAUDE.md「新描画レイヤーオブジェクトの export 正常化」の横断回帰ゲート対象。
  - Sonnet 5 low の軽量タスクには重すぎる。**やらない。**
- spec §5 型変更・INV 変更・`project.json` 直列化変更（発生しない範囲に閉じる）。

---

## 3. 影響経路（触る前に把握）

| 経路 | 影響 | 対応 |
|------|------|------|
| preview（DomRenderer live） | 直接受益（毎frame軽くなる） | verify で確認 |
| browser export（mp4/webm/PNG） | 同じ `ditherDissolveMask` を通る → 出力バイト等価 | 既存 verify 無回帰 |
| **HTML bundle export（player.js）** | `effectSvg.ts` は `src/runtime` = **player が import** | **`npm run build:player` 必須** |
| INV-2（preview ≡ export） | 同一入力→同一文字列を返すので不変 | — |

> `effectSvg.ts` は `src/runtime` 配下でランタイム側。CLAUDE.md の表より
> **「ランタイム側の helper 変更」→ `npm run build:player` 必須**。完了前に必ず実行する。

---

## 4. 検証手順（この順に実行し、全部緑を確認）

```bash
# 1) 型 & 単体テスト
npm run typecheck          # or: npx tsc --noEmit
npm test                   # ditherMask / ditherReveal / effects / effectSvg が緑

# 2) player 再ビルド（ランタイム変更のため必須）
npm run build:player       # public/player.js を更新

# 3) 実機 verify（preview + export の dither 挙動無回帰）
npm run dev &              # 別ターミナル or background で dev サーバ起動（PORT=5173）
node verify-dither-dissolve.mjs   # PASS を確認（純色/混色ピクセル署名で判定）
```

### 合否基準

- [ ] `npm test` 緑（特に `test/ditherMask.test.ts` `test/ditherReveal.test.ts`）。
- [ ] `node verify-dither-dissolve.mjs` が **PASS**（ordered での純色ピクセル数・completion 0.5 の blueShare が従来通り）。
- [ ] `public/player.js` が更新済み（`playerBuildFreshness` テストが通る）。
- [ ] 目視: エフェクトの見た目が変更前と**区別つかない**（Opt 1 なら文字列バイト等価なので保証、Opt 4 なら要スクショ比較）。

### （任意）軽量化を定量したい場合

`verify-dither-dissolve.mjs` に準じて、`pattern: "blueNoise"`・`completion` をアニメートしながら
`ditherDissolveMask` の呼び出し回数に対する**キャッシュヒット率**、または 60 フレーム連続描画の
所要時間を `performance.now()` で計測して before/after を比較する（proof であって合否ゲートではない）。

---

## 5. 完了後にやること

1. `progress.md` に「ditherDissolve メモ化で毎フレームの mask 文字列生成を除去（INV 不変・バイト等価）」を追記。
2. コミットメッセージ例:
   ```
   perf(dither): memoize ditherDissolveMask by (pattern|qReveal|w|h)

   reveal は 64 段量子化・w/h/pattern 固定のため取りうる mask 文字列は有限。
   毎フレームの rect 生成 + encodeURIComponent を除去。純関数・決定論のまま
   出力はバイト等価（INV-1 / INV-2 不変）。build:player 済み。
   ```
3. `git push -u origin claude/dither-dissolve-optimization-kysf3s`。

---

## 付録: 参照ファイル

- `src/runtime/effectSvg.ts` — `ditherDissolveMask`(1067) / `ditherPatternMaskSvg`(1027) / `bayerMaskSvg` / `blueNoiseMaskSvg` / `maskComposite` / `svgDataUri`。**主対象。**
- `src/runtime/ditherReveal.ts` — `quantizeDitherReveal`（64 段量子化）/ `ditherEffectiveReveal`。
- `src/runtime/ditherMask.ts` — 純関数コア（`ditherVisible*`）と CSS mask 用 `ditherTileDataUrl`（既存の PNG タイルキャッシュ実装例）。
- `src/runtime/builtinEffects.ts:528` — `DITHER_DISSOLVE_EFFECT_DEF`（呼び出し元）。
- `src/runtime/blueNoise64.ts` — 64×64 blue noise LUT（`BLUE_NOISE_SIZE = 64`）。
- `verify-dither-dissolve.mjs` / `test/ditherMask.test.ts` / `test/ditherReveal.test.ts` — 回帰ゲート。
- `.cursor/plans/dither-pattern-modes.plan.md` — pattern 拡張の背景（メモ化予定の出典）。
