# §27.3 ディストーションエフェクト — 既知バグまとめ

> **対象（3 種のみ）**: `wave` / `turbulentDisplace` / `ripple`  
> ワイプ系（`linearWipe` / `angularWipe`）は別経路のため本書の対象外。

**状態**: 2026-06-19 更新。**Issue A（ドリフト）** は **解消済み**（Phase 2: Playwright インク centroid ≤2px・adjustment + direct）。**Issue B（プレビュー枠歪み）** は別問題として下記参照（未着手）。

**関連実装**: [effectSvg.ts](../src/runtime/effectSvg.ts) / [builtinEffects.ts](../src/runtime/builtinEffects.ts) / [DomRenderer.ts](../src/runtime/DomRenderer.ts) `applyEffects`

**デバッグ方法**: [.cursor/rules/debug-visual-render-bug.mdc](../.cursor/rules/debug-visual-render-bug.mdc)

---

## Issue A — Amplitude 比例の右下ドリフト（**解消済み**）

> **再現構成（ユーザー確認）**: **調整レイヤー + Turbulent Displace** が主報告。通常 solid への直接 `filter:` も同型。

### 解消（Phase 2 — 2026-06-19 Cursor）

| 項目 | 内容 |
|------|------|
| **根因** | (1) `feTurbulence type="turbulence"` のチャンネル平均バイアス (2) **CSS `filter` / `backdrop-filter` 経路**で foreignObject キャプチャと座標系がずれ Amount 比例 centroid シフト |
| **修正** | **SVG displacement は raster キャプチャ + `rasterizeFilteredImage`**（調整: comp 背面キャプチャ / 通常: レイヤー子キャプチャ）。`backdrop-filter` による displacement は廃止。ノイズは **`fractalNoise` + G チャンネル `feComponentTransfer`**（`FRACTAL_NOISE_G_BIAS_INTERCEPT`）。root `isolation:isolate`、adjustment 存在時下位 displacement レイヤー `overflow:hidden` |
| **検証** | Playwright: adjustment + direct、turbulent Amount 5/20/50/100 で **インク centroid delta ≤ 2px**（comp 座標・host rect 併記） |

### 部分解消（`e337413` — host rect のみ）

| 項目 | 内容 |
|------|------|
| **修正** | userSpaceOnUse filter region + host 実寸 + feTurbulence layer bounds |
| **限界** | host rect 安定 ≠ visual centroid。**Phase 2 で centroid まで解消** |

### 修正方針（記録・Phase 2 で実施済み）

- ノイズ零平均化（`feComponentTransfer`）を `turbulenceDisplace` に追加（turbulence 型は R/G、fractalNoise 型は G）
- adjustment + displacement: **raster 経路**（`runAdjustmentSvgDisplacePipeline`）
- 通常 + displacement only: **raster 経路**（`runDirectSvgDisplacePipeline`）
- adjustment 存在時: 下位 displacement レイヤー `overflow:hidden`
- DomRenderer root `isolation:isolate`

---

## Issue B — プレビュー左端グレー枠の歪み（**未着手・Preview のみ**）

| 項目 | 内容 |
|------|------|
| 症状 | プレビュー comp **左端のグレー線（枠）** までエフェクトがかかり、ゆがんだ枠が見える |
| bundle export | **再発しない**（[BundlePlayer.setupViewport](../src/player/BundlePlayer.ts) に `boxShadow` なし） |
| 有力原因 | [PreviewPanel.tsx](../src/editor/panels/PreviewPanel.tsx) L728 **`boxShadow: "0 0 0 1px #444"`** + adjustment `backdrop-filter` 端サンプリング |
| スコープ | **プレビュー UI のみ**（DomRenderer / export 本体ではない） |
| 対応方針（次タスク） | `boxShadow` を DomRenderer 外ラッパーへ移動、または `outline` / 疑似要素で UI 枠を分離 |

**Issue B は Issue A 完了後に PreviewPanel 側で対応。本書では Issue A を優先。**

---

## Issue C — Fast* distortion 通常レイヤー実体スライド（**解消済み**・2026-06-20）

> **対象**: `fastWave` / `fastRipple` / `fastTurbulentDisplace` のみ（full 版 §27.3 は Issue A で解消済み）。

### 症状（ユーザー報告）

| 構成 | ラスター化 | ドリフト |
|---|---|---|
| **通常レイヤー + Fast*** | なし（CSS filter 直適用） | **実体スライド**（右下に未変形 solid が見える） |
| **Live 調整 + Fast*** | comp 背面 capture | 別症状（follow-up） |

視覚 lock: Solid + Linear Wipe（disabled）+ Fast Turbulent Displace（Amount≈155）。

### 根因

- `DomRenderer.fastDisplaceDirect === true`（PreviewPanel / BundlePlayer）かつ `effectsAreFastDisplacementOnly` → **CSS `filter` 直適用**（canvas なし）
- SVG displacement filter の座標系ずれにより Amount 比例で host / 実体がスライド

### 修正（2026-06-20 Cursor）

| 項目 | 内容 |
|------|------|
| **方針** | Fast* の CSS 直適用を**廃止**。通常レイヤーも `runDirectSvgDisplacePipeline`（self-capture raster）へ統一 |
| **SSOT** | [effectRouting.ts](../src/runtime/effectRouting.ts) `needsSvgDisplaceCapture()` — DomRenderer / pipelineAnalysis 共用 |
| **`fastDisplaceDirect`** | deprecated（常に無視） |
| **Pipeline UI** | 通常レイヤー + Fast* → `raster` 表示 |

### 検証

| ケース | host rect | ink centroid（amount スイープ） | canvas |
|---|---|---|---|
| fastWave | 安定 | ≤ 0.6px | あり |
| fastTurbulentDisplace | **安定** | ~6px（強 amount・エッジクリップ寄与・follow-up） | あり |
| wipe(disabled) + fastTurbulent | **安定** | ~8px（同上） | あり |

