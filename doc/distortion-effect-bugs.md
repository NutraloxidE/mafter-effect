# §27.3 ディストーションエフェクト — 既知バグまとめ

> **対象（3 種のみ）**: `wave` / `turbulentDisplace` / `ripple`  
> ワイプ系（`linearWipe` / `angularWipe`）は別経路のため本書の対象外。

**状態**: 2026-06-19 時点で **Amplitude / Amount 増加時の実体スライドは未解決**。複数回の修正試行はコミット済みだが、ユーザー目視では依然として再現する。

**関連実装**: [effectSvg.ts](../src/runtime/effectSvg.ts) / [builtinEffects.ts](../src/runtime/builtinEffects.ts) / [DomRenderer.ts](../src/runtime/DomRenderer.ts) `applyEffects`

**デバッグ方法**: [.cursor/rules/debug-visual-render-bug.mdc](../.cursor/rules/debug-visual-render-bug.mdc)

---

## 再現手順（共通）

1. Solid レイヤーを追加
2. Wave / Turbulent Displace / Ripple のいずれかを付与（3 種とも同型のバグ報告あり）
3. Inspector で **Amplitude**（Turbulent は **Amount**）を上げる（例: 5 → 20 → 50 → 100）
4. Preview で「歪みの見た目」だけでなく **レイヤー実体（ソリッドの塊）の位置** を観察

**期待**: 歪みだけ変わり、レイヤーの論理位置（タイムライン上の position / アンカー基準）は不変。

**実際（報告）**: Amplitude に比例して実体が **右下方向へスライド** する。増加に伴い **左上の見えている領域が減る**（枠外はクリップされるようになったが、重心がずれる感じは残る）。

---

## バグ例 1 — Amplitude 比例の右下スライド（**未解決・主問題**）

| 項目 | 内容 |
|------|------|
| 症状 | Amplitude / Amount を上げると、3 種すべてで実体が右下へ動く |
| 共通化 | Wave / Turbulent Displace / Ripple で **同じバグり方**（displacement 共通パイプライン由来と推定） |
| 視覚の言語化 | 「右下に行く」「左上が減る」「アマウント増加に伴い左上が減っていく」 |
| 単体テスト | SVG primitive 文字列・resolve 経路は緑。DOM + CSS `filter: url(#svg)` 合成は未カバー |

### 仮説（調査済み・未収束）

1. **`feImage` と filter region の座標ずれ**  
   DomRenderer は `<filter>` に `x/y=-25%`, `width/height=150%` を付与（エッジクリップ回避）。  
   `feImage` を `userSpaceOnUse` の `(0,0,w,h)` に置くと map が filter region 原点側に張り付き、`feDisplacementMap` の `(channel − 0.5) × scale` が定数バイアス → Amplitude 比例の位移、と一度は確定した（Playwright centroid 計測でも amp 増加で host が画面外へ）。

2. **`objectBoundingBox` + `%` の feImage**  
   filter region と map を `-25%/150%` で揃える案 → **Chromium CSS filter 経路で map が効かない／左上へ飛ぶ** 回帰（エフェクト消失）。

3. **userSpace + `mx=w·0.25`, `my=h·0.25` オフセット**  
   map 配置は改善したが、**filter region 拡張そのものが CSS 合成で実体を右下へずらす** という別報告が残った。

4. **host div bbox が 0×0**  
   solid 等は子だけサイズを持ち host が 0×0 → filter region 潰れでエフェクト無効化。  
   エフェクト有効時に host に `width/height` を実寸設定する修正で **効果復活**＋**境界線への歪み漏れ**も解消したが、**右下スライドは残存**。

5. **filter region を bbox 100% に戻す（セッション試行・未コミット）**  
   `-25%/150%` 拡張を削除、`feImage` は `(0,0,w,h)` 固定のまま。  
   Playwright: hostRect が amp 5/20/100 で不変と計測したが、**ユーザー目視では依然スライド**。  
   **現行 main のコミットには含まれていない**（filter region 拡張は依然 `-25%/150%`）。

6. **host 実寸 + userSpace feImage オフセット（セッション試行・未コミット）**  
   エフェクト有効時に host `width/height`、feImage を `(w·0.25, h·0.25)` に配置。効果復活・境界漏れ解消の報告あり。**スライドは残存**。

