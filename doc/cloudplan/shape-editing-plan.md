# 非破壊・軽量シェイプ編集 機能設計プラン

> **ステータス**: ドラフト（未承認）。本ファイルは `doc/mafter-effect-spec.md`（SSoT）を置き換えない。
> §5 データスキーマ・INVARIANT に触れる項目は **ユーザー承認が必須**（CLAUDE.md 運用体制）。該当箇所は本文中に **⚠️ 要承認** と明記した。
> 作成日: 2026-07-06 / 対象ブランチ: `claude/shape-editing-design-plan-b58rmg`

---

## 0. TL;DR

- **`shape` コンポーネント型はすでに spec（§5.5 L317-326）と実装の両方に「幽霊配線」として存在する** — 矩形・楕円の描画（`DomRenderer.ts` の `case "shape"`）と選択バウンディングボックス（`previewViewer.ts` の `boundsForComponent`）は動くが、**生成 UI・Inspector 編集・ComponentDef 登録が丸ごと欠落**しており、実際にプロジェクトへ shape レイヤーを追加する手段が存在しない。
- **「軽量」の核心はこれを仕上げること** — 矩形/楕円 shape の完成には **§5 スキーマ変更ゼロ・INV変更ゼロ**で済む。既存の `Component.props` 契約（`kind`/`fill`/`radius`/`size`）をそのまま使い、`.claude/skills/add-layer-component-type/SKILL.md` の配線チェックリストを埋めるだけの作業。
- **頂点／ベジェパスの編集**（AE のペンツール相当）は別軸の重い機能で、新規データ型・新規 SVG レンダリング・新規オンキャンバス gizmo が要る。spec 自身が `doc/mafter-effect-spec.md:1714` で「マスク・シェイプのオンキャンバス編集」を **将来（§16）** と明記しており、§5.4f のトラックマット節（L291）でも「レイヤーパスマスク（ペン/ベジェ）は含まない（将来）」と非目標に挙げている。
- 本プランは **Phase 1（軽量・非破壊、今回のスコープ）= 矩形/楕円 shape の完成配線** を主提案とし、**Phase 2（頂点編集・将来拡張）** をロードマップとして分離する。
- **UI 方針（確定）**: シェイプ編集画面はすべて Inspector パネルの「Shape」フォールドアウト・**`kind` プルダウンを単一入口**に集約する（§3.3）。ツールバーに kind 別ボタンを増やす、別パネルを新設する、といった分散は行わない。Phase 2 で kind に `polygon`/`path` を足す場合も、この同じフォールドアウト内に専用サブセクションとして生やす。

---

## 1. 現状調査サマリ（コード根拠）

### 1.1 `shape` は「半分だけ配線済み」

| 箇所 | 状態 |
|---|---|
| `doc/mafter-effect-spec.md:317-326` | `shape` を MVP 組み込み型として明記済み（`kind` / `fill: RGBA` / `radius` / `size: vec2`）。`exportStrategy` 既定 `"live"`（L334）。 |
| `src/runtime/DomRenderer.ts:2012-2021` | `case "shape"` 実装済み。`size` → width/height、`fill` → `background`、`kind === "ellipse"` → `border-radius: 50%`、それ以外は `radius` px。**CSS box であり SVG `<path>` ではない**（矩形/楕円限定）。 |
| `src/runtime/bundleCollect.ts:28-38` | `BUILTIN_COMPONENT_TYPES` に `"shape"` 登録済み → bundle export の bake 誤判定（camera 事故と同型）は回避済み。 |
| `src/editor/previewViewer.ts:279-293` | `boundsForComponent()` に `case "solid": case "shape":` あり。選択ギズモのバウンディングボックス計算は shape でも動く。 |
| `src/runtime/builtinComponents.ts` | **`ComponentDef` 登録なし**（`text`/`image`/`video`/`audio`/`camera` のみ登録。`solid` も同様に未登録＝両方ハードコード特殊扱い）。 |
| `src/editor/store.ts` | `addSolid`（L246 宣言 / L1011-1038 実装）はあるが **`addShape` が存在しない** → エディタから shape レイヤーを作る手段が皆無。 |
| `src/editor/panels/InspectorPanel.tsx:724-729` | `comp.type` が `"text" | "solid" | "audio" | "video"` 以外は `return null` — 明示的허용リストに `shape` が入っておらず、**存在しても Inspector に何も出ない**。 |
| `src/editor/panels/TimelinePanel.tsx` | `+ Solid` ボタン（`addSolid` 呼び出し）はあるが `+ Shape` ボタンなし。`SolidComponentFields` はあるが `ShapeComponentFields` 相当なし。 |
| `src/editor/layerLabels.ts:34-51` | `defaultLabelIndexForObject()` に `case "solid"` はあるが `case "shape"` なし（既定インデックスにフォールバック）。 |

