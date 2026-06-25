# MP4 export — Live 調整レイヤー parity 崩れ（Comp 10）

> **対象**: Live 調整レイヤー（`isAdjustment: true` / `adjustmentMode` 省略 = `"live"`）経由の effect  
> **通常レイヤー直付け effect** は本 issue の対象外（問題なし）。  
> **状態**: 2026-06-25 **解消**。① effect 欠落＝3D subtree flatten 除去で解消、② その後の**ちらつき**＝export 合成を bake（live DOM 破壊）からオフDOM・ステートレス compositor へオーバーホールして根絶（§下部「ちらつき解消」）。  
> **再現データ**: `for-debug-data/mafter-project (7).zip` → **Comp 10**

**関連 spec**: §27.4 / §27.4.1 / INV-2  
**関連実装**: [exporter.ts](../../src/runtime/exporter.ts) / [DomRenderer.ts](../../src/runtime/DomRenderer.ts) / [effectRouting.ts](../../src/runtime/effectRouting.ts)

**検証スクリプト**: `verify-comp10-export-parity.mjs` / `verify-export-adjustment.mjs`（※現状の検証は不十分 — 後述）

---

## 症状の変遷（ユーザー確認）

| 段階 | MP4 export の挙動 |
|------|-------------------|
| **当初** | preview と大きく異なる。Live 調整で effect が効き始めると **下位コンテンツが消える** |
| **現状（2026-06-25 時点）** | **消える症状は解消**したが、**調整レイヤー経由の effect が MP4 で効かない** |

| 経路 | 調整レイヤー effect | 下位コンテンツ |
|------|---------------------|----------------|
| **Preview パネル** | 効く | 表示される |
| **HTML bundle export** | 効く | 表示される |
| **MP4 export（現行コード）** | **効かない** | 表示される |

重要な観察（一貫）:

- 「effect が弱い」のではなく **効いていない**（当初は消えて見えた）。
- **レイヤー直付け effect**（通常レイヤーの `filter`）は MP4 でも問題なし。
- **調整レイヤー経由**の effect だけが MP4 でおかしい。

Comp 10 代表フレーム: **f100**（z=14 調整が blur + fastTurbulentDisplace 中、3D ネスト comp `camera wiggle expression` が下位）。

---

## spec 上の「真」（確定）

| モード | Preview / HTML bundle | MP4 / PNG export（目標） |
|--------|----------------------|--------------------------|
| **Live 調整**（既定） | `backdrop-filter`（§27.4） | **preview と同じ見た目**（INV-2） |
| **Raster 調整**（`adjustmentMode="raster"`） | comp 背面 capture bake | 同左（常に bake） |
| **通常レイヤー effect** | `filter` 直付け | 同左 |

- **Preview パネルの見た目 = Live 調整の正**。
- `resolve()` の scene 解決値は preview / export で同一（INV-2 本体）。差はレンダリング方式のみ。
- §27.4 散文の **`auto_raster_mp4`** — export では `backdrop-filter` が foreignObject ラスタ化で欠落するため、Live 調整を comp 背面 capture で bake して見た目を維持する、という設計。**現行コードはこの bake を外しているため effect 欠落が起きている**。

---

## 二つの経路と trade-off（核心）

MP4 export は最終的に `captureElementToCanvas(root)`（SVG foreignObject）で DOM をピクセル化する。この経路には **live `backdrop-filter` が効かない**（§27.4 実証済み前提）。

| 経路 | 実装 | 調整 effect | 下位コンテンツ（3D ネスト comp 等） |
|------|------|-------------|-------------------------------------|
| **A. live backdrop** | `forceAdjustmentRaster: false`（**現行**） | **効かない**（foreignObject が backdrop を焼けない） | **表示される** |
| **B. comp 背面 bake** | `forceAdjustmentRaster: true` + `flushExportComposite` | **焼けば効く** | **bake 失敗時に消える**（Comp 10 f100） |

**現状は A を採用したため「消える」は直ったが「effect が効かない」に逆転している。**  
**目標は B を直して両方満たすこと**（bake で effect を焼きつつ、3D ネスト comp を正しく capture する）。

