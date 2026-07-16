# Dither Dissolve 軽量化 — 調査結果 & 実装記録

> 対象: `ditherDissolve` エフェクト（live 経路）の毎フレーム再計算コスト削減。
> spec §5 / INV は変更しない（純関数のメモ化のみ・出力バイト等価）。
>
> **ステータス（2026-07-16 更新）:**
> - ✅ **Opt 1（メモ化）実装・検証・push 済み** — commit `c533a96`（`src/runtime/effectSvg.ts`）。
> - ✅ **Opt 4（白セルのみ emit）実装・検証・push 済み** — commit `bc089bd`（`src/runtime/effectSvg.ts`）。
> - ❌ Opt 3（feTile 化）— スコープ外（据え置き）。
>
> ditherDissolve の軽量化タスクは Opt 1 + Opt 4 でここまで打ち止め（Opt 3 は方針として据え置き）。
> 元は Sonnet 5 low 向けの逐語手順書として書いたが、両 Opt とも実装済みのため、以下は主に
> **実装記録・再現手順・将来の類似タスク（他エフェクトのメモ化等）のテンプレート**として読む。

---

## 0. TL;DR（結論）

- **軽量化の余地は「あった」。** 主因は blueNoise パターンで毎フレーム **4096 個の `<rect>` 文字列生成 + `encodeURIComponent`** をやり直していたこと。
- `reveal` は **64 段に量子化**され、`w / h / pattern` はレイヤー内で固定。よって取りうるマスク文字列は **1 レイヤーにつき最大 64 通り**しかない。毎フレーム作り直すのは**純粋な無駄**だった。
- **✅ 実施済み修整 = `ditherDissolveMask()` の出力文字列をキー `pattern|qStep|w|h` でメモ化**（Opt 1・commit `c533a96`）。
  - 純関数のまま・決定論のまま → **INV-1 / INV-2 を壊さない**。出力は従来と**バイト等価**（verify で実測一致・§4）。
  - 再生 / スクラブ中はキャッシュヒット率ほぼ 100%。文字列生成と URI エンコードが毎フレームから消える。
- Opt 4（白セルのみ emit）は任意の追加最適化（未着手）。**feTile 化（Opt 3）は今回スコープ外**（共有キャプチャ経路を触るため）。

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
  と**メモ化が予定されていたが未実装だった**。今回それを入れた（Opt 1・下記）。

---

## 2. 修整方針

### ✅ Opt 1（実装済み・commit `c533a96`）: `ditherDissolveMask` の結果をメモ化

`src/runtime/effectSvg.ts` の `ditherDissolveMask` に module-level `Map` キャッシュを追加した。
**関数のシグネチャ・戻り値・呼び出し側は一切変えていない**（純関数のまま）。以下は適用済みの内容。

#### やったこと（＝適用済み手順）

1. `src/runtime/effectSvg.ts` を開く。
2. `ditherDissolveMask`（1067 行目付近）の**直前**に、キャッシュ用 Map を宣言する。
3. `ditherDissolveMask` 本体の先頭でキーを組み、キャッシュにあれば返す。無ければ従来ロジックで作って `set` してから返す。

#### 適用済みパッチ

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

#### 守ること（適用時のガード・Opt 4 追随時も同様）

- **戻り値の中身を変えない。** キャッシュミス時のロジックは従来と 1:1。`q >= 1 → ""`、`q <= 0 → allBlack` の分岐順序と結果を保つ。
- **キーに w, h を必ず含める。** サイズ違いのレイヤーで同じマスクを使い回すと表示崩れ。
- **`Math.random` / `Date.now` / DOM を足さない**（INV-1）。この関数は純関数のまま。
- Map の上限は気にしなくてよい（qStep 0..64 × pattern 2 × 実在する (w,h) 数 = 現実的に数十エントリ）。無理に LRU を入れない（複雑化してバグる方が悪い）。

---

### ✅ Opt 4（実装済み・commit `bc089bd`）: blueNoise で「白セルのみ」emit

`ditherPatternMaskSvg` は黒背景の上に全セルの `<rect>` を敷いていたが、背景を黒 1 枚にして **可視（白）セルだけ** rect を出すよう変更した（reveal が低いときの rect 数が激減する — reveal≈0.5 で約半分、低 reveal でさらに少）。

- 出力は**視覚的に同一**（黒背景 + 白セル）だが**文字列は変わる**ため、Opt 1 のキャッシュとは独立に verify のスクリーンショット無回帰確認を実施し、**ピクセル解析値が Opt 1 単独時と完全一致**することを確認した（§4 参照）。
- Opt 1 でキャッシュヒット時のコストはほぼゼロ化していたが、**completion 自体をアニメート中は 64 段の量子化ステップを毎回通過しキャッシュミスが残る**ため、その初回生成コストを下げる狙いで実施。
- 適用済み `ditherPatternMaskSvg` の変更点:

```ts
const cells: string[] = [`<rect width="${tile}" height="${tile}" fill="black"/>`];
for (let y = 0; y < tile; y++) {
  for (let x = 0; x < tile; x++) {
    if (ditherVisibleAt(pattern, x, y, t)) {
      cells.push(`<rect x="${x}" y="${y}" width="1" height="1" fill="white"/>`);
    }
  }
}
```

- **実測（vite-node ベンチ・1920×1080・全 65 量子化ステップのコールドキャッシュ生成）**: blueNoise 74.37ms→29.13ms（**約61%減**）、ordered 1.47ms→0.83ms（**約43%減**）。
- `test/ditherMask.test.ts` の単調性テストは純関数 `ditherVisible*` を見ているため影響なし（実際 unaffected のまま緑）。`verify-dither-dissolve.mjs` のピクセル解析（純色ピクセル数・blueShare）は Opt 1 単独時と完全一致を確認済み。

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

