# Progress

> AIエージェントはセッション開始時にこのファイルを読み、終了時に更新すること。

---

## 現在のマイルストーン状態

| マイルストーン | 状態 |
|---|---|
| M0 Foundations | ✅ 完了 |
| M1 Core animation + DomRenderer | ✅ 完了 |
| M2 HTML comp + expression | ✅ 完了 |
| M3 Export | 未着手 |
| M4 Plugin API v1 | 未着手 |

---

## 完了済みタスク

### M0 Foundations（2026-06-15 完了）

- **スキャフォールド**: Vite + React 18 + TypeScript(strict, `noUncheckedIndexedAccess` 等) セットアップ。`npm run dev` でブラウザ起動可。
- **§5 データスキーマ型** — [src/core/schema.ts](src/core/schema.ts)。`Project` / `Composition` / `SceneObject` / `Transform` / `AnimatedProp` / `Easing` 等を仕様どおり定義。
- **正準シリアライズ** — [src/core/serialize.ts](src/core/serialize.ts)。キー再帰アルファベット順 + `objects`/`assets`/`compositions`/`pluginRefs` を id 昇順 + 2-space indent + 末尾改行。`canonicalizeProject` / `canonicalStringify` / `serializeProject` / `deserializeProject`。
- **FileSystem 抽象（§11.1）** — [src/fs/FileSystem.ts](src/fs/FileSystem.ts) + [MemoryFs](src/fs/MemoryFs.ts)（テスト用）+ [IndexedDbFs](src/fs/IndexedDbFs.ts)（ブラウザ, raw IndexedDB, prefix-query list）。フラット key-value、ディレクトリはファイル存在で暗黙表現。
- **zip export/import** — [src/fs/zip.ts](src/fs/zip.ts)。JSZip、固定日時で決定論バイト列、path 昇順。
- **プロジェクト作成/読込** — [createProject](src/core/createProject.ts) / [projectFs](src/core/projectFs.ts)（save/load）。
- **load 時検証 + マイグレーション（§5.4-note / §5.6）** — [src/core/validate.ts](src/core/validate.ts)。不正 parent → root化+warn、循環 → ProjectError、新しい schemaVersion → 読込拒否。
- **最小 UI** — [src/App.tsx](src/App.tsx)。New/Save/Reload/Export zip/Import zip + canonical JSON 表示 + ログ。
- **テスト（14 件全通過）** — [test/](test/)。INV-4 byte 等価（MemoryFs / IndexedDbFs）、zip 決定論、FS レイアウト一致、正準化の冪等性、validate の各分岐。

**検証済み**: `npm run typecheck` ✅ / `npm test`（14 passed）✅ / `npm run build` ✅ / `npm run dev`（5173 で serve・TSX transform 確認）✅。

**M0 受け入れ条件**: 作成→保存→再読込→zip→再import が project.json 正準シリアライズ後 byte 等価 → roundtrip.test.ts で担保。`git init` 済みリポジトリ・`.gitignore` 追加（node_modules/dist 除外）。

### M0 リファイン（spec v0.3 同期 + フィードバック対応, 2026-06-16）

spec が **v0.2 → v0.3** に更新（`dc3153e`）。M0 への影響を反映:
- **§5.6-canon 正準シリアライズ正式化（RFC 8785/JCS 基礎）**: 実装はほぼ準拠済みだったが **Unicode NFC 正規化を追加**（[serialize.ts](src/core/serialize.ts) `emitString` + キー正規化）。`JSON.stringify` が非ASCIIを生UTF-8出力・`-0`→`"0"`・キーUTF-16 code unit順は既に準拠を確認。
- **`Component.exportStrategy?: "live" | "bake"`** を schema に追加（§11.7 web bundle 用, optional/additive）。

フィードバック指摘の **未踏 3 経路を全て緑化**（[test/canonical-edge.test.ts](test/canonical-edge.test.ts), 8 件追加）:
1. **日本語名 round-trip**: save→reload byte 等価（Memory/IndexedDb）+ 出力が生日本語（`\uXXXX` でない）。
2. **zip round-trip**: 日本語プロジェクトで Export→Import→byte 等価。
3. **float round-trip**: `123.5`/`-0.25`/`1.5`(fractional zOrder) が ES 最短表現で round-trip、`-0`→`0`。
+ **NFC**: 合成/分解（U+30AC vs U+30AB+U+3099）が同一バイトへ正規化。

