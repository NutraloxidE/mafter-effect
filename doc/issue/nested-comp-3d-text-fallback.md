# ネスト comp（precomp）内の 3D-extrude text が 2D に落ちる問題

> **対象**: `component.type === "text"` の 3D-extrude（`geomEnabled`・§5.5f）を、他コンポジションから
> precomp として呼び出した場合（`renderNestedComp` 経路）
> **状態**: 2026-07-16 **根治済み**（§23.3e）
> **再現データ**: ユーザー提供 `mafter-pj-3Dtext-with-pixelstretch.zip`（`Main` コンプ・3D text × 3 + pixelStretch + camera + adjustment）

**関連 spec**: §5.5f（3D-extrude text）/ §23.3b（ネスト comp のカメラ）/ §23.3e（ネスト comp の 3D-extrude text と GL リソース、新設）
**関連実装**: [DomRenderer.ts](../../src/runtime/DomRenderer.ts) の `renderNestedComp` / `updateComponentEl` / [geom3dDomApply.ts](../../src/runtime/geom3d/geom3dDomApply.ts)
**関連検証**: `verify-nested-geom3d.mjs`（新規・恒久）
**関連 issue**: [webgl-context-limit.md](webgl-context-limit.md)（本件の調査中に副次的に発見した GL context 上限の問題）

---

## 症状（ユーザー報告）

> 新しめの機能を沢山追加したのもあってネステッドコンポジットが正しく読み込まれない、未配線が
> たくさんありそう。DL にある新しい pj のメインコンポジションが、他のコンポジションに呼び出された時
> 正しく動作するように調査してほしい。

実測すると: `Main`（3D-extrude text を含む）を他コンプから precomp として呼ぶと、**3D 押し出しが
完全に消えてフラットな 2D テキストになる**。さらに平面化したテキストに pixelStretch が掛かり、
字形（`語`）が崩れて見える。

| | Main を単独で開く | Main を他コンプから呼ぶ |
|---|---|---|
| geom3d canvas 数 | 3 | **0** |
| GL インク量（不透明ピクセル数） | 176920 | **0** |
| export PNG | 3D 押し出し・陰影あり | **フラット 2D**（`outer` ≠ `main`、バイト不一致） |

## 真因（2 つ。1 つ目だけ直すと 2 つ目で顕在化する）

### 1. 配線漏れ — `renderNestedComp` が `geom3dCamera` を渡していなかった

`DomRenderer` の描画パスは 2 本ある。

| | トップレベル | ネスト comp |
|---|---|---|
| 入口 | `renderFrame` → `applyObject` | `renderNestedComp`（別実装・再帰） |
| DOM | `entry` を reconcile して持ち越す | 毎フレーム `container.innerHTML = ""` で全再構築 |
| カメラ | `this.cameraPre` / `this.cameraFov`（親 comp） | ローカル `cameraPre` / `childScene.camera?.fov`（子 comp） |

トップレベルの `applyObject` は `updateComponentEl` に `geom3dCamera` を渡すが、ネスト側の
`renderNestedComp` は渡していなかった。`updateComponentEl` は `geom3dCamera === null` のとき
既存 2D 描画へフォールバックする仕様のため、**precomp として呼ばれた瞬間に無言で 3D が消えていた**。

当時のコード自体に「ネスト comp は本リビジョンの対象外」という趣旨のコメントが残っており、
**意図的な未配線が仕様の穴として長期間残っていた**（フォールバックがあるため例外もログも出ず、
気付かれにくい形）。

### 2. 永続リソースの二次破綻 — WebGL context の毎フレーム再生成

1 だけ直すと、今度は 15 フレーム程度のスクラブでは問題ないが、**40〜70 フレームのスクラブで
3D が再び消える**。原因は `renderNestedComp` が毎フレーム `container.innerHTML = ""` で
DOM を全再構築する非 reconcile 実装であること。geom3d canvas ごと **WebGL context が毎フレーム
新規生成**され、Chrome の同時 context 上限（~16・詳細は [webgl-context-limit.md](webgl-context-limit.md)）
を数十フレームで超え、`Too many active WebGL contexts. Oldest context will be lost.` で描画が消える。

**短い検証では見逃す**典型例（15 フレームでは再現せず、70 フレームで初めて出た）。

## 修正

`src/runtime/DomRenderer.ts` の `renderNestedComp` 内に閉じた最小 diff。