### 1.2 頂点／パスのデータモデルは一切存在しない

`src/core/schema.ts` を `path|Path|vertices|anchorPoints|bezier|Bezier` で grep しても、ヒットするのは easing の `{type:"bezier", bezier:[...]}`（CSS cubic-bezier）と asset の `path: string`（ファイルパス）のみ。**頂点配列・アンカーポイント配列・ベジェハンドルに相当する型は存在しない。**

SVG 自体は使われているが、**ユーザーが編集する「コンテンツ」としての SVG ではなく、フィルタ用の中間生成物**としてのみ登場する:

- `src/runtime/effectSvg.ts`（951行）— displacement 系エフェクトの `feTurbulence`/`feDisplacementMap` 用マップ画像、wipe 系の `linearWipeMask`/`angularWipeMask`（SVG `<path>` パイ形マスクを生成）、dither dissolve の Bayer/blue-noise パターンマスク。すべて `feImage`/`feComposite` に食わせる不可視の中間データ。
- `src/runtime/ditherReveal.ts` — 上記の量子化ヘルパ。
- `src/runtime/trackMatteApply.ts`（67行）— トラックマットの合成は **RGBA バッファ上の純関数**（`applyTrackMatte`）。ライブ表示形は comp 空間 SVG `<mask>`（spec L273）だが、ユーザーが直接触るパスジオメトリではない。

→ 「軽量なシェイプ編集」を矩形/楕円の枠を超えて多角形/ベジェパスまで含めるなら、**この基盤は今回ゼロから作る必要がある**。既存コードの SVG 文字列生成規約（`effectSvg.ts`）・バッファ合成規約（`trackMatteApply.ts`）は流用できるパターンとして参考にできる。

### 1.3 オンキャンバスの対話編集基盤

`src/editor/panels/PreviewViewerOverlay.tsx`（611行）に **オブジェクト全体の Transform ギズモ**（バウンディングボックス + 8スケールハンドル + アンカー丸）は実装済み（spec §25.3 準拠）。ドラッグ→`previewViewer.ts` の座標変換ヘルパ（`anchorCompPosition`/`applyRotationFromDrag`/`compensatePositionForAnchor`）→ mouseup で 1 コマンド確定という undo 対応済みのパターンがある。

ただし、これは **常に4値（position/scale/rotation/anchor）を編集するだけ**であり、「シェイプが持つ任意個数の頂点」という概念は一切ない。`src/editor/motionTrack/` 配下のトラッキング点 UI が「プレビュー上に複数の点を置いてドラッグする」という見た目上は近い前例だが、これはトラッキング解析専用のエディタ内 UI で、`project.json` に永続化される編集可能な頂点配列ではない。

**→ 頂点編集 gizmo（Phase 2）は既存の `SelectionHandles` を置き換えず、並列の新規オーバーレイとして設計する必要がある。**

### 1.4 「非破壊」の既存担保パターン

このプロジェクトの undo/redo は「コマンド + 逆パッチ（JSON patch）」方式（CLAUDE.md 設計決定）。`addSolid`/Transform ギズモのドラッグ確定など、既存の編集はすべて **`project.json` 上の値を直接書き換えるだけ**で、ラスタライズ・ベイクを伴わない。矩形/楕円 shape も色/サイズを `AnimatedProp` として持つため、キーフレーム可能・undo 可能・常にライブ再計算（INV-2）という「非破壊」の定義に自然に合致する。Phase 2 の頂点データも同じ `AnimatedProp<Vec3>` パターンを踏襲すれば非破壊性は保てる。