---

## 真因の整理

### 1. foreignObject は `backdrop-filter` 非対応（effect が効かない理由）

Preview パネルはブラウザ compositor が live DOM に対して `backdrop-filter` を適用する。  
MP4 export は foreignObject 経由の 1 枚キャプチャのため、**調整 div の `backdrop-filter` は最終フレームに反映されない**。

現行 exporter（[exporter.ts](../../src/runtime/exporter.ts) L108–111）:

- `forceAdjustmentRaster` **未設定**（= false）
- `flushRasterEffects()` のみ — Live 調整の async bake を待たない
- 結果: 下位レイヤーは DOM に残るが、**調整 effect はキャプチャに載らない**

### 2. comp 背面 bake + 下位抑制（消える理由・旧経路）

`forceAdjustmentRaster: true` 時、DomRenderer は Live 調整を comp 背面 capture → filter 適用 → full-comp canvas overlay に差し替える。

`finalizeRasterPresentation` 後:

1. `reapplyAdjustmentSuppression()` — adjustZ 未満を **`visibility: hidden`**
2. 調整 div 上の **canvas のみ**が下位の代替

Comp 10 f100（bake 経路・修正前）の DOM 状態:

| z | レイヤー | visibility | 備考 |
|---|---------|------------|------|
| &lt; 140 | Solid / Text / ネスト comp 等 | **hidden** | 抑制 |
| 140 | Adjustment（blur + displace） | visible | canvas 1920×1080 |
| &gt; 140 | Camera / Solid 等 | visible | 上位 |

**bake 結果が 3D ネスト comp（`threeD: true` + `preserve-3d`）を正しく再現できず**、canvas がグレー一色相当 → 下位 hidden のまま → **コンテンツが消えたように見える**。

ネスト comp レイヤー `camera wiggle expression` は `threeD: true`。`captureAdjustmentBackdrop` の 3D subtree snapshot（[DomRenderer.ts](../../src/runtime/DomRenderer.ts)）だけでは **ネスト comp 内の 3D カメラ rig / 子 subtree まで十分に焼けていない**可能性が高い。

### 3. 検証の誤り（2026-06-25 セッション）

`verify-comp10-export-parity.mjs` が **同一経路（offscreen DOM + `forceAdjustmentRaster: false`）同士**を比較していたため **pixel diff 0%** になった。これは **Preview パネル実機 vs MP4** の一致を証明しない。

| 比較 | 意味 |
|------|------|
| offscreen A vs offscreen A | 自明に 0% — **無意味** |
| Preview パネル vs MP4 export | **本来測るべき** — 調整 effect の有無がここで判明 |

`verify-export-adjustment.mjs` も同型。center-line `mid=0` は **preview / export 両方で blur が foreignObject に載っていない**可能性を示す（一致 ≠ 正しい）。

---

## 実施済み変更（2026-06-25）

### A. exporter — `forceAdjustmentRaster` 削除（消える症状の緩和）

[exporter.ts](../../src/runtime/exporter.ts):

- `renderer.setPreviewRenderOptions({ forceAdjustmentRaster: true })` を **削除**
- `flushExportComposite()` → **`flushRasterEffects()`**
- **副作用**: 調整 effect が MP4 に載らなくなった（§上記 trade-off）

### B. DomRenderer — bake 経路の部分改善（未配線）

[DomRenderer.ts](../../src/runtime/DomRenderer.ts):

- `shouldSerialExportAdjustment()` — 直列 bake は `adjustmentMode === "raster"` または `forceAdjustmentRaster` 時のみ
- `prepareAdjustmentBackdropForCapture()` — multi-pass 時 suppressed 下位を誤再表示しない（§27.4.1）
- `flushExportComposite()` / `exportAdjustmentQueue` / `captureAdjustmentBackdrop()` — **残置**（exporter から未呼び出し）

---

## 目標と次の修正方針

**INV-2 達成条件**: MP4 = Preview パネルと同じ見た目。Live 調整の effect も含む。

### 方針（推奨）: bake 経路 B を直して exporter に戻す

