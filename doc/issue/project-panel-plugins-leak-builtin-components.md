# ProjectPanel「Plugins」パネルに builtin コンポーネント型が漏れて表示される

> **状態**: 2026-07-06 診断・**修正済み**（[ProjectPanel.tsx:60-61](../../src/editor/panels/ProjectPanel.tsx) に `registeredComponents` の `BUILTIN_COMPONENT_TYPES` フィルタが適用済み。Playwright 実機で確認: Plugins セクションは third-party plugin（`+ Gradient Rect`）のみ表示、builtin 6型は表示されない。Timeline 専用ボタン（`+ Solid`/`+ Shape`/`+ Text` 等）は無影響）。
> **重大度**: 低〜中（`+ Image` / `+ Video` / `+ Audio` は壊れたレイヤーを作れてしまう。`+ Shape` / `+ Text` / `+ Camera` は実害が小さい）。
> **対象外**: shape 機能自体（[doc/cloudplan/shape-editing-plan.md](../cloudplan/shape-editing-plan.md)）の実装・仕様は本 issue と無関係。あちらは別途 progress.md に完了記録済み。

---

## 症状

[ProjectPanel.tsx](../../src/editor/panels/ProjectPanel.tsx) 下部の「Plugins」セクション（third-party plugin の有効/無効チェックボックス・`+ Sample` ボタンが並ぶ区画）に、**本来 third-party plugin 専用のはずの一覧へ builtin 型がそのまま漏れて表示される**。

Playwright で実機確認した実際の表示内容:

```
Plugins-section '+ X' buttons: [ '+ Text', '+ Shape', '+ Image', '+ Video', '+ Audio', '+ Camera' ]
```

`solid` と `html` は該当しない（後述）。

## 根本原因

```tsx
// src/editor/panels/ProjectPanel.tsx:59
const registeredComponents = pluginsVersion >= 0 ? globalPluginRegistry.getComponentDefs() : [];
```

```ts
// src/runtime/pluginRegistry.ts:61
getComponentDefs(): ComponentDef[] {
  return [...this.components.values()];
}
```

`PluginRegistry` は builtin と third-party plugin を**同じ 1 個の `Map<string, ComponentDef>`** に登録しており（`registerComponent()` はどちらの経路でも同じメソッド）、`getComponentDefs()` はそれを無条件で全部返す。`registerBuiltinComponents()`（[builtinComponents.ts](../../src/runtime/builtinComponents.ts)）が `text` / `image` / `video` / `audio` / `camera` / `shape` をこのレジストリに登録しているため、`ProjectPanel.tsx` 側でフィルタせずに一覧化すると全部混ざる。

`solid` と `html` がここに出ないのは、この2つがそもそも `ComponentDef` として登録されていない（DomRenderer 等でハードコード分岐しているだけ）ため — 「登録されている builtin だけ全部漏れる」という一貫した挙動。

## クリックした時の実害