1. **`geom3dCamera` に子 comp のカメラ・寸法を渡す**。ローカル `cameraPre`
   （`setupCameraRig(container, childScene)` の返り値）・`childScene.camera?.fov`・
   `childComp.width/height` を使う。`this.cameraPre` / `this.cameraFov` は**親 comp の値**なので使わない
   （precomp 内の 3D は子の座標系で閉じ、外側の変換はコンテナの CSS transform が担う＝ collapse OFF・§23.3a と整合）。
2. **GL を抱える el だけを key で持ち越す**: `nestedElReuse: WeakMap<container, Map<key, el>>` を追加し、
   `text`（geom3d canvas の宿主）と再帰コンテナ `comp`（深い階層の canvas も生き延びる）だけを
   `objId:index:type` の key で前フレームの実体を再利用する。他の型は従来どおり毎フレーム新規（無回帰）。
3. **未使用になった持ち越し el は GL を明示解放**: 既存の `releaseAlphaGlCompositorsUnder()` を流用
   （レイヤー削除・3D OFF・型変更時に必要。持ち越しと解放は対で入れる）。

再利用が安全な根拠: `updateComponentEl(text)` は毎フレーム中身を全書き換えする
（3D なら `applyGeom3DText`、2D なら `clearGeom3DCanvas + applyTextEl`）ため、el の再利用は
描画結果を変えない。

## 検証（実機 Playwright・ユーザー提供の実 zip を import）

- **store は `window.__mafterEditorStore` を使用**（`import("/src/editor/store.ts")` は別 Zustand
  インスタンスになり UI が追従しない罠を実際に踏んで気付いた）。
- **単独 comp を基準に、precomp 経由と比較**（`nested/standalone ink ratio`）:
  修正前 `0.000`（FAIL）→ 修正後 `1.000`（PASS）。
- **INV-2（export）**: `compFrameCapture` で単独 comp とネスト comp の PNG を撮り md5 比較。
  修正前 `outer(1cd74c…) ≠ main(81cb54…)` → 修正後 **バイト等価**。preview だけでなく export も直った。
- **GL 持ち越しの回帰ゲート**: `Too many active WebGL contexts` 警告の有無は **GC 依存で不安定**
  なため合否条件にしない。代わりに「canvas 要素の実体がスクラブ後も保たれるか」を印を付けて測定
  （`kept === total`）。reuse を外すと `kept 0/3` で確実に FAIL することを確認済み＝ゲートに歯がある。
- **無回帰**: `npm run typecheck` 緑 / `npm test` 1281 passed（唯一の失敗 `liquidChrome 再登録` は
  本変更前から失敗していることを stash して確認済み・無関係）/ 既存 `verify-font-3d-extrude.mjs`・
  `verify-font-3d-weight.mjs`・`verify-geom3d-mvp.mjs`・`verify-geom3d-neutral.mjs` すべて PASS /
  `npm run build:player` 実行済み（`DomRenderer.ts` は player が import する共有ランタイム）。
- 恒久 verify として `verify-nested-geom3d.mjs` を追加（単独/ネスト ink 比・長時間スクラブでの
  canvas 同一性・export バイト等価の 3 点をまとめて検証）。

## 副産物・未対応のまま残っているもの

- 調査中に **WebGL context 数の上限**（geom3d が予算なしで per-layer に context を作る）を発見。
  別 issue として [webgl-context-limit.md](webgl-context-limit.md) に切り出し、応急処置として
  Pipeline パネルに `GL×N` バッジを追加した（本 issue の直接のスコープ外）。
- ネスト経路にはこの他にも未配線が残っている（今回のユーザー pj には該当要素がなく未検証・
  着手はユーザー判断待ち）:
  - **track matte** — ネスト内でマットが効かない
  - **plugin component の `ComponentDef.render`** — プラグイン型がネスト内で描画されない
  - **video プール / ループ warmup** — ネスト video が毎フレーム新規要素（decode churn）
  - html comp と raster 系 effect は Phase 1 の**意図的除外**（§28.11 のラスタ経路で別途反映）

## 手順の一般化

この調査・修正の型（2 本の描画パスの突き合わせ、子 comp の値を渡す原則、永続リソースの
持ち越し＋明示解放、実機ハーネスの罠）は
[.claude/skills/wire-feature-into-nested-comp/SKILL.md](../../.claude/skills/wire-feature-into-nested-comp/SKILL.md)
に汎用手順として切り出し済み。次に同種の「ネストで新機能が効かない」報告が来たら、まずこのスキルに従う。