---

## 2. スコープ定義

### Phase 1（今回の主提案・軽量・非破壊）— 矩形/楕円 shape の完成配線

**追加するデータ型: ゼロ。** spec §5.5 に既にある `shape` コンポーネントの props（`kind: "rect"|"ellipse"`, `fill: RGBA`, `radius: number`, `size: Vec2`）をそのまま使う。`Component.props` は元々 `Record<string, AnimatedProp<unknown> | unknown>`（schema.ts L57-61）という開いた契約なので、**§5 の型定義そのものへの変更は不要**。

やることは `.claude/skills/add-layer-component-type/SKILL.md` のチェックリストのうち、camera/video 追加時にも通った「配線」作業のみ:

1. `builtinComponents.ts` に `SHAPE_COMPONENT_DEF` を登録（`TEXT_COMPONENT_DEF` と同型。`params: ParamDescriptor[]` で `kind`(enum rect/ellipse) / `fill`(color) / `radius`(scalar) / `size`(vec2 相当 — 既存 `size` は `{x,y}` の生 prop なので `text` の `boxWidth`/`boxHeight` 同様スカラー2本 or 専用 UI で対応)。
2. `store.ts` に `addShape(name?)` を追加（`addSolid` L1011-1038 と同型パターン。既定 `kind: "rect"`, `fill: {r:0.5,g:0.7,b:0.9,a:1}`, `size: staticProp(vec3(200,200,0))`, `radius: staticProp(0)`）。
3. `InspectorPanel.tsx:724-729` の許可リストに `"shape"` を追加し、`ShapeComponentFields`（`SolidComponentFields` L2016-2035 相当）を新設 — kind セレクタ・fill カラーチップ・radius/size のアニメータブル行。
4. `TimelinePanel.tsx` に `+ Shape` ツールバーボタン（`+ Solid` L1088 隣接）を追加し `addShape` を呼ぶ。
5. `layerLabels.ts:34-51` の `defaultLabelIndexForObject()` に `case "shape":` を追加（`solid` と同じか近いラベル色）。
6. 既存の `DomRenderer.ts` `case "shape"`（L2012-2021）・`bundleCollect.ts` の `BUILTIN_COMPONENT_TYPES`・`previewViewer.ts` の `boundsForComponent` は **変更不要**（すでに正しく配線済み）。

**この段階で得られる編集体験**: タイムラインの `+ Shape` から矩形/楕円レイヤーを追加 → Inspector で色・角丸・サイズをキーフレーム可能に編集 → 既存の `SelectionHandles`（Transform ギズモ）でオンキャンバスの移動/リサイズ/回転がそのまま効く（`boundsForComponent` が既に対応しているため新規 gizmo 実装は不要）。**これが「軽量」の実体** — 新規スキーマなし、新規レンダラなし、新規ギズモなし、Inspector と生成導線だけ。

**§E（export 正常化）の要否**: `shape` は CSS box のまま（SVG `<path>` を導入しない）なので、`solid` と同じ扱いで `foreignObject` 一括経路に自然に乗る。**新規の export 専用分岐は不要**と見込むが、実装時に既存 `verify-*-export*.mjs`／bundle bake 件数テストで無回帰確認は必須（add-layer-component-type §E の手順どおり）。

### Phase 2（将来ロードマップ・今回のスコープ外）— 多角形/ベジェパス編集

矩形/楕円を超えて「ペンツールで頂点を打つ」「ベジェハンドルで曲線を作る」レベルの shape 編集は、spec が明示的に将来（§16 / L1714）と位置付けている大きな機能で、以下が必要になる:

- ⚠️ **要承認（§5 スキーマ変更）**: 頂点データ型の新設。例:
  ```ts
  interface ShapeVertex {
    id: string; // ULID (INV-6 — 挿入/並べ替えを跨いで安定参照するため index 参照は不可)
    pos: AnimatedProp<Vec3>;
    inTangent?: AnimatedProp<Vec3>;
    outTangent?: AnimatedProp<Vec3>;
  }
  ```
  `Component.props` に `vertices?: ShapeVertex[]` を additive-optional で追加。`ParamKind`（schema.ts L79-87）に頂点配列を表す新種別（例 `"vertices"`）を足すかは要検討。