1. **exporter** — `forceAdjustmentRaster: true` と `flushExportComposite()` を **復帰**
2. **backdrop capture 改善** — 3D ネスト comp レイヤー（`type: comp` + `threeD`）を adjustment backdrop 前に **comp 単位で 2D スナップショット化**
   - 候補: `renderNestedComp`  subtree 全体を `captureElementToCanvas` → img 置換（既存 `snapshotThreeDSubtreesBelow` の拡張）
   - ネスト comp 内カメラ rig（`setupCameraRig` + per-object view）を含む div を capture 対象にする
3. **multi-pass flush** — stacked adjustment（Comp 10 f85–89: z13 + z14）で `prepareAdjustmentBackdropForCapture` が確定ピクセルのみ参照（実装済み・要 exporter 配線）
4. **検証の修正** — Playwright で **Preview パネル screenshot vs MP4 相当 capture** を比較。edge softness / 調整 active フレーム（f83, f100）で effect 検出

### 代替案（非推奨・第一選択ではない）

- export 前 parity 検出で live / bake を切替 — 複雑で根本解決にならない
- ユーザーに Raster 調整モードを強制 — UX 劣化

---

## 経路比較図

```
Preview パネル（正）
──────────────────
live DOM + browser compositor
  └─ Live 調整: backdrop-filter → 背面に effect 適用 ✓


MP4 export — 現行（A・effect 欠落）
────────────────────────────────────
forceAdjustmentRaster: false
  └─ Live 調整: backdrop-filter（DOM には付くが…）
       ↓
flushRasterEffects()
       ↓
captureElementToCanvas(root)  → backdrop-filter 欠落 ✗


MP4 export — 目標（B 修正版）
──────────────────────────────
forceAdjustmentRaster: true
  └─ Live 調整: comp 背面 capture（3D ネスト pre-snapshot 済み）
       → filter chain を buffer に適用 → canvas overlay
       → 下位 visibility:hidden（canvas が正しければ OK）
       ↓
flushExportComposite()（zOrder 直列）
       ↓
captureElementToCanvas(root)  → preview と一致 ✓
```

---

## Comp 10 レイヤー構成（参考）

| zOrder | 名前 | 種別 | in–out (f) | effect |
|--------|------|------|------------|--------|
| 10 | camera wiggle expression | ネスト comp（3D・`threeD: true`） | 7–112 | — |
| 13 | Adjustment | Live 調整 | 77–89 | blur（f79–85 アニメ） |
| 14 | Adjustment | Live 調整 | 85–113 | blur + fastTurbulentDisplace（f86–112 アニメ） |
| 15–18 | Camera / Solid 等 | 上位 | — | — |

f85–89 は z13 + z14 調整が **重なる**（stacked adjustment）。bake 経路では §27.4.1 multi-pass flush が必須。

---

## 変更ファイル一覧（2026-06-25 時点）

| ファイル | 変更概要 | 状態 |
|----------|----------|------|
| [src/runtime/exporter.ts](../../src/runtime/exporter.ts) | `forceAdjustmentRaster` 削除、`flushRasterEffects` | **要 revert / bake 復帰** |
| [src/runtime/DomRenderer.ts](../../src/runtime/DomRenderer.ts) | bake 改善（直列・backdrop prep） | 実装済み・**exporter 未配線** |
| [verify-comp10-export-parity.mjs](../../verify-comp10-export-parity.mjs) | 同一経路 diff（不十分） | **要書き換え** |
| [verify-export-adjustment.mjs](../../verify-export-adjustment.mjs) | 同上 | **要書き換え** |
| [progress.md](../../progress.md) | 2026-06-25 エントリ | **要追記（未解消）** |

---

## 解決（2026-06-25 Sonnet）

実機局在化（Comp 10 f100 を 3 経路で capture）で **真因は `snapshotThreeDSubtreesBelow` の 3D flatten 自体**と判明:

- `forceAdjustmentRaster:false`（旧）で blue diamond は **foreignObject に写る**（blueRatio 0.069）→ **foreignObject は 3D ネスト comp を焼ける**。本 doc の「foreignObject は preserve-3d 非対応」前提は**誤り**だった。
- bake 時に 3D 下位 subtree を `captureElementToCanvas`→`<img>` 置換していた `snapshotThreeDSubtreesBelow` が、その置換 img を空に潰し「消える」を引き起こしていた。flatten を切ると content 復活 + effect 適用（blueRatio 0.126）。

**実施**:

- [x] exporter に `forceAdjustmentRaster:true` + `flushExportComposite` を復帰（MP4 / PNG 連番）
- [x] `compFrameCapture.ts`（RAM Preview / precomp raster / bundle bake）も同様に修正
- [x] **3D flatten 機構を全削除**（`snapshotThreeDSubtreesBelow` / `hasNestedCameraRig` / `data-has-camera-rig`）。`captureAdjustmentBackdrop` は root 直接 capture
- [x] stacked adjustment（z13 + z14）f83/f86/f88/f100 実機 parity（std シグネチャ一致）
- [x] 検証: 実 Preview パネル screenshot vs export(bake)。判定は std（効果シグネチャ）— pixel-diff は blank の方が小さく出るため不適
- [x] 回帰 verify 全 PASS（nested-3d-camera / 3d-camera / export-bake / export-filter / fast-export-parity / comp19-adjustment）+ 458 unit tests

**残**:

- [ ] §27.4 spec 散文 — 「foreignObject は preserve-3d 非対応 → 3D 個別 capture 必要」が実測と矛盾。root capture で 3D も焼ける旨に更新（§5/INV 不変・Cursor 主導可）

---

## ちらつき解消（2026-06-25 Opus — export 合成のオーバーホール）

effect 欠落・消失が直った後、**MP4 がちらつく**症状が残った（`for-debug-data/Comp_10 (2).mp4`）。

**真因**: bake（`forceAdjustmentRaster`）は毎フレーム **live render DOM を破壊操作**する（下位 `visibility:hidden` トグル + raster overlay 差し替え + `holdLastRaster`/`frameRenderCache` の使い回し + `exportAdjustmentQueue` 直列化）。これらは非同期で、前フレームの overlay / 抑制状態が次フレームの foreignObject キャプチャに混入するタイミングが生じる → フレーム間で見た目が不連続にぶれる＝ちらつき。bake は本質的に**ブラウザ compositor の backdrop-filter を canvas で再実装**しており、毎フレームの可変 DOM 状態に依存するため脆い。

**方針（ユーザー確認）**: デプロイは**ブラウザのみ**。ヘッドレス Chromium 正準書き出し（§16/M3.5）はクライアント不可、getDisplayMedia は実時間/解像度/精度で不適。→ **ブラウザ内のまま、export 合成を live DOM 非破壊・ステートレスに作り直す（C1）**。

**実施**:

- [x] [exportComposite.ts](../../src/runtime/exportComposite.ts) 新規 — `compositeExportFrame`: 毎フレーム fresh に z 昇順で累積 master canvas を組み、調整レイヤー到達点で master（=確定背面ピクセル）に effect chain を適用。調整/CSS blend が無ければ単一ショット root capture（3D 深度保持）の高速経路。
- [x] [effectRaster.ts](../../src/runtime/effectRaster.ts) 新規 — `applyFilterChainToBuffer`（旧 `DomRenderer.applyCssSvgFilterToBuffer` を pure 化、live/export 共有）。
- [x] [DomRenderer.ts](../../src/runtime/DomRenderer.ts) — `exportCompositeMode`（true 時、調整レイヤーは live DOM を触らず effect chain を `entry.exportChain` に保存するだけ）+ `getExportLayers()` / `hasAdjustmentLayers()`。
- [x] [exporter.ts](../../src/runtime/exporter.ts) / [compFrameCapture.ts](../../src/runtime/compFrameCapture.ts) — `forceAdjustmentRaster`→`exportCompositeMode`、`flushExportComposite`→`flushRasterEffects`、capture を `compositeExportFrame` に一本化。
- [x] **検証（ちらつき＝フレーム間状態リーク）**: seq（1 renderer 順次＝実 export ループ）と iso（frame ごと新 renderer）の同一フレーム出力 diff。stateless なら 0%。→ Comp 10 **f82–100 全フレーム seqVsIso=0.000%**。parity（実 Preview std）OK、f88/f100 目視で content+effect 確認。回帰 verify 全 PASS + 458 tests。