2 観察への決定:
- **optional 方針 1 本化**: 「値が存在するものは書く / 機能不在はキー省略（null 書かない）」。`background`=authored 値で明示、`activeCamera`=不在で省略。[createProject.ts](src/core/createProject.ts) にポリシー明記。
- **updatedAt churn**: `saveProject` は **自動 bump しない**（project を一切変更しない）。updatedAt は M1 の command 層で「実内容変更時のみ」更新。[projectFs.ts](src/core/projectFs.ts) に明記。

**テスト: 22 件全通過**（typecheck ✅ / build ✅）。M0 完全クローズ。

---

### M1 凍結ゲート + 決定論コア（2026-06-16 完了）

spec v0.3 の M1 凍結ゲート（コア型/境界を Opus で1周）を実施し、node でテスト可能な純粋核を実装。

- **`@mafter/runtime` 境界を切った（INV-7）** — [src/runtime/](src/runtime/)。契約は [src/runtime/README.md](src/runtime/README.md)。エディタ依存（React/Zustand/UI）を一切 import しない。外部依存は `../core/schema` の **型のみ**（grep 検証済み）。3 者（preview / exporter / bundle player）が共有する核。
- **コア型を凍結** — `Mat4`（column-major, [mat4.ts](src/runtime/mat4.ts)）/ `ResolvedScene`・`ResolvedObject`・`ResolvedComponent`（[resolved.ts](src/runtime/resolved.ts)）/ `Renderer` interface（[renderer.ts](src/runtime/renderer.ts)）。
- **mat4** — column-major（CSS matrix3d 同レイアウト）。`localMatrix` = §6.3 `T(pos)·R·S·T(-anchor)`、euler Z·Y·X。`invert`（camera view 用）。
- **easing** — [easing.ts](src/runtime/easing.ts)。cubic-bezier ソルバ（Newton+二分法）、linear/hold/bezier/preset(linear fallback, §10 後続)。
- **interpolate** — [interpolate.ts](src/runtime/interpolate.ts)。§6.4 成分線形補間 + 端 clamp、hold ステップ、`sampleScalar/sampleVec3/sampleAny`。expression は M2（未評価）。
- **resolve()** — [resolve.ts](src/runtime/resolve.ts)。純関数（INV-1）。parent チェーンを畳んで world 行列を焼く、可視性(enabled/inPoint/outPoint)、zOrder 昇順、per-object opacity（非継承）、active camera viewMatrix=inverse(world)。
- **§19 パネル** — [src/editor/layout.ts](src/editor/layout.ts)。`LayoutNode`（split/tabs/panel）直列化型 + 既定レイアウト（左 project / 中 preview+timeline / 右 inspector）。**project.json に入れない**（§19.3, WorkspaceState 別ストア）。

**テスト: 55 件全通過**（mat4 8 / easing 7 / interpolate 9 / resolve 9 + 既存 22）。typecheck ✅。§6.3 合成順・INV-1 決定論・端 clamp を検証。

### M1 DOM/UI 層（2026-06-16 完了）

- **DomRenderer** — [src/runtime/DomRenderer.ts](src/runtime/DomRenderer.ts)。各 ResolvedObject を root の兄弟 div として `matrix3d(worldTransform)` + `opacity` + `z-index`、root に `transform-style:preserve-3d`、`transform-origin:0 0`。solid/text/image 描画 hook。§6.5 camera が設定されている場合は `perspective` + view matrix を root に適用。
- **Zustand ストア** — [src/editor/store.ts](src/editor/store.ts)。project/frame/selection/undoStack を保持。正は IndexedDbFs（`applyCommand` が自動保存）。
- **Command/Undo/Redo** — [src/editor/commands.ts](src/editor/commands.ts)。MVP は before/after スナップショット方式（JSON patch 最適化は将来）。Cmd-Z / Shift-Cmd-Z で往復。セッション内スタック。
- **パネル UI** — [WorkspaceLayout.tsx](src/editor/WorkspaceLayout.tsx)。`LayoutNode` ツリーを再帰描画。`SplitPane` がドラッグ resize（mousemove ベース）。レイアウト状態は `localStorage` に永続化 — **project.json を一切汚さない**（§19.3）。
- **PreviewPanel** — DomRenderer をマウント、rAF ベース再生クロック（msPerFrame ごとに frame 進行）、Space キーで play/pause。
- **TimelinePanel** — フレームスクラバー（range input）、オブジェクト行 + in/out バー + KF インジケータ、選択オブジェクトへ position/opacity キーフレーム追加。
- **InspectorPanel** — position/anchor/rotation/scale/opacity を現 frame で表示・編集、setKeyframe で KF 追加、easing プリセット適用（linear/ease-in-out/ease-in/ease-out/snappy/hold）。
- **ProjectPanel** — プロジェクト操作（New/Save/Reload/zip DL・Import）、Solid/Text オブジェクト追加、オブジェクト削除。