- ⚠️ **要承認（INV-6 の適用範囲確認）**: 頂点の安定 ID を「stable ID（ULID）」の対象に含めるかどうかの明示。
- **新規レンダラ経路**: `DomRenderer.ts` に SVG `<path d="...">` を生成する分岐を追加（CSS box では表現不可）。INV-2/INV-3 を守るため resolve 済み `props` から純関数でパス文字列を組み立てる（`effectSvg.ts` の文字列生成規約が参考になる）。
- **export 正常化（§E 必須）**: SVG content レイヤーは `solid` と違い `foreignObject` 一括経路がそのまま安全とは限らない（ラスタキャプチャでの座標系・アンチエイリアス差異を検証する必要がある）。既存 export 経路（mp4/webm/PNG連番/bundle/`compFrameCapture`）の無回帰確認が必須。
- **新規オンキャンバス gizmo**: 頂点ごとのドラッグハンドル・ベジェタンジェントハンドル・頂点追加/削除 UI。既存 `SelectionHandles`（`PreviewViewerOverlay.tsx`）とは独立した新規オーバーレイとして実装（既存の8ハンドルギズモを頂点数不定の shape 用に置き換えるのは無理があるため）。
- **track matte との関係**: spec L291 で「レイヤーパスマスクは将来」と明記されているとおり、Phase 2 の頂点シェイプが将来的にベクトルマスク（トラックマットに変わる per-layer pen mask）の土台になり得るが、**トラックマットの仕様自体（§5.4f）を変更するのは別タスク**として切り離す。

Phase 2 は本プランではロードマップの記載に留め、着手する場合は改めて §5/INV 変更の承認を得てから設計を確定する。

### Phase 3（将来ロードマップ・Phase 2 前提）— Boolean（Pathfinder）合成

**ユーザー要望**: 「差分・合成」等のシェイプ bool 処理（AE の Pathfinder / Merge Paths 相当: Unite / Subtract / Intersect / Exclude）を Inspector の Shape フォールドアウト内に**入れ子のフォールドアウト**として用意しておきたい。

**スコープ上の位置づけ**: bool 処理は「1レイヤーが複数のサブパスを持ち、それらを合成規則で1枚の塗り面へ畳み込む」処理であり、原理的に CSS box（矩形/楕円の `border-radius`）では表現できず、**Phase 2 の SVG `<path>` 基盤が前提**になる。したがって本プランでは Phase 3 として Phase 2 の直後に位置づけ、**Phase 1（軽量・今回スコープ）には含めない**。

想定データモデル（⚠️ 要承認・§5 スキーマ変更、Phase 2 の `ShapeVertex` 型に追加で必要）:

```ts
type BooleanOp = "unite" | "subtract" | "intersect" | "exclude"; // AE Merge Paths 相当

interface ShapeSubPath {
  id: string; // ULID (INV-6)
  vertices: ShapeVertex[]; // Phase 2 で定義する頂点配列（rect/ellipse プリセットからの生成も可）
  op: BooleanOp; // このサブパスを「直前までの合成結果」に対してどう合成するか（AE の重ね順依存と同じ規約）
}
```

`Component.props` に `subPaths?: ShapeSubPath[]` を additive-optional で追加し、`subPaths` が存在する場合は最上位の `kind`/`fill`/`radius`/`size` 単体プロパティより優先して合成結果を描画する（存在しなければ Phase 1/2 の単一図形のまま、後方互換）。

**UI（§3.3 の集約方針に従う）**: Inspector の Shape フォールドアウト内、`kind` プルダウンの下に **「Path Operations」という入れ子のフォールドアウト**を追加する。中身は AE の Pathfinder 的な「サブパスの縦リスト + 各行に Boolean op プルダウン（Unite/Subtract/Intersect/Exclude）+ 追加/削除/並べ替え」。**Phase 1 の間はこのフォールドアウトを表示しない（または常時無効化 disabled）**— サブパス配列が存在しない単一図形オブジェクトには意味がないため。Phase 2（頂点編集基盤）が入って初めて有効化する。