7. **パディング host + 負 margin（セッション試行・未コミット・撤回）**  
   `displacePadForEffects` + host 拡張 + 負 margin。途中停止。**コミットしない**。

---

## バグ例 2 — host 0×0 によるエフェクト無効化（**解消済み**）

| 項目 | 内容 |
|------|------|
| 症状 | ディストーションを付けても歪みが消える、または極端に弱い |
| 原因 | `applyEffects` の filter は host div の border box 基準。absolute 子（solid）のみサイズを持つと host は 0×0 |
| 修正 | エフェクト有効時に host にコンテンツ実寸 `width/height` を設定（コミット済み） |
| 回帰 | 別案（objectBoundingBox feImage）と併用すると再発しうる |

---

## バグ例 3 — 境界線（レイヤー枠外）への歪み漏れ（**解消済み**）

| 項目 | 内容 |
|------|------|
| 症状 | レイヤー矩形の外側（マージン領域・隣接レイヤー境界付近）にも displacement がかかって見える |
| 文脈 | host 0×0 / filter region / feImage 配置の修正過程で顕在化 |
| 修正 | host 実寸設定 + feImage 配置調整の一連で解消（ユーザー確認） |
| 注意 | スライド修正と同時に触ったため、再修正時に再発しうる |

---

## バグ例 4 — objectBoundingBox feImage による左上ジャンプ＋効果消失（**回帰・撤回済み**）

| 項目 | 内容 |
|------|------|
| 症状 | 全ディストーションが左上へ寄り、歪みがほぼ見えない |
| 原因仮説 | `primitiveUnits="objectBoundingBox"` + `%` 指定の `feImage` が Chromium の `filter: url(#id)` 経路で正しく raster されない |
| 対応 | 案を撤回し userSpace + px オフセットへ戻した |
| 教訓 | **単体テスト（SVG 文字列）だけでは検出不能** — Playwright 実機必須 |

---

## 修正試行タイムライン（参考）

| 版 | 内容 | 結果 |
|----|------|------|
| 初期 | filter region `-25%/150%` + feImage `(0,0,w,h)` | 右下スライド（主報告） |
| v1 | feImage `objectBoundingBox` `-25%/150%` | 左上ジャンプ・効果消失 |
| v2 | feImage userSpace `(w·0.25, h·0.25)` + host 実寸 | 効果復活・境界漏れ解消・**スライド残** |
| `29b4222`（コミット） | 正弦波/同心円 map・ワイプ mask 修正・**レイヤー実寸 ctx** | 歪み品質改善。スライドは別問題として残存 |
| セッション v3 | filter region 100% 案 | Playwright hostRect 不変・**目視スライド残**・**未コミット** |
| セッション v4/v5 | host 実寸 / pad + 負 margin | 未完了・**未コミット・採用しない** |

---

## 現行コミット（`main`）の描画パイプライン概要

- DomRenderer: `<filter>` region は **`x/y=-25%`, `width/height=150%`**（blur/feather/displace 端クリップ回避）
- `feImageLayer`: **`userSpaceOnUse` の `(0,0,w,h)`**（[effectSvg.ts](../src/runtime/effectSvg.ts)）
- `EffectRenderCtx`: **レイヤー実寸**（子 border box から測定・調整レイヤーは comp 寸）
- host div の明示 `width/height`（エフェクト用）は **未実装**（セッション試行のみ）

---

## 次に直すときのチェックリスト

1. **測る**: host `getBoundingClientRect`、子要素 rect、**ピクセル重心**（`scripts/debug-displace-centroid.mjs` は一時利用可・コミットしない）
2. **1 パラメータ**: amp 5 / 20 / 50 / 100 で hostRect・centroid・左上インク edge を表にする
3. **分離**: filter region 拡張 / feImage 座標 / host レイアウト / feDisplacementMap scale を **一度に一つだけ** 変える
4. **収束条件**: amp 変化で centroid delta が一定（±2px 以内）かつユーザー目視 OK
5. **回帰**: 境界漏れ・host 0×0・効果消失を再確認
6. **INV-2**: export 経路でも同 DomRenderer インスタンス挙動を確認（別途未検証）

---

## progress / spec との関係

- 本書は **バグ事例の正**（ワイプを含めない）。仕様の正は [mafter-effect-spec.md](mafter-effect-spec.md) §27.3。
- 進捗の要約は [progress.md](../progress.md) §27.3 / 既知のバグ から本書へリンク。
