---
name: wire-feature-into-nested-comp
description: 新機能（3D-extrude text / camera / effect / matte / plugin 型 等）が「単独 comp では動くのに、そのコンプを precomp として他コンプから呼ぶと効かない・消える・崩れる」ときの配線もれ調査と修正手順。トップレベル `applyObject` と `renderNestedComp` が**別々の描画コードパス**であることが根因で、新機能はトップレベルにだけ配線されがち。ネスト経路は毎フレーム `container.innerHTML=""` する非 reconcile 実装のため、GL/video/decode 等の**永続リソースを持つ機能は「配線するだけ」では二次破綻**する（WebGL context 枯渇等）。「ネステッドコンポジションで新機能が効かない」「precomp にすると 3D が消える」「Main を他コンプに置くと壊れる」等の報告、および新描画機能を足すときの予防に使う。ピクセルに触るため implementation-loop / debug-visual-render-bug を土台に、ネスト特有の罠を上乗せする。
---

# ネスト comp（precomp）への新機能配線

> **前提**: [implementation-loop](../implementation-loop/SKILL.md) の Phase 0–5 に従う。本スキルはその
> Phase 2（影響地図化）と Phase 4（検証）に **ネスト経路特有の項目**を上乗せするもの。
> 視覚バグの measure ループは [debug-visual-render-bug](../debug-visual-render-bug/SKILL.md) を併用。

## 症状トリガー

- 「単独 comp では動くが、precomp として呼ぶと効かない／消える／2D に落ちる」
- 「`Main` を他のコンポジションに置くと正しく動作しない」
- 「preview では出るが、ネストした comp の export だけ違う」
- 新しい描画機能（GL 系・メディア系・matte 系）を足した直後

## 根本構造 — なぜ毎回ここで漏れるか

このコードベースの `DomRenderer` は **描画コードパスが 2 本**ある。共有されていない。

| | トップレベル | ネスト comp |
|---|---|---|
| 入口 | `renderFrame` → `applyObject` | `renderNestedComp`（別実装・再帰） |
| DOM | `entry` を **reconcile して持ち越す** | 毎フレーム `container.innerHTML = ""` で**全再構築** |
| カメラ | `this.cameraPre` / `this.cameraFov`（親 comp の値） | ローカル `cameraPre` / `childScene.camera?.fov`（**子 comp の値**） |
| resolve | 呼び出し側が渡す `ResolvedScene` | **自前で `resolve(childComp, childFrame)`** |

**帰結**: `applyObject` にだけ機能を足すと、ネストで静かに落ちる。しかも
**「フォールバックが用意されている機能ほど無言で劣化する」**（例外もログも出ない）ため気付きにくい。

> 実例（2026-07-16）: `updateComponentEl` は `geom3dCamera === null` で 2D フォールバックする設計。
> `renderNestedComp` がこの引数を渡していなかった＝ precomp にした瞬間 3D 押し出しが消える。
> **コメントに「ネスト comp はスコープ外」と明記されたまま残っていた**＝ 意図的な未配線が仕様の穴になっていた。

## Phase N1 — 配線点の差分を機械的に洗う（推測しない）

「何が漏れているか」を勘で探さない。**2 本のパスを grep で突き合わせる**。

```bash
# トップレベルの分岐点
sed -n '<applyObject の範囲>' src/runtime/DomRenderer.ts \
  | grep -n "trackMatte\|pluginDef\|acquireVideoFromPool\|c.type ===\|geom3dCamera\|raster"
# ネストの分岐点
sed -n '<renderNestedComp の範囲>' src/runtime/DomRenderer.ts \
  | grep -n "trackMatte\|pluginDef\|acquireVideoFromPool\|c.type ===\|geom3dCamera\|raster"
```

差分は**そのまま未配線リスト**になる。各項目に「配線する／意図的に除外（理由を書く）」を明示決定する。

**2026-07-16 時点の既知の未配線**（着手時は再 grep して現況を確認すること）:

| 項目 | 状態 |
|---|---|
| `geom3dCamera`（3D-extrude text） | **配線済み**（§23.3e・2026-07-16） |
| `trackMatte` | 未配線（ネスト内マット無効） |
| plugin の `ComponentDef.render` | 未配線（プラグイン型がネスト内で描画されない） |
| video プール / ループ warmup | 未配線（毎フレーム新規要素＝decode churn） |
| html comp / raster 系 effect | **意図的除外**（Phase 1 除外・§28.11 のラスタ経路で反映） |

## Phase N2 — 「渡す値は子 comp のもの」原則

