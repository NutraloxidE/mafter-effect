# WebGL context 上限 — GL レイヤーが増えると古いレイヤーの絵が黙って消える

> **対象**: `geom3d`（3D-extrude text・§5.5f）/ split・packed alpha video の GL 合成（§2.1/§2.2）
> **状態**: 2026-07-16 **未対応（既知のリスクとして記録）**。応急処置として Pipeline パネルに GL レイヤー数を表示（下記「応急処置」）。根治（予算＋フォールバック）は**要望ベースで起票**。
> **発見経緯**: ネスト comp の 3D text 配線（§23.3e）の実機検証中に、毎フレーム canvas 再生成で上限へ到達して発覚（本体の調査は [nested-comp-3d-text-fallback.md](nested-comp-3d-text-fallback.md) 参照）。

**関連 spec**: §5.5f（既知のリスク）/ §23.3e（ネスト comp の GL 持ち越し規約）
**関連実装**: [geom3dGl.ts](../../src/runtime/geom3dGl.ts) の `createState` / [videoAlphaGl.ts](../../src/runtime/videoAlphaGl.ts) の `shouldCreateGlAlphaCompositor` / [DomRenderer.ts](../../src/runtime/DomRenderer.ts) の `releaseAlphaGlCompositorsUnder`
**関連検証**: `verify-nested-geom3d.mjs`（canvas 実体の持ち越しを固定）

---

## 症状

**GL を使うレイヤーが増えると、ブラウザが古い context から黙って破棄し、先に描いたレイヤーの絵が消える。**

```
WARNING: Too many active WebGL contexts. Oldest context will be lost.
```

- **例外は飛ばない**。console にこの warning が出るだけで、ユーザーには**原因不明の描画バグ**に見える。
- 消えるのは「古い方」＝**手前で描いたレイヤー**なので、「なぜか一部の 3D テキストだけ出ない」という形になる。

## 原因

**Chrome の同時 WebGL context は 1 ドキュメントあたり ~16 が上限**（実測値・仕様上の固定値ではない）。
**この上限はページ全体で共有**され、Mafter Effect では次が消費する:

| 消費元 | context の作り方 | 予算 |
|---|---|---|
| `geom3d`（3D-extrude text） | **per-layer に 1 つ** | **なし（無制限）** ← 上限に効く主因 |
| split / packed alpha video の合成 | per-layer に 1 つ | **`MAX_GL_ALPHA_CONTEXTS = 8`** ＋キルスイッチ（超過分は CPU フォールバック） |

**非対称なのが弱点**: alpha 側は予算を持ち超過時に CPU へ逃げるが、**`geom3d` は青天井**。
3D テキストを 16 枚以上積む、あるいは alpha 動画と併用すると上限に届く。
**precomp の中身も実体として描かれる**ため、`Main`（3D text × 3）を 6 回置けば 18 になる。

### 二次的な増幅要因（修正済み・再発注意）

`renderNestedComp` は毎フレーム `container.innerHTML = ""` する非 reconcile 実装のため、**canvas を作り直すと
1 レイヤーでも毎フレーム 1 context を生成**し、数十フレームで上限へ達した（§23.3e で持ち越し＋明示解放を導入して解決）。
**同種の実装を足すときは同じ罠を踏む。**

## 再現

3D Extrude ON の text レイヤーを 16 枚以上置いてスクラブする（precomp 経由でも可）。
実測: `Main`（3D text × 3）を `Outer` に 5 回置くと 15 で警告域、6 回で 18＝上限超過。

## 検出が不安定なことの注意（**重要**）

**警告の出現は GC 依存で再現が不安定**。同じコードで出たり出なかったりする。

- 短いスクラブ（~15 フレーム）では上限に届かず**素通りする**。40〜70 フレームで初めて出た。
- context は canvas 要素に紐づく（`WeakMap<canvas, state>`）。DOM から外しても**参照が生きていれば context も生き**、
  GC 待ちで即座には解放されない。

→ **`Too many active WebGL contexts` の有無を回帰ゲートの合否条件にしてはならない。**
決定論的に測るなら「**canvas 要素の実体が作り直されていないか**」（印を付けてスクラブ後も残るか）を見る。
`verify-nested-geom3d.mjs` はこの方式（`kept === total`）。

## 応急処置（2026-07-16 実装済み）

**Pipeline パネル（左下）に GL レイヤー数バッジ `GL×N` を表示**する。

- **precomp を再帰カウント**（`MAX_PRECOMP_DEPTH = 4`）。同じ precomp を 2 回置けば 2 倍で数える（実態と一致）。
- 無効レイヤー（`enabled === false`）は数えない。
- 色: `< 12` 青 / `>= 12` 琥珀 `GL×N!`（上限接近）/ `>= 16` 赤（上限到達）。tooltip に内訳と対処を出す。
- 実装: [pipelineAnalysis.ts](../../src/editor/pipelineAnalysis.ts) の `collectGlLayers` / [PipelinePanel.tsx](../../src/editor/panels/PipelinePanel.tsx) の `GlBadge`。
  純関数のため `test/pipelineAnalysis.test.ts` で固定。

> **これは静的な目安であって実 context 数ではない。** frame 依存の in/out 点や、alpha 予算超過時の
> CPU フォールバックまでは見ていない。**「気付けるようにする」だけで、破綻自体は防がない。**

## 根治案（未実施・要望ベースで起票）

1. **`geom3d` に予算を入れる** — `shouldCreateGlAlphaCompositor()` と同型の純ロジック
   （`activeCount < maxContexts`）＋キルスイッチを `geom3dGl.ts` に足し、**超過分は 2D 描画へフォールバック**する
   （`applyGeom3DText` が `false` を返せば既存の 2D 経路に落ちる＝**フォールバック機構は既にある**）。
   予算は alpha（8）と食い合うため、**両者を 1 つのグローバル予算に統合**するのが筋。
2. **共有 context 化** — 1 つの GL context に複数レイヤーを描き分ける（大改修・per-layer canvas の設計前提を崩す）。
3. **オフスクリーン 1 枚へ集約** — 3D レイヤーをまとめて 1 canvas に描く（z 順・blend の設計に影響）。

**推奨は 1**（既存パターンの再利用・フォールバック機構が既にある・diff が小さい）。
実際に 3D text を大量に積む使い方が出てきた時点で着手する。