**レンダリング**: 合成後のパス文字列は resolve 済み `subPaths` から純関数で計算（INV-1）。ブラウザ側の bool 演算は自前実装 or 既存 path-boolean アルゴリズムの導入要否を Phase 2/3 着手時に検討（外部ライブラリ導入は依存追加として別途相談）。

**export 正常化（§E）**: 合成後の1枚のパスとして描画するため、経路自体は Phase 2 の SVG `<path>` export 対応がそのまま使える見込みだが、サブパス数が多い場合のラスタキャプチャ精度は Phase 2/3 着手時に実機検証が必要。

Phase 3 も本プランではロードマップ記載のみ。着手する場合は Phase 2 と合わせて §5/INV 変更の承認を得てから設計を確定する。

---

## 3. Phase 1 詳細設計

### 3.1 ComponentDef（`builtinComponents.ts` 追加案）

```ts
const SHAPE_COMPONENT_DEF: ComponentDef = {
  type: "shape",
  label: "Shape",
  previewBakeRequired: false,
  params: [
    { key: "kind", label: "Kind", kind: "enum", default: "rect", animatable: false, options: ["rect", "ellipse"] },
    { key: "fill", label: "Fill", kind: "color", default: { r: 0.5, g: 0.7, b: 0.9, a: 1 }, animatable: true },
    { key: "radius", label: "Corner Radius", kind: "scalar", default: 0, animatable: true, min: 0 },
    // size は既存 solid と同じく vec2 生 prop（{x,y}）。ParamKind に "vec2" があるので流用可。
    { key: "size", label: "Size", kind: "vec2", default: { x: 200, y: 200 }, animatable: true },
  ],
  render() { /* DomRenderer 側で既存実装 */ },
};
```

`registerBuiltinComponents()` に `SHAPE_COMPONENT_DEF` を追加登録するだけ。`ParamKind` に `"vec2"` が既存かどうかは実装時に schema.ts L79-87 を確認（`"vec2" | "vec3"` は既にある — 問題なし、スキーマ変更不要）。

### 3.2 `store.ts` `addShape`（`addSolid` 踏襲）

```ts
addShape: (name) => {
  const id = newObjectId();
  const p = get().project;
  const comp = p?.compositions.find((c) => c.id === get().currentCompId) as TimelineComposition | undefined;
  const duration = comp?.duration ?? 150;
  const obj: SceneObject = {
    id, name: name ?? "Shape", parent: null, zOrder: nextZOrder(comp),
    enabled: true, inPoint: 0, outPoint: duration,
    transform: defaultTransform(), opacity: staticProp(1),
    components: [{
      type: "shape",
      props: {
        kind: "rect",
        fill: { value: { r: 0.5, g: 0.7, b: 0.9, a: 1 }, keyframes: [] },
        radius: staticProp(0),
        size: staticProp(vec3(200, 200, 0)),
      },
    }],
  };
  cmdAddObject(get(), obj);
  return id;
},
```

### 3.3 Inspector（`ShapeComponentFields` 新設・UI 集約方針）

**方針（ユーザー指示）**: シェイプ編集に関わる画面はすべて Inspector パネルの「Shape」フォールドアウト内、**`kind` プルダウン（enum セレクタ）を単一入口**にして集約する。ツールバー側に kind 別ボタンを増やしたり、別パネル/別モーダルを新設したりはしない。

- `SolidComponentFields`（`InspectorPanel.tsx:2016-2035`／`SolidColorChip` L2437-2467）とほぼ同型の `ShapeComponentFields` を新設し、`InspectorPanel.tsx:724-729` の許可リスト経由で `comp.type === "shape"` の1フォールドアウトとして表示する。
- フォールドアウト内の構成（上から）:
  1. **`kind` プルダウン**（`rect` / `ellipse`）— これが「今どの図形として振る舞うか」を決める唯一のスイッチ。
  2. `fill`（カラーチップ、アニメータブル）
  3. `radius`（アニメータブル数値行）— `kind === "rect"` のときのみ表示、`ellipse` では非表示（disabled ではなく非表示にして「効かない項目が残る」混乱を避ける）。
  4. `size`（vec2、アニメータブル）— 両 kind 共通。