ネストへ配線するとき、**親の状態（`this.*`）を掴んではいけない**。precomp の中身は
**子 comp の座標系で閉じ**、外側の変換はコンテナの CSS transform が担う（collapse OFF・§23.3a）。

```ts
// ✗ 親 comp のカメラを掴む（precomp の中身が親のカメラで歪む）
const cam = { cameraPre: this.cameraPre, fov: this.cameraFov, compW, compH, ... };
// ✓ 子 comp のカメラ・寸法
const cam = { cameraPre /* setupCameraRig(container, childScene) の返り値 */,
              fov: childScene.camera?.fov ?? null,
              world: obj.worldTransform, compW: childComp.width, compH: childComp.height };
```

同様に `fps` は `childComp.fps`、`frame` は `childFrame`（`compChildFrame` で秒ベース換算済み）を使う。
`this.currentComp` は **mount 時スナップショット**なのでネストでは使わない（既知事例: nested fps 2 倍速）。

## Phase N3 — 永続リソースの二次破綻（**ここで必ず躓く**）

ネスト経路は毎フレーム `innerHTML = ""` する。**配線しただけだと、機能が持つ永続リソースが
毎フレーム作り直される**。「1 行足して動いた」で終わらせてはいけない。

| リソース | 素直に配線した場合の破綻 |
|---|---|
| **WebGL context**（geom3d / alpha 合成） | 毎フレーム生成 → Chrome の同時上限(~16)超過 → `Too many active WebGL contexts. Oldest context will be lost.` で**描画が消える** |
| `<video>` | 毎フレーム再 decode → 黒フレーム・スタッタ |
| 非同期 raster / decode | 完了前に宿主が消える → 結果が捨てられ続ける |

**対処の型（確立パターン・§23.3e）**:

1. **持ち越し**: `WeakMap<container, Map<key, el>>` を持ち、**永続リソースを抱える型だけ** key で
   前フレームの実体を再利用する。key は **`objId:index:type`**（型を含める＝並び替え・型変更で誤再利用しない）。
   - **持ち越す対象を最小に絞る**。全型を持ち越す＝ reconcile の再発明で、他型の回帰を招く。
     実績: `text`（GL canvas の宿主）と `comp`（再帰コンテナ＝深い階層の canvas を生かす）のみ。
   - コンテナ（`comp`）を持ち越すと **depth 2+ にも自動で効く**（再帰の各段で同じ機構が働く）。
2. **明示解放**: 今フレーム使われなかった持ち越し el は GL を明示解放する
   （`releaseAlphaGlCompositorsUnder(el)` が deep query で geom3d/split/packed をまとめて解放）。
   レイヤー削除・機能 OFF・型変更で必要。
3. **1 と 2 は対で入れる**。解放だけでも上限超過は防げるが、毎フレーム context 再生成＝
   シェーダ再コンパイルで重い。持ち越しだけでは削除時に漏れる。

> 再利用してよい根拠を必ず確認する: 「毎フレーム中身を全書き換えする関数があるか」。
> 例: `updateComponentEl(text)` は 3D なら `applyGeom3DText`、2D なら
> `clearGeom3DCanvas + applyTextEl` で全書き換えする＝ el 再利用は描画結果を変えない。

## Phase N4 — 検証（ネスト特有）

### N4-a. 実機ハーネスの前提（ここを外すと丸ごと空振りする）

- **store は必ず `window.__mafterEditorStore`**。`await import("/src/editor/store.ts")` は
  **別 Zustand インスタンス**になり、`loadFromFs()` は成功して見えるのに **UI が一切追従しない**
  （＝ canvas 0 枚で「直っていない」と誤診する）。実際に 30 分溶かした罠。
- 実プロジェクトの zip を `importZip(store.getState().getFs(), buf)` → `loadFromFs()` で取り込むと、
  ユーザー報告そのものを再現できる（合成シーンより早い）。
- dev サーバは **https**。古い verify スクリプトは `http://localhost:5173` 決め打ちで
  `ERR_EMPTY_RESPONSE` になる（**それは自分の regression ではない**）。`verify-*.mjs` には
  **中身が空のスタブが多数**あるので、無回帰確認に使う前に `wc -l` で実体を確認する。

### N4-b. 比較の型 — 「単独 comp」を基準にする

ネストの正しさは **同じ comp を単独で開いたときと一致するか**で測る。これが最も強い基準。

```
A: Main を単独で開く         → 測る（基準）
B: Outer に Main を addCompLayer → 測る
判定: B == A（ink 比 ~1.000 / canvas 枚数一致）
```

