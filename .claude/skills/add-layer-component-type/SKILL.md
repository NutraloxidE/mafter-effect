---
name: add-layer-component-type
description: Mafter Effect に新しいレイヤー／コンポーネント型（camera / scene3d / light / shape / 新コンテンツ型など built-in component）を追加・変更するときの「配線もれ」防止チェックリスト。新型は ComponentDef を登録しただけでは不十分で、型の挙動は `c.type` で分岐する 10〜15 箇所に散在する（bundle bake 判定・レンダラ・resolve・キャッシュ・タイムライン source・UI・直列化）。登録した型が export で誤って動画化される／キャッシュが効かない／タイムラインで尺が出ない／UI に出ない、等の「片側だけ壊れる」症状や、その予防に使う。描画型の export 正常化では共有 capture パイプラインを触るため、新型 verify だけでなく既存 export 経路の無回帰（§E）が必須。エフェクト（EffectInstance）追加は別軸＝implement-visual-effect を見る。
---

# 新しいレイヤー／コンポーネント型の配線チェック

このコードベースでは **コンポーネント型の挙動が 1 箇所に集約されておらず**、`c.type === "..."` で
分岐するディスパッチ点・型の集合定数が **src 全体に 10〜15 箇所**散らばっている。
ComponentDef を `registerBuiltinComponents` に足しただけでは半分しか配線されず、
**触れていない経路だけが静かに誤動作**する（緑のテストをすり抜ける）。

**親ループ**: [implementation-loop](../implementation-loop/SKILL.md) Phase 2c（ディスパッチ点）・Phase 4（配線検証）。

> 実例（2026-06-23）: `camera` を builtin 登録したが [bundleCollect.ts](../../../src/runtime/bundleCollect.ts)
> の `BUILTIN_COMPONENT_TYPES` に入れ忘れ → `componentNeedsBake` がプラグイン扱い →
> `bundleExportDefault` 未指定で**既定 bake** → 非描画のカメラ層が Static HTML 書き出しで
> 無意味に動画化された。preview/typecheck/通常 export は無傷だったため発覚が遅れた。

## 使うとき
- built-in component 型を**新規追加**する（camera / scene3d / light / shape / 新コンテンツ等）。
- 既存の型に**新しい挙動軸**（非描画／アセット参照／音声／source 尺／scene レベル状態）を足す。
- 「型 X が preview では出るのに export / bundle / cache / timeline の一経路だけ挙動が変」を直す。

## 中核原則：型の挙動を「全ディスパッチ点」で意思決定する
新型を足す前に、まず **`c.type ===` と型集合定数を全部洗い出す**：

```
grep -rn 'c\.type === "\|component\.type\|\.some((c) => c\.type\|BUILTIN_COMPONENT_TYPES\|case "solid"' src/
```

各ヒットで「この新型はここで何をすべきか（描画する／しない・bake する／しない・
アセットを持つ／持たない・尺を持つ／持たない・UI に出す／出さない）」を**明示的に決める**。
"何もしない" も決定。決めずに通り過ぎた経路が後でバグになる。

## 配線チェックリスト（コピーして進捗管理）

### A. 登録・スキーマ（必須）
```
- [ ] builtinComponents.ts に ComponentDef を登録（type/label/params:ParamDescriptor[]/render/
      previewBakeRequired/bundleExportDefault）。非描画型(camera/null 系)は render を no-op に
- [ ] ★ bundleCollect.ts BUILTIN_COMPONENT_TYPES に型名を追加
      （入れないと componentNeedsBake がプラグイン扱い→既定 bake。これが今回の罠）
- [ ] bundleExportDefault / exportStrategy の既定を意図どおりに：
      非描画→絶対 bake しない（builtin set に入れる）／重い WebGL/3D→"bake"／CSS live→"live"
- [ ] schema.ts に新フィールドが要るなら additive optional で追加（§5 が SSoT。
      INV/§5 型変更はユーザー承認）
- [ ] serialize.ts: 新フィールドは既定値のとき省略（byte 等価＝INV-4）
- [ ] validate.ts: load 時に新フィールド/型を検証・正規化
```