- **Phase 2 との接続点もここに集約する**: 将来 `kind` に `"polygon"`/`"path"` を追加する場合も、新しい編集導線（頂点リスト・頂点追加/削除ボタン・オンキャンバス gizmo の起動トリガ）は**この同じ Shape フォールドアウト内**、`kind` プルダウンで選んだときにだけ現れる専用サブセクションとして生やす。ツールバーの `+ Shape` ボタンは「shape オブジェクトを作る」ことだけを担い、生成後の見た目・種類の切り替えは常に Inspector 側に一本化する。
- **Phase 3（Boolean/Pathfinder 合成）も入れ子フォールドアウトとしてここに収める**: `kind` プルダウンの下に **「Path Operations」フォールドアウト**（サブパス一覧 + 各行の Unite/Subtract/Intersect/Exclude プルダウン + 追加/削除/並べ替え、AE Pathfinder 相当）を追加する。Phase 1 の間は `subPaths` が存在しないため**このフォールドアウトを表示しない**（Phase 2 導入後に条件表示へ切り替える）。詳細は §2 Phase 3 参照。
- Timeline 側の `+ Shape` ボタン（3.4）は生成専用であり、kind ごとに `+ Rect` / `+ Ellipse` のようにボタンを分けない（既定 kind で1つ作り、その後は Inspector の kind プルダウンで切り替える）。

### 3.4 Timeline ボタン・ラベル色

- `TimelinePanel.tsx` の `+ Solid` ボタン隣に `+ Shape` を追加、`addShape()` を呼ぶだけ。
- `layerLabels.ts` の `defaultLabelIndexForObject()` に `case "shape":` を足す（`solid` と同一 or 近似色を割当て — 具体色は実装時に相談）。

### 3.5 影響しない箇所（確認のみ）

- `DomRenderer.ts` `case "shape"`（既存）— 変更不要。
- `bundleCollect.ts` `BUILTIN_COMPONENT_TYPES`（既存に `"shape"` あり）— 変更不要。
- `previewViewer.ts` `boundsForComponent`（既存に `case "shape"` あり）— 変更不要。
- `resolve.ts` — shape はシーンレベル状態（camera のような）を持たないため分岐追加不要。
- `serialize.ts`/`validate.ts` — 新規フィールドを追加しない（既存 props のみ使う）ため変更不要。ただし `addShape` で生成する props の既定値が「省略時デフォルトと一致するか」は要確認（INV-4 のバイト等価に影響しうる — 例えば `radius: staticProp(0)` を明示的に持たせるか、省略して ComponentDef 側の `default: 0` に委ねるかは実装時に既存 `solid`/`text` の慣習に合わせる）。

---

## 4. §5 / INV への影響サマリ（承認要否）

| 項目 | Phase 1（矩形/楕円） | Phase 2（頂点/パス） | Phase 3（Boolean/Pathfinder） |
|---|---|---|---|
| §5 `SceneObject` 型変更 | **なし** | ⚠️ 要承認（頂点構造の新設） | ⚠️ 要承認（`subPaths`/`BooleanOp` の新設。Phase 2 型に依存） |
| §5 `Component`/`ParamKind` 型変更 | **なし**（既存 `vec2`/`color`/`scalar`/`enum` で足りる） | ⚠️ 要承認（`ParamKind` 新種別の要否） | ⚠️ 要承認（`subPaths` 用の新 `ParamKind` or 専用 UI の要否） |
| INV-1〜6 | 影響なし（既存 `AnimatedProp` パターンのみ使用） | INV-3（レンダラ非依存データ）・INV-6（頂点の stable ID）の適用範囲を要確認 | INV-1（bool 演算も純関数であること）・INV-6（サブパス自体の stable ID）を要確認 |
| `project.json` 直列化形式 | 変更なし | 新規フィールド追加（additive-optional なら形式変更ではなく拡張だが、念のため確認） | 同左（`subPaths` 追加） |