ボタンは専用の store アクション（`addText`/`addShape`/`addImageLayer` 等）ではなく、汎用の `addPluginObject(componentType)`（[store.ts:1585](../../src/editor/store.ts#L1585)）を呼ぶ。中身は「`ComponentDef.params` の `default` 値だけで props を組み立てる」という素朴な処理:

```ts
// src/editor/store.ts:1585
addPluginObject: (componentType) => {
  const componentDef = globalPluginRegistry.getComponentDef(componentType);
  ...
  const props: Record<string, AnimatedProp<unknown> | unknown> = {};
  for (const param of componentDef.params) {
    props[param.key] = param.animatable
      ? { value: param.default, keyframes: [] }
      : param.default;
  }
  ...
},
```

| type | Plugins パネル経由の結果 | 実害 |
|---|---|---|
| `shape` | `SHAPE_COMPONENT_DEF` の default（kind=rect, fill, radius\*, size）でほぼ `addShape()` と同等のレイヤーができる | 軽微（`size` の型が `{x,y}` か `{x,y,z}` かの差のみ。DomRenderer は x/y しか見ないため無害） |
| `text` | `TEXT_COMPONENT_DEF` の default（text:"Text" 等）で実用可能なテキストレイヤーができる | 軽微 |
| `camera` | `CAMERA_COMPONENT_DEF` の default で `addCamera()` とほぼ同等 | 軽微 |
| `image` / `video` / `audio` | 主パラメータが `asset: AssetId`（`kind:"asset"`, `default:""`）なので**空の asset 参照を持つレイヤー**が作られる | **実害あり** — 何も描画されない/再生されない壊れたレイヤーがタイムラインに追加される。エラー表示も出ないため、ユーザーは「レイヤーを足したのに何も映らない」という不可解な状態に陥る |

## UI 上の混乱

このセクションは見出しが「Plugins」で、直上に third-party plugin 用の有効/無効チェックボックス・バージョン表示・`+ Sample`（サンプル plugin インストール）ボタンが並ぶ。builtin 型のボタンは同じ見た目の横並びで紛れ込むため、ユーザーが「これは plugin の一種」と誤解しうる（実際には engine 組み込み型で、無効化の概念もない）。

## 提案する修正（未実施）

`bundleCollect.ts` の `BUILTIN_COMPONENT_TYPES` と同じ考え方で、一覧生成時に builtin を除外するだけで直る:

```tsx
// src/editor/panels/ProjectPanel.tsx
const registeredComponents = pluginsVersion >= 0
  ? globalPluginRegistry.getComponentDefs().filter((def) => !BUILTIN_COMPONENT_TYPES.has(def.type))
  : [];
```

`BUILTIN_COMPONENT_TYPES` は現状 [bundleCollect.ts](../../src/runtime/bundleCollect.ts) にモジュール内 private 定数として置かれているため、`export` するか、複数箇所から参照される共通の場所（例: `builtinComponents.ts` 自身）に切り出す必要がある。

影響範囲は「Plugins パネルの表示（どのボタンが出るか）だけ」で、レンダリング・resolve・export・bundle には一切触れない見込み。

### 検討事項（着手前に確認したいこと）

- `BUILTIN_COMPONENT_TYPES` を export/移動する際、`bundleCollect.ts` 側の既存 import・用途（bake 判定）に影響が出ないこと（単純な `export` 化なら影響なしのはず）。
- 除外後、「Plugins」セクション自体が空になるケース（plugin を1つも入れていないプロジェクト）の表示（現状 `registeredComponents.length > 0` のガードがあるため、単に非表示になるだけで問題なし）。

## 次にやるべきこと

1. `BUILTIN_COMPONENT_TYPES` を `bundleCollect.ts` から export（または `builtinComponents.ts` へ移動して両方から import）。
2. `ProjectPanel.tsx` の `registeredComponents` にフィルタを追加。
3. 回帰確認: 実際に third-party plugin（`+ Sample` でインストールされる sample plugin）は引き続き Plugins パネルに表示されること、builtin 6型（text/shape/image/video/audio/camera）は表示されなくなること、を Playwright 実機で確認。
4. 既存 `+ Text`/`+ Shape` 等の**専用**ボタン（Timeline ツールバー）には影響しないことを確認（本 issue はあくまで ProjectPanel の重複表示の話で、専用ボタン側は無関係）。

---

**関連実装**: [ProjectPanel.tsx](../../src/editor/panels/ProjectPanel.tsx) / [pluginRegistry.ts](../../src/runtime/pluginRegistry.ts) / [store.ts](../../src/editor/store.ts)（`addPluginObject`）/ [bundleCollect.ts](../../src/runtime/bundleCollect.ts)（`BUILTIN_COMPONENT_TYPES`）/ [builtinComponents.ts](../../src/runtime/builtinComponents.ts)
**発見経緯**: [doc/cloudplan/shape-editing-plan.md](../cloudplan/shape-editing-plan.md) の shape 機能実装セッション（2026-07-06）で Playwright 実機検証中に偶然発見。