### B. ランタイム（描画・解決・キャッシュ）
```
- [ ] DomRenderer: createComponentEl(type) と applyObject の描画パス。非描画型は空 div/no-op。
      export 用 static パスも同様に
- [ ] resolve.ts: scene レベル状態を駆動する型か（camera→scene.camera）。
      非描画でも components に乗せるか除外するか（null/adjustment は components を空に）
- [ ] compContentHash.ts: 新型がキャッシュ無効化に影響するなら content hash に含める
      （precomp ラスタキャッシュの取りこぼし防止）
- [ ] INV-1/2/3: resolve は純関数のまま・renderer のみ ResolvedScene を受ける
```

### C. タイムライン source / アセット / 音声
```
- [ ] collectObjectAssets (bundleCollect): アセット参照型なら asset path を収集
      （image/video/audio と同列に）
- [ ] layout.ts / layerSourceOffset.ts: source 尺(trim)を持つ型なら source extent を提供
- [ ] exporter.ts / BundleAudioClock.ts: 音声を持つ型なら mux/クロックに配線
- [ ] compLayer.ts: ネスト(precomp)的に振る舞う型なら depth/循環検証
```

### D. UI
```
- [ ] InspectorPanel.tsx: 型の params 編集 UI（専用フォールド or 汎用 ParamDescriptor 描画）
- [ ] TimelinePanel.tsx: レイヤー行バッジ/トグル/`+<Type>` ツールバーボタン
- [ ] store.ts: add<Type> アクション（既定 props・位置・名前）。既定 props は妥当値に
- [ ] previewViewer.ts: ビューポート直接操作が要る型なら配線
```

### E. Export 正常化（描画型・他経路無回帰 — 必須）

新型が **ピクセルを出す描画コンポーネント**（`video` / `image` / shape 等）のとき、export は preview と別の制約（`foreignObject`・seek 精度・インライン化・決定論フレームステップ）を持つ。**その型の export を直すだけで完了にしない。**

```
- [ ] export 専用経路を型で閉じる: c.type 分岐・DomRenderer の flush*・rasterCapture の
      inline*・exporter/compFrameCapture の明示フラグ（例: exportVideoStep, inlineVideoFrames）
- [ ] 共有パイプライン変更は最小: rasterCapture / videoElementSync / exporter の
      デフォルト挙動を全レイヤー一律に変えない（変えるなら全経路の回帰理由を明記）
- [ ] preview と export のメディア同期はモード分岐維持（play 最適化 vs seek+rVFC 決定論）
- [ ] browser export（mp4/webm/PNG）+ compFrameCapture（ネスト・調整 raster）+
      bundle player のどれに効くか Phase 2 で列挙
- [ ] ★ 既存 export 無回帰: 新型 verify に加え、無関係なはずのコンプでも PASS
      （solid/text/image のみ・blend 合成・調整レイヤー・fast displacement・bundle bake 件数等）
- [ ] 回帰テスト: 新型の export/capture ユニット + 既存 test/rasterCapture・bundleExport 等
```

worked example（2026-06-26・video）: `<video>` は foreignObject で描画不可 → clone 側のみ img 化（`inlineVideoFrames`）。`waitForVideoFrame` / `exportVideoStep` は video 経路に閉じ、solid/text/image の単一スナップショット高速経路や blend per-layer 合成を壊さない。完了条件 = `verify-video-export.mjs` + 既存 export シナリオ無回帰。

### F. 検証（緑 ≠ 配線完了）
```
- [ ] ユニット: resolve / serialize(byte 等価) / componentNeedsBake / findBakeTargets を新型で固定
- [ ] ★ bake 回帰: 「新型＋他レイヤーのみ」のコンプで findBakeTargets が意図どおり
      （非描画型が誤って bake 対象に入らないこと）
- [ ] Playwright 実機: add<Type>→ preview 描画 → export ダイアログの bake 件数 → console error 0
- [ ] 描画型なら E（export 正常化・他経路無回帰）を完了
- [ ] typecheck / npm test / build 緑
```