**結論**: Phase 1 は CLAUDE.md の「勝手に進めず確認が必要」な3項目（INV変更・§5型変更・project.json直列化形式変更）のいずれにも該当しない、純粋な配線作業。Phase 2・Phase 3 に進む場合はそれぞれ着手前に改めてユーザー確認が必要（Phase 3 は Phase 2 の型を前提にするため単独では着手不可）。

---

## 5. 検証計画（Phase 1）

`.claude/skills/implementation-loop/SKILL.md` の手順に従い、完了条件を「新型 verify が緑」だけにしない:

1. **unit**: `resolve()`/`serialize()`（byte-equal）で shape オブジェクトを含むケースを追加。`componentNeedsBake`/`findBakeTargets` で shape を含む comp が誤って bake 対象にならないことをピン止め。
2. **既存回帰**: `npm test` 全体・`playerBuildFreshness`（今回 runtime 変更は無い見込みだが `DomRenderer.ts` 等 runtime 配下に触れた場合は `npm run build:player` 要再実行）。
3. **実機 Playwright**: `+ Shape` → プレビューに矩形/楕円が表示される → Inspector で色/角丸/サイズを編集できる → 既存 Transform ギズモで移動/リサイズ/回転できる → export（mp4 or PNG連番）で shape が正しく焼き込まれる → 既存の `verify-blend-mode.mjs` 等、無関係シナリオが無回帰であることを確認。
4. **bundle export**: HTML bundle export で shape レイヤーが正しく表示されること（`shape` の `exportStrategy` 既定 `"live"` が実際に効いているか）。

---

## 6. オープン質問（実装着手前にユーザーへ確認したい点）

- **Q1**: Phase 1（矩形/楕円のみ、新規スキーマなし）を今回のゴールとして確定してよいか。それとも「シェイプ編集」という言葉に多角形/自由パスの期待が含まれるか。
- **Q2**: `radius` の意味は AE 同様「四隅共通の角丸半径」でよいか（四隅個別角丸は Phase 2 以降）。
- **Q3**: ellipse は現状 `size.x`/`size.y` で楕円の外接矩形を決める実装（`border-radius:50%`）だが、真円強制オプション（shift 拘束等)は Phase 1 に含めるか。
- **Q4**: Phase 2（頂点編集）に進む場合、トラックマットのペン/ベジェマスク（spec L291 の非目標）とどちらを先に設計するか、あるいは同一データ型の共用を狙うか。
- **Q5**: Phase 3 の Boolean/Pathfinder（Unite/Subtract/Intersect/Exclude）は「Phase 2 の頂点/パス shape 同士」の合成のみを想定してよいか、それとも AE のシェイプグループのように **矩形/楕円プリミティブのままサブパスとして複数持ち bool 合成する**（Phase 2 の自由パス無しでも成立する中間形態）ケースも要求に含めるか。後者なら Phase 1→Phase 3 を Phase 2 なしで先に着手できる可能性がある。

---

## 7. 参照

- `doc/mafter-effect-spec.md` §5.4f（L271-291, トラックマット・非目標）/ §5.5（L293-334, Component/ParamDescriptor/MVP型表）/ §25（L1714, 将来スコープ表）
- `.claude/skills/add-layer-component-type/SKILL.md`（配線チェックリスト・camera bake 誤判定の実例）
- `src/core/schema.ts`（SSoT 実体: `SceneObject` L101-123 / `Component` L57-61 / `ParamKind` L79-87）
- `src/runtime/builtinComponents.ts` / `src/runtime/DomRenderer.ts:2004-2021` / `src/runtime/bundleCollect.ts:28-38`
- `src/editor/store.ts`（`addSolid` L1011-1038）/ `src/editor/panels/InspectorPanel.tsx:724-729`（型許可リスト）/ `src/editor/panels/TimelinePanel.tsx`（`+ Solid` ボタン）/ `src/editor/layerLabels.ts:34-51`
- `src/editor/panels/PreviewViewerOverlay.tsx`（既存 Transform ギズモ）/ `src/editor/previewViewer.ts:279-293`（`boundsForComponent`）