- **測る対象は実ピクセル**（GL canvas の不透明ピクセル数など）。DOM の有無や内部フラグで代用しない。
- **飽和する指標に注意**: 背景が不透明な export PNG で `alpha > 16` を数えると
  **全ピクセルが数えられて 1920×1080 で張り付く**（差が見えない）。輝度閾値にするか、**画像を実際に目視する**。
  数値が「きれいに一致」したときほど、まず指標の飽和を疑う。

### N4-c. INV-2（export も直っているか）

preview が直っても export が直っている保証はない。**`compFrameCapture` で単独 comp と
ネスト comp の PNG を撮り、バイト比較**するのが最短で厳密。

```js
const png = await captureCompFramePng(ctx, comp, frame);   // 単独 / ネストの両方で
// md5 が一致 → INV-2 OK（実績: 修正前 outer≠main、修正後 完全一致）
```

GL canvas が export に乗る条件: `preserveDrawingBuffer: true` かつ `inlineCanvasBitmaps` が
DOM を deep query すること（両方満たすため、ネストの canvas も自動で foreignObject 経路に乗る）。

### N4-d. 永続リソースの回帰ゲートは「実体の同一性」で測る

`Too many active WebGL contexts` 警告は **GC 依存で不安定**（同じコードで出たり出なかったりする）。
**合否条件にしてはならない**。代わりに**決定論的に**「作り直していないこと」を測る:

```js
// スクラブ前に印を付ける
document.querySelectorAll("canvas.mafter-geom3d-canvas").forEach((c, i) => (c.__probeId = i + 1));
// …十分な長さスクラブ…
// 持ち越せていれば全数が印を保持。作り直していれば新品＝印なし。
const cs = [...document.querySelectorAll("canvas.mafter-geom3d-canvas")];
const kept = cs.filter((c) => c.__probeId !== undefined).length;  // kept === cs.length を要求
```

- **スクラブ長は上限を超える長さにする**。GL context 上限 ~16 に対し 3D text 3 枚なら
  **15 フレームでは出ず、40〜70 フレームで初めて破綻**する。短い verify は無言で PASS する。
- **ゲートに歯があることを必ず確認する**: 修正を部分的に外して **FAIL することを実際に見る**。
  実績: reuse を外すと `kept 0/3` で FAIL、戻すと `3/3` で PASS。
  （このとき「eviction だけ残すと PASS してしまう」等、**多層防御が互いを隠す**ことにも気付ける）

## 完了チェックリスト

```
- [ ] applyObject と renderNestedComp の分岐点を grep で突き合わせ、未配線を列挙した
- [ ] 各未配線に「配線する／意図的除外（理由）」を明示決定した
- [ ] 渡す値は子 comp のもの（cameraPre / fov / fps / frame / 寸法）。this.* を掴んでいない
- [ ] 永続リソース（GL/video/async）を持つ機能 → 持ち越し + 明示解放を対で入れた
- [ ] 持ち越し対象を最小に絞った（reconcile の再発明をしていない）
- [ ] 実機: store は window.__mafterEditorStore。実 zip で再現した
- [ ] 単独 comp 基準で B==A（実ピクセル・指標が飽和していないか目視で確認）
- [ ] INV-2: compFrameCapture の PNG が単独とバイト等価
- [ ] 永続リソース: 上限を超える長さのスクラブで「実体の同一性」が保たれる
- [ ] ゲートに歯があることを、修正を外して FAIL させて確認した
- [ ] npm run build:player（DomRenderer は player が import する＝必須）
- [ ] 既存 3D/export verify の無回帰。既存の失敗は stash して「元から失敗」を確認した
- [ ] spec の「ネストは対象外」系の記述を更新した（散文のみなら実装と同セッションで可）
```

## アンチパターン

- **1 行足して preview で動いた時点で完了にする**（永続リソースの二次破綻が待っている）。
- 警告メッセージ（`Too many active WebGL contexts`）の有無を合否条件にする（GC 依存で不安定）。
- 短いスクラブで「リークしていない」と結論する（上限に届いていないだけ）。
- `import("/src/editor/store.ts")` で store を掴む（別インスタンス・UI 不追従）。
- 飽和した指標（不透明ピクセル数）の「完全一致」を parity の証拠にする。
- ネスト経路を丸ごと reconcile 実装に書き換える（大 diff・他型の回帰）。**必要な型だけ持ち越す。**
- 親の `this.cameraPre` / `this.currentComp` をネストで使う。
- 未配線を見つけたのに黙って全部直す（track matte / plugin / video は影響範囲が別。**ユーザーに要否を確認**）。