## 関係する設計軸・懸念点（混同しやすい）
- **builtin vs plugin の既定 bake**: `BUILTIN_COMPONENT_TYPES` に**無い**型はすべてプラグイン扱いで
  **既定 bake**（第三者コードを bundle で配らない安全側・§11.7）。built-in は必ずこの集合に入れる。
  → これは "two sources of truth"（登録リストと bake 判定リストが別）。新 builtin は**両方**に足す。
- **2 つの "bake" 軸は独立**: `previewBakeRequired`（preview/RAM cache 専用メタ・§28）と
  `bundleExportDefault`/`exportStrategy`（bundle export の live/bake・§11.7）は**別物**。混同しない。
- **effects は bundle bake 対象外**: `findBakeTargets` は **components のみ**判定。エフェクト
  （blur/turbulent 等）は bundle で live 再実行される。エフェクト追加は本スキルでなく
  [implement-visual-effect](../implement-visual-effect/SKILL.md)。
- **非描画レイヤー（camera/null）**: 出力にピクセルを出さない。null は resolve で components を空に
  して除外、camera は components に残すが render no-op。**どちらも絶対 bake しない**。
  新たな非描画/メタ型を足すときは「描画しない・bake しない・尺を持たない」を全経路で徹底。
- **3D/カメラ型**: scene.camera を駆動（resolve）、CSS リグは per-object（§6.5b）。
  scene3d(将来) は WebGL ＝ `bundleExportDefault:"bake"` 候補、light(将来) は非描画＝builtin/no-bake。
- **アセット/source 型**: アセット参照は collectObjectAssets、source 尺は layout/layerSourceOffset、
  音声は exporter/BundleAudioClock。1 つ漏れると「bundle に同梱されない／タイムライン尺が出ない／
  音が出ない」になる。

## アンチパターン
- ComponentDef 登録だけで「追加完了」とする（挙動は 10+ 箇所に散在）。
- `BUILTIN_COMPONENT_TYPES` への追加を忘れる（→ 既定 bake。今回の実例）。
- `previewBakeRequired` と `bundleExportDefault` を同一視する。
- 非描画/メタ型を bake 候補のまま放置する（無意味な動画アセットを生む）。
- preview と typecheck の緑だけで export/bundle/cache/timeline 経路を検証しない。
- 新型 export だけ verify し、共有 capture パイプライン変更後の既存 export（solid/text/image・blend・調整等）回帰を見ない。
- 共有 `rasterCapture` / `exporter` を全レイヤー一律変更する（型別フラグで閉じない）。
- `c.type ===` の全ディスパッチ点を grep せず、気づいた箇所だけ直す。

## worked example（camera bundle-bake 誤判定）
症状: built-in live エフェクト(blur/fastTurbulent)＋カメラのみのコンプを Static HTML 書き出しすると
「plugin / bake レイヤ 1 件」が出てカメラ層を動画化しようとした。
1. ダイアログ文言は `findBakeTargets`（[ExportDialog.tsx](../../../src/editor/ExportDialog.tsx)）由来と特定。
2. `findBakeTargets`→`componentNeedsBake`（[bundleCollect.ts](../../../src/runtime/bundleCollect.ts)）を読むと、
   `BUILTIN_COMPONENT_TYPES` に **camera が無い** → プラグイン分岐 → `bundleExportDefault` 未指定で true。
3. 修正 = set に `"camera"` 追加（非描画なので絶対 bake しない）。effects は元々対象外と確認。
4. 回帰: `test/bundleExport.test.ts` に camera 非 bake / camera+調整(blur/fastTurbulent)=bakeTargets 0。
   実機 `verify-export-bake.mjs` で bakeTargetCount=0・error 0。357 tests/typecheck/build 緑。

## ハーネス注意（Mafter Effect）
- 実機検証は Playwright。実ストアは `window.__mafterEditorStore`（dev 公開）経由
  （`import()` は別 Zustand インスタンスになりやすい）。空 IDB 起動後は
  `project && currentCompId` を待つ。詳細は
  [debug-visual-render-bug](../debug-visual-render-bug/SKILL.md) のハーネス節。
- bake/bundle 判定は純関数（`componentNeedsBake`/`findBakeTargets`/`collectBundleDependencies`）なので
  **ユニットで安く固定でき、実機は配線全体の確認**に使う。両方やる。