**M1 受け入れ条件チェック**:
| 条件 | 状況 |
|---|---|
| solid/text/image を配置 | ✅ ProjectPanel + addSolid/addText |
| position/opacity を bezier easing で keyframe | ✅ Inspector easing プリセット5種 + Timeline KF 追加 |
| スクラブ＆実時間再生 | ✅ Timeline range + rAF playback clock |
| §6.3 world 行列と一致 | ✅ resolve.test.ts 9件で検証済み |
| CSS-3D の z | ✅ DomRenderer preserve-3d + z-index |
| Cmd-Z/Shift-Cmd-Z で往復 | ✅ commands.ts + App.tsx keyboard handler |
| パネルをスプリッタで resize | ✅ SplitPane mousedrag |
| レイアウトが project.json を汚さない | ✅ localStorage 保存、FS/serializeProject と完全分離 |

**テスト: 55 件全通過** / typecheck ✅ / build ✅ / dev server ✅

### M1→M2 Opus 検証・リファクタ（2026-06-16）

M2 着工前に、M1 で挙げた 3 懸念点を実コードで解消（凍結ゲートの確定）。

1. **background の INV-3 違反を除去** — PreviewPanel が `scene as unknown as Record` で background を注入していたハックを撤去。`DomRenderer.mount(container, comp: CompositionMeta)` が **既存シグネチャどおり** comp.background を受け取り適用する形に修正。`ResolvedScene` は汚さない（INV-3 保持）。
2. **expression 評価シームを `resolve()` に凍結（§9 / M2 境界）** — `resolve(comp, frame, ctx?: ResolveContext)` に optional 第3引数を追加（additive・後方互換）。`ExpressionEvaluator` を注入する設計で **resolve は同期・純粋のまま**、JS module の非同期ロード（§11.3）は外で事前実施。expression は keyframe/static を上書き（§5.2）、throw/未提供時は **ctx.value にフォールバック**（§9）。テスト5件で override / fallback / 引数 / INV-1 純粋性を検証。
3. **Undo/Redo 方式を確定（snapshot 継続）** — 全編集が immutable（structural sharing）であれば全コピーは実質 patch 相当のメモリ効率、という根拠で MVP は snapshot 維持。「**全編集 immutable**」を load-bearing 不変条件として [commands.ts](src/editor/commands.ts) に明記。明示 JSON patch 移行は M3 後に再評価（HTML comp/expression は FS ファイルで project.json に載らないため M2 後も小さい）。テスト4件で undo/redo/future-clear/immutability を検証。

付随リファクタ（preview 品質）:
- **DomRenderer 子要素を reconcile 化** — フレーム毎の `innerHTML` 全消去をやめ、component 型シグネチャ変化時のみ再生成・それ以外は props を in-place 更新。`<img>` の src は変化時のみ設定 → 再読込 flicker を排除。`shape` 描画も追加。
- **PreviewPanel に scale-to-fit** — 固定 px の comp ステージが領域を溢れていた問題を、ResizeObserver で `transform: scale()` して収める形に修正。

**テスト: 64 件全通過**（+9: undo 4 / resolve expression seam 5）。typecheck ✅ / build ✅。runtime 境界 grep 再検証 ✅。

---

### M2 HTML comp + expression（2026-06-16 完了）