**未削除（意図的）**: 旧 bake pipeline（`forceAdjustmentRaster` / `runAdjustment*Pipeline` / `captureAdjustmentBackdrop` / `flushExportComposite` / `exportAdjustmentQueue`）は **live preview の displacement / raster-mode 調整経路と共用**のため残置。`forceAdjustmentRaster` はどこからも true にされず、ちらつき経路は再活性化しない。完全分離は `effectRouting.ts` / `adjustmentMode.test.ts` に波及するため follow-up。

### カメラのちらつき修正（同日 Opus）

オフDOM 化後、調整 effect/opacity は安定したが **カメラ(perspective)が断続的にちらつく**症状が残った。

- **真因**: perspective / perspective-origin / preserve-3d は **root** に付く。初版 compositor は調整フレームでレイヤを root から切り離して個別 capture したため 3D 層の perspective 射影が落ち、`hasAdjustmentLayers()` の in/out 切替で fast path(root 一括=カメラ有) と slow path(per-layer=カメラ無) が交代 → ちらつき。
- **局在化**（`verify-diag-capture.mjs`、f100）: root 一括=std37.1（正）/ per-layer 無 perspective=std70.1（カメラ落ち）/ **per-layer を root と同じ perspective ラッパで包む=std37.1（root と pixel 一致）**。
- **修正**: [exportComposite.ts](../../src/runtime/exportComposite.ts) を **per-layer + perspective ラッパ**（`captureLayerWithPerspective`）方式へ。各レイヤを `perspective`/`perspective-origin` = root と同値の div に入れて capture（2D 層は無影響、3D 層は正しく射影）。調整も blend も無いフレームは root 一括の高速経路。
- **検証**: `verify-comp10-export-parity.mjs` に camera 保持検査追加 → f100 で per-layer+persp std=37.1 == root std=37.1（diff 0.00%）。ちらつき seq≡iso=0.000% 継続。回帰 verify 全 PASS + 458 tests。

## 追補3（2026-06-26 Opus）— ネスト comp 内の調整レイヤーが export で焼けない

- **症状**: 親 comp（Comp 19）が子 comp（Comp 10, 調整5枚）をネストした状態で**親を書き出すと子の調整が消える**（preview では効く・`for-debug-data/Comp_20.mp4`）。
- **真因**: ネスト comp は `renderNestedComp` で live 描画され子の調整は CSS `backdrop-filter`。親 export の `compositeExportFrame` は子 comp を**1枚の通常レイヤーとして foreignObject capture** → §27.4 と同じく `backdrop-filter` が落ちて子の調整が消える。調整専用 comp は `compNeedsAutoPreviewCache` 対象外で preview rasterizer も拾わず、exporter は nestedCompRasterizer も持たない（＝この経路だけ壊れる）。
- **修正（spec §27.4.1 軸1 準拠・再帰）**: ネスト comp が再帰的に調整を含むなら、子 comp を**子自身の座標系で同じステートレス z 順コンポジタに掛けて1枚へ確定**してから親へ置く（depth ≤ 4・何段でも）。`resolveEffectChain` を切り出し top-level と共有（INV-2）。`renderNestedComp` は export 時に調整 div へ backdrop を立てず chain を `__exportLayer` に、コンテナに `data-nested-composite` を付与。`captureLayerNode`/`compositeContainer` が相互再帰し、クローン側でコンテナ中身を確定画像 `<img>` に差し替えてから capture（live DOM 非破壊）。
- **検証**: `verify-comp19-nested-export.mjs`（恒久）で **新経路 vs 旧高速経路 root capture（backdrop 落ち）を対照**。Comp 19 f0/f100 + **WRAP→19→10 depth-2** 全 PASS（子 blur が焼け flat はシャープ・edge↓最大75.5%・目視）。回帰 verify 全 PASS。