## 4. 検証（Opt 1 は実施済み・結果を記録）

実行コマンド:

```bash
# 1) 型 & 単体テスト
npm run typecheck          # or: npx tsc --noEmit
npm test                   # ditherMask / ditherReveal / effects / effectSvg が緑

# 2) player 再ビルド（ランタイム変更のため必須）
npm run build:player       # public/player.js を更新

# 3) 実機 verify（preview の dither 挙動無回帰）
MAFTER_DEV_HTTP1=1 npm run dev &   # dev サーバ起動（PORT=5173）
node verify-dither-dissolve.mjs    # 純色/混色ピクセル署名で判定
```

### Opt 1 の実測結果（2026-07-15）

| 項目 | 結果 |
|------|------|
| `npm run typecheck` | ✅ 緑 |
| `npm test`（dither/effects/effectSvg） | ✅ 緑。ただし `effects.test.ts > liquidChrome 再登録` の **1 件のみ FAIL** — **変更前から失敗する pre-existing 不良**（`git stash` して baseline でも同一に再現。本変更と無関係） |
| `npm run build:player` | ✅ `public/player.js` 更新済み |
| `verify-dither-dissolve.mjs` のピクセル解析 | ✅ **変更前後で完全一致**（`pureRed 3269 / pureBlue 3459 / blended 113272 / blueShare 0.5141`）＝**出力バイト等価・無回帰を実測で確認** |

> **verify スクリプトの PASS/FAIL について:** スクリプト最終判定は `errors.length === 0` を含むため
> favicon.ico の 404（コンソールエラー収集の環境ノイズ）で FAIL 表示になるが、これは baseline でも
> 同一に再現する既知の無関係事象。**合否は「ピクセル解析値が baseline と一致するか」で判断する**（一致 = 無回帰）。

### 環境メモ（この sandbox 固有）

- dev サーバは既定で HTTPS（HTTP/2）化されるため、`http://localhost:5173` に curl すると 000。
  Playwright verify は `http://` を叩くので **`MAFTER_DEV_HTTP1=1 npm run dev`** で HTTP/1.1 に固定して起動する。
- pre-installed Chromium（`/opt/pw-browsers/chromium`）と `playwright` の revision がずれていて既定 launch が失敗する。
  検証時のみ `chromium.launch({ executablePath: "/opt/pw-browsers/chromium" })` を一時指定して実行した
  （**`verify-dither-dissolve.mjs` 本体はコミットしていない** — sandbox 限定のワークアラウンドのため revert 済み）。

### （任意）軽量化を定量したい場合

`verify-dither-dissolve.mjs` に準じて、`pattern: "blueNoise"`・`completion` をアニメートしながら
`ditherDissolveMask` の呼び出し回数に対する**キャッシュヒット率**、または 60 フレーム連続描画の
所要時間を `performance.now()` で計測して before/after を比較する（proof であって合否ゲートではない）。

---

## 5. 完了状況・残タスク

**Opt 1 は完了済み（2026-07-15）:**

1. ✅ 実装: `src/runtime/effectSvg.ts` メモ化 — commit `c533a96`。
2. ✅ `npm run build:player` → `public/player.js` 更新（同 commit に同梱）。
3. ✅ `progress.md` 追記 — 「2026-07-15（Claude Sonnet 5）— ditherDissolve のメモ化」節 / commit `d002291`。
4. ✅ `git push` 済み（`claude/dither-dissolve-optimization-kysf3s`）。

**Opt 4 も完了済み（2026-07-16）:**

1. ✅ 実装: `ditherPatternMaskSvg` 白セルのみ emit — commit `bc089bd`。
2. ✅ `npm run build:player` → `public/player.js` 更新（同 commit に同梱）。
3. ✅ `progress.md` 追記 — 「2026-07-16（Claude Sonnet 5）— ditherDissolve Opt 4」節。
4. ✅ `git push` 済み（`claude/dither-dissolve-optimization-kysf3s`）。

**残タスク:**

- ❌ Opt 3（feTile 化）は据え置き（§2 スコープ外の理由参照）。ditherDissolve の軽量化タスクは Opt 1 + Opt 4 で完了とし、追加着手は現状予定なし。

---

## 付録: 参照ファイル

- `src/runtime/effectSvg.ts` — `ditherDissolveMask`(1067) / `ditherPatternMaskSvg`(1027) / `bayerMaskSvg` / `blueNoiseMaskSvg` / `maskComposite` / `svgDataUri`。**主対象。**
- `src/runtime/ditherReveal.ts` — `quantizeDitherReveal`（64 段量子化）/ `ditherEffectiveReveal`。
- `src/runtime/ditherMask.ts` — 純関数コア（`ditherVisible*`）と CSS mask 用 `ditherTileDataUrl`（既存の PNG タイルキャッシュ実装例）。
- `src/runtime/builtinEffects.ts:528` — `DITHER_DISSOLVE_EFFECT_DEF`（呼び出し元）。
- `src/runtime/blueNoise64.ts` — 64×64 blue noise LUT（`BLUE_NOISE_SIZE = 64`）。
- `verify-dither-dissolve.mjs` / `test/ditherMask.test.ts` / `test/ditherReveal.test.ts` — 回帰ゲート。
- `.cursor/plans/dither-pattern-modes.plan.md` — pattern 拡張の背景（メモ化予定の出典）。