- **§9 Expression エンジン**:
  - [exprHelpers.ts](src/runtime/exprHelpers.ts): `seededRandom`（mulberry32）、`wiggleNumber/wiggleVec3`（smoothstep 補間, per-axis 独立シード）、`linearRemap`/`easeRemap`/`clamp` — 全て純関数（INV-1）。
  - [moduleLoader.ts](src/runtime/moduleLoader.ts): `ModuleLoader`（FS→Blob→`URL.createObjectURL`→dynamic import→`revokeObjectURL`→キャッシュ）、`MockModuleLoader`（テスト用）。
  - [expressionEngine.ts](src/runtime/expressionEngine.ts): `ExpressionEngine`（`prepare(comp)` で非同期 preload → `makeEvaluator(comp)` で sync `ExpressionEvaluator` を返す）。`ExprContext<T>` に frame/time/fps/value/thisObject/comp + 全ヘルパー。`thisObject.toWorld/toComp` は parent チェーン走査（non-expression サンプルで再帰回避）。throw → fallback（§9）。

- **§7 HTML Composition (Model A)**:
  - [htmlComp.ts](src/runtime/htmlComp.ts): `CompositionModule`/`CompRenderContext` interface（§7 仕様準拠）。`HtmlCompPlayer`（Shadow DOM ライフサイクル管理: `prepare→mountObject→renderObject→unmountObject→dispose`）。inPoint 相対 frame（§7「内部時間」）。throw → silent（レンダリング止めない）。

- **DomRenderer に `html` コンポーネントサポートを追加**:
  - `setHtmlPlayer/setHtmlComps` で HtmlCompPlayer を注入。
  - `html` component 型のオブジェクトに Shadow DOM マウント + frame ごと `renderObject` 呼び出し。

- **エディタ統合**:
  - [PreviewPanel.tsx](src/editor/panels/PreviewPanel.tsx): `ExpressionEngine` + `HtmlCompPlayer` をモジュールレベルで作成（per-preview singleton）。comp 変更時に `engine.prepare()` を非同期実行。render 時に `evaluatorRef.current` を `resolve()` に注入。初回フレームは evaluator なし → keyframe/static フォールバック。
  - [store.ts](src/editor/store.ts): `addHtmlComp()` を追加。FS にスターターファイル（index.html/style.css/script.js）を書き込み + project.json に `HtmlComposition` を追加。
  - [ProjectPanel.tsx](src/editor/panels/ProjectPanel.tsx): `+ HTML Comp` ボタン + HTML comp 一覧表示。

- **テスト: 84 件全通過**（+20: expr.test.ts 新規）:
  - seededRandom: 同シード同列、値域[0,1)
  - wiggle: 決定論、異フレーム差異、zero freq/amp、Vec3 per-axis 独立、振幅上限
  - 純粋ヘルパー: linearRemap/easeRemap/clamp/lerp
  - ExpressionEngine: MockModuleLoader でモジュール評価・not found→fallback・throw→fallback・ExprContext フィールド・wiggle 決定論・thisObject.position

**M2 受け入れ条件チェック**:
| 条件 | 状況 |
|---|---|
| params keyframe アニメート | ✅ M1 から継続（component props = AnimatedProp） |
| expression がプロパティを上書き | ✅ ExpressionEngine.makeEvaluator → resolve(ctx) |
| reload 決定論 | ✅ seededRandom / pure evaluator → INV-1 |
| wiggle 再現可能 | ✅ wiggleNumber/Vec3 mulberry32 + smoothstep |
| HTML comp 追加・FS スターター生成 | ✅ addHtmlComp() |
| Shadow DOM 隔離（§7） | ✅ HtmlCompPlayer.mountObject |

typecheck ✅ / tests 84 passed ✅ / build ✅

---

## 進行中・未完了タスク

_なし（M2 完了。M3 着工可）_

---

## 既知のバグ・課題

- `npm install` 時に transitive deps の脆弱性警告（moderate×3 / high×1 / critical×1）。dev/build ツールチェーン由来で実行時には影響しないが、M1 着手前に `npm audit` で精査推奨。
- IndexedDbFs.list は全 key 取得 → prefix フィルタ（MVP の素直な実装）。アセット数増加時は IDBKeyRange 範囲クエリへ最適化（§11.1 注記どおり将来）。

---

## Next steps（次のセッションでやること）

### M3 Export に着手

M3 受け入れ条件（§15）: **5 秒尺を webm/mp4/PNG 連番に書き出せる**。