**受け入れ**: ユーザー報告の「実体スライド」は **host rect 安定**で解消。fastTurbulent の centroid は map 系と異なり強 displacement 時にエッジクリップでわずかに動く（§27.5 注記）。

---

## Issue C-3 — fastWave/fastRipple を `feImage` → `feTurbulence` 直結で軽量化（**2026-06-21・§27.5 改定4**）

> 軽量化要請（「fastTurbulent と同等の軽さ」「Fast 系は Web で動く前提」）への対応。Issue C-2 で live 化した fastWave/fastRipple はまだ `feImage`（linearGradient/radialGradient の data URI）map を**毎フレーム文字列生成→ブラウザ再デコード**していて fastTurbulent（`feTurbulence` 直結）より重かった。

- **置換**: `fastWaveDisplace` / `fastRippleDisplace`（`effectSvg.ts`）を新設し `feTurbulence`（`type="fractalNoise"`・`numOctaves=1`）純 SVG primitive 直結に。`feImage`/PNG/data URI を一切生成しない＝ GPU ネイティブ・fastTurbulent と同コスト・Web bundle でも軽量。
- **トレードオフ（承認済み）**: 正弦/同心円の見た目は放棄しノイズ歪み近似。`wavelength`/`frequency`/`radius`→`baseFrequency`、`direction`→異方軸、`phase`/`center`→`feOffset` パンへマップ。真の正弦/同心円はフル `wave`/`ripple`（raster）。
- **撤去**: 死んだ `rippleDisplaceMapSvg`/`fastRippleDisplaceMapSvg`/`WAVE_FAST_QUALITY`。
- **検証**: `verify-fast-turbulence-web.mjs`（store 非依存・実ブラウザ filter render）で 3 種すべて変位再現・edgeStd 3.1/4.5/10.6 vs baseline 0・露出なし・errors none。`pad 帯`問題は `feTurbulence` 全域定義（`stitchTiles="stitch"`）なので構造的に無関係。

---

## Issue C-2 — Fast* を raster 無し live へ復帰（**真因特定・2026-06-21**）

> Issue C は raster で「実体スライド」を**隠して**いた。計測スパイク（`verify-fast-drift-spike.mjs`）で真因を特定し、raster 無しの live 経路へ復帰させた（§27.12 改定3）。

### 真因（Issue C の「座標系ずれ」を具体化）

- `createSvgFilterElement` の非 backdrop displacement 経路が filter region を `displacementPadFromScale(scale)` で **pad** していた。
- `feImage` map は (0,0,w,h) 外で未定義 → pad 帯で channel≈0 → 定数 `−scale/2` 変位が内容を引きずる（= 露出ドリフト）。
- raster は出力を W×H にクリップするので pad 帯が隠れていただけ。**raster は対症療法**だった。

### 修正（2026-06-21）

| 項目 | 内容 |
|------|------|
| **方針** | filter region を **(0,0,w,h) にクランプ** → live CSS filter のドリフトが raster と pixel parity（centroid 小数2桁一致）。Fast* は **raster 無し・フォールバック無し**で live 完結 |
| **routing** | `needsSvgDisplaceCapture()` は **full displacement のみ** capture（`hasEnabledFullDisplacement`）。Fast* は `filter` / `backdrop-filter` 直適用 |
| **`fastDisplaceDirect`** | **撤去**（live 無条件） |
| **Pipeline UI** | 通常レイヤー + Fast* のみ → `live` 表示 |
| **export/bundle** | 既存 live SVG 効果（linearWipe 等）と同じ foreignObject 経路で通る。`verify-fast-export-parity.mjs` で固定 |

---

## 再現手順（共通・参考）

1. Solid レイヤーを追加
2. Wave / Turbulent Displace / Ripple のいずれかを付与（3 種とも同型のバグ報告あり）
3. Inspector で **Amplitude**（Turbulent は **Amount**）を上げる（例: 5 → 20 → 50 → 100）
4. Preview で「歪みの見た目」だけでなく **レイヤー実体（ソリッドの塊）の位置** を観察

**期待**: 歪みだけ変わり、レイヤーの論理位置（タイムライン上の position / アンカー基準）は不変。

**実際（報告）**: Amplitude に比例して実体が **右下方向へスライド** する。増加に伴い **左上の見えている領域が減る**（枠外はクリップされるようになったが、重心がずれる感じは残る）。

---

## バグ例 1 — host rect スライド（通常レイヤー `filter:`・**部分解消**）

| 項目 | 内容 |
|------|------|
| 症状 | 通常レイヤーで host DOM rect が Amount 比例で動く（調整レイヤー backdrop とは別症状） |
| **修正** | userSpaceOnUse filter region + host 実寸（`e337413`） |
| **検証** | Playwright hostRect delta 0（通常 solid） |
| **残** | Issue A — adjustment backdrop + **visual centroid** ドリフト |

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
| `e337413` | userSpace filter + host 実寸 | **通常 layer hostRect 安定**。adjustment backdrop ドリフト **残** |

---

## 現行コミット（`main`）の描画パイプライン概要

- DomRenderer: **displacement** filter は `userSpaceOnUse` + 動的 pad。**その他** SVG filter は `-25%/150%` 従来どおり。
- `feImageLayer`: **`userSpaceOnUse` の `(0,0,w,h)`**（[effectSvg.ts](../src/runtime/effectSvg.ts)）
- `EffectRenderCtx`: **レイヤー実寸**（子 border box から測定・調整レイヤーは comp 寸）
- host div の明示 `width/height`（displacement エフェクト有効時）**実装済み**

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