実装項目:
- **決定論 frame ステップ**: `for frame in range(start, end)` で DomRenderer を駆動（rAF 不使用）
- **DOM → raster**: SVG `<foreignObject>` シリアライズ → `<img>` → canvas → `drawImage`、または `html2canvas` 相当
- **WebCodecs VideoEncoder**: webm/mp4 書き出し（first choice）。フォールバック: PNG 連番 + ffmpeg.wasm
- **PNG 連番**: `canvas.toBlob("image/png")` → zip で配布
- **音声 mux（§11.2）**: export 後に audio アセットを ffmpeg.wasm で mux

M3 前 spike 推奨（spec §15 M2 de-risk 参照）:
> **素の HTML 1 枚に @mafter/runtime を置き、エディタ無しで comp が動く** proof-of-concept。
> → `ExpressionEngine.makeEvaluator` + `DomRenderer` を bare HTML で動かして M5（Web Bundle）の footprint を確認。

> ⚠️ M3 に入る前に Opus による凍結ゲートを推奨（ExportConfig 型の確定 / WebCodecs の決定論クラス）。

### 参考: M1 で先に切った境界（spec v0.3 新規、記録用）
- **INV-7 `@mafter/runtime` 単一核**: `resolve` / Renderer / module loader(§11.3) / expression engine(§9) / 再生クロック を **エディタ(React/状態/UI)から独立したライブラリ**に括り出す。preview / video exporter / web bundle player の 3 者が同核共有。後から剥がすと高コスト → M1 で境界だけ設計（§8 補足 / §11.7）。
- **INV-8**: web bundle player は実時間・別の決定論クラス（フレーム精度非保証, マスタークロック=音声）。MP4/headless 経路とは別保証として扱う。
- **§19 パネルシステム**: `LayoutNode` 直列化ツリー（split/tabs/panel）+ パネルレジストリ。MVP は固定レイアウト + スプリッタ resize のみ。**レイアウト状態は project.json に入れない**（§19.3, ユーザ設定ストアへ）。ドッキングは将来 dockview 等を評価。

### M1 Core animation + DomRenderer 実装
- `resolve(comp, frame): ResolvedScene`（純関数, INV-1）— parent チェーンを畳んで world `Mat4` を焼く（§6.3 合成順 `T·R·S·T(-anchor)`、euler Z·Y·X）。
- Mat4 ユーティリティ（column-major）+ 補間（線形 + cubic-bezier easing, §6.4）。
- `DomRenderer`（フラット matrix3d + opacity + z-index, preserve-3d, §8）。
- solid/text/image component の描画 hook。
- preview 再生（決定論 frame ステップ）+ Inspector + Undo/Redo（command + 逆 patch, §17）。
- テスト優先: world 行列が §6.3 と一致、INV-2（preview≡export 値）。

### 参考: M5 Web Bundle Export（MVP 後・§11.7）
- `@mafter/runtime` ベース player + Single-file / Folder bundle + `exportStrategy:'bake'` レイヤの部分 MP4/WebP 化。境界は M1 で先取り済みにする。

---

## 更新履歴

| 日時 | 内容 |
|---|---|
| 2026-06-15 | progress.md 初期化 |
| 2026-06-15 | M0 Foundations 完了（schema / 正準シリアライズ / FS / zip / 作成読込 / 検証 / UI / テスト14件） |
| 2026-06-16 | spec v0.3 同期（NFC正規化 / exportStrategy）+ M0 リファイン（日本語/zip/float 経路緑化, optional・updatedAt 方針確定）テスト22件。M1 凍結ゲート記録 |
| 2026-06-16 | M1 凍結ゲート + 決定論コア完了（@mafter/runtime 境界 / Mat4 / easing / interpolate / resolve / §19 LayoutNode）テスト55件。残: DomRenderer・preview・store・Undo/Redo・Inspector・パネルUI |
| 2026-06-16 | M1 DOM/UI 層完了（DomRenderer / store / commands / WorkspaceLayout / Preview / Timeline / Inspector / Project panels）typecheck ✅ / tests 55件 ✅ / build ✅ |
| 2026-06-16 | M1→M2 Opus 検証・リファクタ（background INV-3 除去 / expression シーム凍結 / undo snapshot 確定 / DomRenderer reconcile / scale-to-fit）tests 64件 ✅ |
| 2026-06-16 | M2 HTML comp + expression 完了（exprHelpers / moduleLoader / ExpressionEngine / HtmlCompPlayer / DomRenderer html 型 / エディタ統合）tests 84件 ✅ |
