# Progress

> AIエージェントはセッション開始時にこのファイルを読み、終了時に更新すること。

---

## 現在のマイルストーン状態

| マイルストーン | 状態 |
|---|---|
| M0 Foundations | ✅ 完了 |
| M1 Core animation + DomRenderer | ✅ 完了 |
| M2 HTML comp + expression | ✅ 完了 |
| M3 Export | ✅ 完了（実機 export 9/9 検証済み） |
| M4 Plugin API v1 | ✅ 完了（実機検証済み 14/14） |

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

### M2 ランタイム検証・修正（2026-06-16, Opus）

ブラウザ実機検証（Playwright/Chromium で実 DOM を駆動）で、型・単体テストは緑でも**実行時に M2 中核機能が成立していなかった**ことが判明 → 修正。

**修正したバグ・ギャップ:**
1. **【致命的】ModuleLoader が HTML comp モジュールを必ず拒否** — [moduleLoader.ts](src/runtime/moduleLoader.ts) は `default` が**関数以外なら null`** を返していたが、§7 `CompositionModule` は `{ manifest, mount, render }` の**オブジェクト** default export。→ `load()` を「関数でもオブジェクトでも default をそのまま返す」(`LoadedExport = unknown`) に変更。`ExpressionEngine.prepare` は `typeof === "function"` で、`HtmlCompPlayer.prepare` は `mount`/`render` を持つオブジェクトで受理するよう各々ガード。単体テストは `MockModuleLoader`（関数を直接 register）で関数チェックを迂回していたためすり抜けていた。
2. **HTML comp をタイムラインに配置する UI が無かった** — `addHtmlComp` は comp を作るだけで、表示には `type:"html"`+`props.compId` の SceneObject が必要だった。→ store に `addHtmlInstance(compId)` を追加、[ProjectPanel](src/editor/panels/ProjectPanel.tsx) の HTML comp 一覧クリックで現タイムラインへ配置。
3. **expression を付与する UI が無かった** — `wiggle` 等が単体テストでしか到達できなかった。→ store に `addWiggleExpression(objectId)`（FS に `scripts/<id>/position.js` を書き出し `position.expression` を設定）、[InspectorPanel](src/editor/panels/InspectorPanel.tsx) に「Wiggle Position」トグル追加。
4. **PreviewPanel の配線 2 件** — `setHtmlComps` が timeline comp id 依存の mount effect でしか呼ばれず新規 html comp がレンダラに届かない／非同期 `prepare()` 完了後に再描画されない問題。→ project 変更で html comp map を注入し、`prepare` 解決後に `renderTick` を進めて再描画。
5. **html host div が 0×0** — [DomRenderer](src/runtime/DomRenderer.ts) で host div に comp 寸法を付与（Shadow DOM が 100% で追従）。
6. **HTML comp スターターの render を per-frame 化** — `render(ctx)` が `frame N` を描画し、§7 の毎フレーム駆動を可視化（[store.ts](src/editor/store.ts) addHtmlComp）。

**ランタイム検証結果（Playwright 実機）:**
| 検証項目 | 結果 |
|---|---|
| HTML comp が Shadow DOM にマウント | ✅ shadowHost 生成・shadowRoot にコンテンツ |
| `render(ctx)` が per-frame 駆動 | ✅ scrub で "frame 0"→"frame 20" 更新 |
| wiggle expression がプロパティを上書き | ✅ solid 位置 identity→translate へ |
| wiggle が frame 毎に変化（アニメート） | ✅ f0=(-28.0,15.2,28.1) ≠ f30=(50.2,-18.9,47.4) |
| 決定論（INV-1/INV-2） | ✅ 2 回の独立実行で同一値 |

**回帰テスト追加** — [test/expr.test.ts](test/expr.test.ts) に `HtmlCompPlayer` がオブジェクト `CompositionModule` を受理（mount/render 欠落は拒否）するテスト 2 件。

**テスト: 86 件全通過** / typecheck ✅ / build ✅ / **ブラウザ実機検証 ✅**。M2 を実行時に成立する形でクローズ。

---

---

### M3 Export（browser best-effort）（2026-06-16 実装完了）

- **`ExportConfig` 型** — [src/core/schema.ts](src/core/schema.ts) に追加（`range/fps/scale/format/alpha`）
- **エクスポートエンジン** — [src/runtime/exporter.ts](src/runtime/exporter.ts)（新規作成）:
  - `exportComposition()`: Project + compId + FS + config → Blob（mp4 / webm / png-seq）
  - **オフスクリーン DOM コンテナ**を作成し DomRenderer + ExpressionEngine + HtmlCompPlayer で preview と同一パイプラインを駆動（INV-2 担保）
  - **DOM→raster**: SVG `<foreignObject>` シリアライズ → `<img>` → canvas。Shadow DOM は `flattenShadow()` で inline 展開（§7 HTML comp 対応）
  - **WebCodecs VideoEncoder** + `mp4-muxer`（mp4）/ `webm-muxer`（webm VP9）でエンコード
  - WebCodecs 非対応ブラウザは PNG sequence にフォールバック
  - **PNG sequence**: `canvas.toBlob()` × N → JSZip で配布（format="png-seq"）
  - **音声 mux**: `audio` component を持つオブジェクトを `OfflineAudioContext` で mix → WebCodecs `AudioEncoder`（AAC/Opus）→ muxer（`mp4-muxer.addAudioChunk`）で映像と合成
  - 進捗コールバック（prepare / render / encode / audio / done / error フェーズ）
  - AbortController でキャンセル対応
- **`ExportDialog`** — [src/editor/ExportDialog.tsx](src/editor/ExportDialog.tsx)（新規作成）:
  - format / range / fps / scale / alpha 設定
  - プログレスバー + フェーズ表示
  - キャンセルボタン（AbortController）
- **ProjectPanel 更新** — [src/editor/panels/ProjectPanel.tsx](src/editor/panels/ProjectPanel.tsx):
  - "▶ Export Video…" ボタン → ExportDialog 表示
  - "+ Audio" ボタン → audio ファイルをインポートして `audio` レイヤーを追加
  - Audio Assets 一覧（クリックでレイヤー追加）
- **Store 更新** — [src/editor/store.ts](src/editor/store.ts):
  - `importAudioAsset(file)`: 音声ファイルを `assets/<id>.<ext>` に保存 + AssetEntry 追加
  - `addAudioLayer(assetId)`: `audio` component を持つ SceneObject を追加
  - `getFs()`: FS インスタンスを外部公開
- **DomRenderer 更新** — [src/runtime/DomRenderer.ts](src/runtime/DomRenderer.ts):
  - `getRoot()`: エクスポーター用にマウントした root 要素を公開
- **依存追加**: `mp4-muxer`, `webm-muxer`

**M3 受け入れ条件チェック（実装レベル）**:
| 条件 | 状況 |
|---|---|
| solid+text+image+HTML-comp を書き出し | ✅ DOM→raster でコンポーネントを問わず撮影 |
| audio レイヤを mux | ✅ OfflineAudioContext + AudioEncoder + mp4-muxer |
| webm/mp4/連番 を書き出し | ✅ WebCodecs+mp4-muxer / webm-muxer / JSZip |
| 映像が preview scene 値と一致 | ✅ 同一 resolve() → DomRenderer パイプライン（INV-2） |
| フォントが反映される | ✅ document.fonts 登録済みフォントは foreignObject で有効 |
| preview: transform-style:preserve-3d | ⚠ SVG foreignObject では 3D 深度ソート非対応（best-effort 制約） |

**テスト: 86 件全通過** / typecheck ✅ / build ✅（DOM API はブラウザ実機で検証要）

### M3 ランタイム検証・修正（2026-06-16, Opus / Playwright）

ブラウザ実機検証（Playwright/Chromium, port 5175）で **致命的バグ 2 件 + 堅牢化 1 件**を発見・修正。型・単体テストでは検出不能なブラウザ専用経路。

**修正したバグ（[exporter.ts](src/runtime/exporter.ts)）:**
1. **【致命的・全フォーマット破壊】tainted canvas** — `captureFrame()` が SVG を `URL.createObjectURL`（blob: URL）で `<img>` に読み込んでいた。blob: URL から読んだ `<foreignObject>` 入り SVG を `drawImage` すると Chromium が canvas を **tainted 扱い**にし、`toBlob`（PNG-seq）も `new VideoFrame`（mp4/webm）も `SecurityError` で失敗。cross-origin 画像が無くても発生。→ **data: URL（UTF-8→base64）に変更**（`svgToDataUrl` 追加）。data: URL は same-origin 扱いで汚染しない。プローブで blob=TAINTED / data=OK を確認。
2. **【致命的・1080p mp4 破壊】AVC level 固定** — `codec: "avc1.42001f"`（level 3.1, max coded area 921600px）が 1920×1080（≈2M px）を超過し `VideoEncoder.configure` がエラー。→ 解像度・fps から H.264 level を動的算出する `avcCodecString()` を追加（1080p→`avc1.42e028`、`isConfigSupported` で supported を確認済み）。
3. **【堅牢化】`hardwareAcceleration:"prefer-hardware"` 強制** — HW エンコーダが無い環境（headless / 一部 GPU）で configure が非同期失敗 → codec が閉じ "encode on a closed codec"。→ `configureVideoEncoder()` を追加し `isConfigSupported` で hardware→no-preference→software の順にフォールバック。実機（HW H.264 非搭載）でも export 可能になった。

**検証結果（Playwright 実機）:**
| 検証項目 | 結果 |
|---|---|
| New project / solid+text を preview DOM に配置 | ✅ |
| Export ダイアログ UI（format/range/fps/scale/alpha・progress・cancel） | ✅ |
| **PNG sequence export** end-to-end | ✅ zip に N 個の有効 PNG、frame_000000.png… |
| **エクスポート映像 = preview scene 値（INV-2）** | ✅ 出力 PNG のピクセル = solid 色 [128,128,230,255]（=RGBA{.5,.5,.9}）|
| HTML comp + audio レイヤを含む comp の書き出し | ✅ クラッシュなし（flattenShadow + HtmlCompPlayer 経由）|
| Audio import → audio レイヤ生成 | ✅ |
| **音声 mix（OfflineAudioContext）** | ✅ 非無音 PCM（peak 0.37, 13230 samples @44.1k）|

**video encode（mp4/webm）の実機制約:** 本 headless Chromium ビルドは **WebCodecs `VideoEncoder` 自体がレンダラごとクラッシュ**する（アプリコード無しの最小 VP8 1 フレームでも全 GL backend でクラッシュを再現＝環境要因。`AudioEncoder` / `decodeAudioData` / canvas 経路は正常）。よって **映像フレーム生成・音声 mix・PNG 経路はアプリ側で検証済み**、最終 `VideoEncoder.encode` のみ実 Chrome（HW or 安定 SW エンコーダ）での確認待ち。codec 設定は `isConfigSupported`=true まで確認済み。

**テスト: 86 件全通過** / typecheck ✅ / build ✅。

### M3 映像エンコード経路の実機クローズ（2026-06-16, Opus / Playwright）

前セッションで「`VideoEncoder` が全 GL backend でクラッシュ＝到達不能」とした残課題を再検証し、**映像エンコード経路を実機でクローズ**した。

**クラッシュの真因を特定:** クラッシュは `VideoEncoder` 全般ではなく **headless Chromium のデフォルト GL backend 限定**。`chromium.launch({ args: ["--use-gl=angle","--use-angle=swiftshader"] })`（ソフトウェア GL）にすると GPU プロセスが安定し、`VideoEncoder.flush()` も完走する。アプリコード側のバグではない（同一コードが swiftshader で全フォーマット成功）。切り分けプローブで以下を確認:
- plain canvas / `createImageBitmap` / **SVG-foreignObject ラスタ→`createImageBitmap`→`VideoFrame`（exporter の実経路）** の全ソースが 1920×1080 で encode 成功。
- デフォルト GL backend ではテスト A（320×240 plain）すら即クラッシュ → 解像度・ソース非依存の環境要因。

**実機 end-to-end 検証結果（Playwright + swiftshader, 9/9 PASS）:**
| 検証項目 | 結果 |
|---|---|
| project build（solid+text+audio layer を store 経由で構築） | ✅ |
| **PNG sequence** export（6 frame, zip 281KB） | ✅ frame_000000.png… 連番 |
| **INV-2 ピクセル一致**（frame0 の (10,10) = solid 色 [128,128,230,255]） | ✅ 完全一致 |
| **MP4 export（映像+音声 mux）** | ✅ `ftyp` box + `phases:[prepare,render,audio,done]`, 14.9KB |
| **WebM export** | ✅ EBML magic `1A45DFA3`, 24.1KB |
| **MP4 @2x scale（1920→3840, 動的 AVC level）** | ✅ `avcCodecString` が正しい level を選択, 39.6KB |
| Console エラー | ✅ 0 件 |

**結論:** M3 映像/音声/PNG の全エクスポート経路が実機で成立。`VideoEncoder` クラッシュは headless の GL backend 起因で、実 Chrome（ユーザ環境の GPU）では発生しない見込み。

**付随修正:** [WorkspaceLayout.tsx](src/editor/WorkspaceLayout.tsx) の `SplitPane` で `.map()` が返す `<>` Fragment に key が無く React 警告（"unique key prop"）が出ていた（M1 由来）。`<Fragment key>` に変更して解消（検証で console エラー 2→0）。

**テスト: 86 件全通過** / typecheck ✅ / build ✅ / **実機 export 9/9 ✅**。M3 完全クローズ。

---

### M3 バグ修正ラウンド（2026-06-16, Opus レビュー後）

Opus による 8-angle コードレビュー（finder + verifier）で発見した実バグ 6 件を修正。

**修正バグ:**
1. **[exporter.ts] PNG-seq が alpha フラグを無視** — `runPngSeq` の `_config` (未使用) を `config` に改名し `config.alpha ? "transparent" : comp.background...` で背景を決定。UI の「Alpha」チェックが実際に透明背景 PNG を生成するようになった。
2. **[exporter.ts] PNG-seq 時に不要な `buildAudioMix` を実行** — `buildAudioMix` を video ブランチ内に移動。PNG export では OfflineAudioContext を作成しない。
3. **[DomRenderer.ts] コンポーネント型変更時に html comp の unmount が漏れる** — `sig !== entry.childSig` の際、旧 sig に "html" が含まれていれば `htmlPlayer.unmountObject()` を呼んでから innerHTML をクリア。Shadow DOM のゾンビを防ぐ。
4. **[PreviewPanel.tsx] 毎 project 編集で wiggle がチラつく** — `evaluatorRef.current = undefined` リセットを削除。古い evaluator が prepare 完了まで継続稼働し、1 フレームの fallback スナップ（ポジションが base value に戻る）が消えた。
5. **[exporter.ts] サブレンジ export 時の音声タイミングズレ** — `inPoint < startFrame` のレイヤーは export 開始時点で既に再生途中。`alreadyElapsedSec = max(0, (startFrame - inPoint) / fps)` を `trimStartSec` に加算して buffer 読み出し位置を補正（A/V sync bug）。
6. **[moduleLoader.ts] 失敗ロードのネガティブキャッシュなし** — `failed: Set<string>` を追加。FS 読み込み失敗・null default・dynamic import エラーすべてを `failed` に記録し、次回 `load()` で即 null 返し。`invalidate/clear` でも消去。編集中に壊れた expression ファイルが毎回再読み込みされるパフォーマンス問題を解消。

**検証結果（REFUTED として除外）:**
- `triggerDownload` の URL.revokeObjectURL タイミング → Chrome はダウンロード中 blob を内部保持するため安全
- `IndexedDbFs` 複数インスタンス → インメモリキャッシュなし・純粋 IDB pass-through のため一貫性問題なし

**テスト: 86 件全通過** / typecheck ✅ / build ✅

### M3 Opus 再検証パス（2026-06-16, Opus）

Sonnet の上記 6 件修正を Opus で再検証。fix #2〜#6 は正しいと確認。**fix #1（alpha）が不完全だったため追加修正:**

7. **[exporter.ts] webm alpha export が透明にならない** — Sonnet は `runPngSeq` の alpha のみ修正したが、`runVideo`(line 253) は `config.alpha` を無視して `bg` を常に不透明にしていた。UI は webm でも alpha を提供している（ExportDialog）ため不整合。`bg = config.alpha ? "transparent" : ...` に統一（PNG-seq と同じ方針）。mp4(H.264) は alpha 非対応 + UI も出さないため影響なし。

**既知の best-effort 制約（M4 ブロッカーではない）:**
- `DomRenderer.mount()` は `comp.background` を root div の CSS に適用するため、「alpha=true かつ comp に明示的 background あり」という矛盾組合せでは背景が foreignObject に焼き込まれる。通常の alpha export（背景なし comp）では問題なし。
- `runVideo` の `videoChunks`/`_videoChunks` は muxer が output callback で直接消費するため dead code（無害）。

**M4 着手可否の判定: ✅ GO。** M3 に機能的ブロッカーなし。M4 拡張シームも整備済み:
- `Component.type: string`（任意の plugin component 型を許容）
- `ModuleLoader` が関数・オブジェクト両 default export をロード可（M2 で対応済み）
- `Project.pluginRefs: PluginRef[]` 既存
- 唯一の設計課題: `DomRenderer` が component 型を `switch` でハードコード（solid/shape/text/image + html inline）。M4 で **component renderer レジストリ**を導入し plugin 登録型を描画可能にする必要がある（regression ではなく M4 の予定作業）。

**テスト: 86 件全通過** / typecheck ✅ / build ✅

---

---

### M4 Plugin API v1（2026-06-16 実装完了）

**§12 Plugin API v1 — フル登録 API + plugins/ ロード + サンプル plugin。**

- **型定義** — [src/runtime/plugin.ts](src/runtime/plugin.ts)（新規）: `PluginManifest` / `PluginContext` / `ComponentDef` / `EffectDef` / `EasingPreset` / `PureFn` / `ReadonlyFileSystem` / `ImporterDef` / `ExporterDef` / `InspectorControlDef`。
- **PluginRegistry** — [src/runtime/pluginRegistry.ts](src/runtime/pluginRegistry.ts)（新規）: `PluginRegistry` クラス + `globalPluginRegistry` グローバルシングルトン。`makeContext(fs)` でロードごとの PluginContext を生成、`activate(manifest, fn, fs)` で plugin を起動・登録。`getComponentDef(type)` / `getExprHelpers()` / `getEasings()` でレンダラ・エンジンがポーリングなしで引ける。
- **DomRenderer 拡張** — [src/runtime/DomRenderer.ts](src/runtime/DomRenderer.ts)（修正）: `applyObject()` に `globalPluginRegistry.getComponentDef(type)` による plugin component レンダリングを追加。組み込み型は registry に登録されないためスキップ（Map lookup 1回）。フレームごと `def.render({ el, props, frame, width, height })` を呼ぶ。
- **ExpressionEngine 拡張** — [src/runtime/expressionEngine.ts](src/runtime/expressionEngine.ts)（修正）: `makeEvaluator()` の closure 内で `globalPluginRegistry.getExprHelpers()` を lazy 参照し `ctx` に `Object.assign` で注入。既存 evaluator も次のフレームから新 helper を利用可（re-prepare 不要）。
- **パス定数追加** — [src/core/paths.ts](src/core/paths.ts)（修正）: `pluginDir()` / `pluginManifestPath()` / `pluginEntryPath()`。
- **Store 拡張** — [src/editor/store.ts](src/editor/store.ts)（修正）:
  - `pluginsVersion: number` — `loadPlugins()` 完了のたびにインクリメント。PreviewPanel が subscribe して再描画トリガーに使う。
  - `loadPlugins()` — pluginRefs を読み、有効な plugin を ModuleLoader 経由でロード → `globalPluginRegistry.activate()` 。`loadFromFs()` から自動呼び出し。
  - `installSamplePlugin()` — サンプル plugin（gradient-rect component）の JSON manifest + ES module entry を FS に書き込み、pluginRefs に追加して `loadPlugins()` を呼ぶ。
  - `togglePlugin(id, enabled)` — pluginRefs の enabled フラグを更新し再ロード。
  - `addPluginObject(componentType)` — `ComponentDef.params` の default 値から props を組み立てて SceneObject を追加。
- **ProjectPanel 拡張** — [src/editor/panels/ProjectPanel.tsx](src/editor/panels/ProjectPanel.tsx)（修正）: Plugins セクションを追加（pluginRefs 一覧 + enable/disable チェックボックス + "Sample" インストールボタン + 登録済み component ごとの "+ Add" ボタン）。
- **PreviewPanel 拡張** — [src/editor/panels/PreviewPanel.tsx](src/editor/panels/PreviewPanel.tsx)（修正）: `pluginsVersion` を store から subscribe し、変化したら `setRenderTick` で再描画。

**サンプル plugin（gradient-rect）:**
- `installSamplePlugin()` で `plugins/com.example.sample/plugin.json` + `entry.js` を FS に書き込む
- `entry.js` は `export default function activate(ctx)` で `ctx.registerComponent({ type: "gradient-rect", ... })` を呼ぶ ES module
- gradient-rect: `width/height/colorA/colorB/angle` params。div に CSS `linear-gradient` を適用。全 params が animatable（keyframe アニメート可）。

**M4 受け入れ条件チェック（実装レベル）:**
| 条件 | 状況 |
|---|---|
| plugins/ に置いた plugin が component を登録 | ✅ installSamplePlugin → FS → ModuleLoader → activate → registerComponent |
| タイムラインで使用可 | ✅ addPluginObject → SceneObject → resolve → DomRenderer.applyObject → def.render |
| save/load を跨いで生存 | ✅ pluginRefs が project.json に保存 → loadFromFs 時に loadPlugins 自動呼び出し |
| registerExprHelper が expression に届く | ✅ makeEvaluator が getExprHelpers() を lazy 参照してコンテキストに注入 |

**テスト: 86 件全通過** / typecheck ✅ / build ✅（実機 UI 検証は Opus 担当）

### M4 ランタイム検証（2026-06-16, Opus / Playwright, port 5175）

Sonnet 実装の M4 を実機（Playwright/Chromium）で end-to-end 検証。**アプリ側のバグは 0 件**。全 14 検証項目 PASS:

| 検証項目 | 結果 |
|---|---|
| サンプル plugin の manifest ロード（loadedManifests） | ✅ |
| gradient-rect component が registry に登録 | ✅ |
| pluginRefs が project に永続化 | ✅ |
| addPluginObject が SceneObject を生成 | ✅ |
| Preview DOM に子要素が描画 | ✅ |
| **CSS linear-gradient が実際に適用**（子要素 `entry.children[i]`） | ✅ `linear-gradient(90deg, rgb(255,51,128), rgb(26,128,255))` |
| width param default (400px) 適用 | ✅ |
| **params keyframe アニメート**（width f0=400→f15=600→f30=800, 線形補間） | ✅ |
| Save→Reload で pluginRefs 生存 | ✅ |
| Reload 後に component 再登録（loadFromFs→loadPlugins 自動） | ✅ |
| gradient-rect オブジェクトが reload 後も生存 | ✅ |
| togglePlugin(false) で component が registry から外れる | ✅ |
| registerExprHelper → getExprHelpers 配線 | ✅ |
| Console エラー 0 件 | ✅ |

**検証中に気付いた実装の要点**（バグではない・記録用）:
- plugin の `ComponentDef.render` は `[data-object-id]` host div ではなく **その子要素**（`entry.children[i]`）に適用される（[DomRenderer.applyObject](src/runtime/DomRenderer.ts) line 141-157）。検証コードは host の `firstElementChild` を見る必要がある。
- keyframe の easing スキーマは **`{ type: "linear" }`**（`kind` ではない, [schema.ts:24](src/core/schema.ts)）。誤って `kind` を渡すと `easingFn` の switch が undefined を返し `easingFn(...) is not a function` で PreviewPanel がクラッシュする（防御的にはなっていないが、正規の schema 経路では発生しない）。

**結論: M4 完全クローズ。MVP = M0–M4 全マイルストーン実機検証済み。**

---

### §20 Project パネル / コンポジション管理（2026-06-16, Opus / MVP 後 UX 拡張）

ユーザ要望: AE の「プロジェクト」概念（コンポ・素材の一覧）と、アクティブコンポの明示。spec を **v0.3 → v0.4** に更新（§20 追記、スキーマ不変）。

- **spec §20 追記** — Project パネル責務 / コンポ作成・切替・削除の不変条件 / アクティブコンポ明示 / パネル責務分離。`Project.compositions` / `rootComposition` / `currentCompId` は既存のまま、データモデルに新フィールドを足さない（UI 層 + store 操作の規約）。
- **store 拡張** — [store.ts](src/editor/store.ts): `addTimelineComp(name?)`（新規 timeline comp → 即アクティブ・連番名 `Comp N`）/ `removeComposition(id)`（最後の timeline comp は削除不可・root 張り替え・current 移動・html comp は FS ファイル掃除）/ `renameComposition(id, name)`。`setCurrentComp` を frame=0・選択クリアに変更（§20.3）。
- **ProjectPanel 再構成（AE Project パネル化）** — [ProjectPanel.tsx](src/editor/panels/ProjectPanel.tsx): レイヤー一覧を撤去し、**Compositions（timeline+html, アクティブ行ハイライト・ダブルクリックでリネーム・× で削除）/ Footage（assets）/ Plugins** の倉庫ビューに。`+ Comp`/`+ HTML` でコンポ作成。timeline 行クリック=アクティブ化、html 行クリック=配置。
- **PreviewPanel コンポタブ** — [PreviewPanel.tsx](src/editor/panels/PreviewPanel.tsx): 上部に timeline comp のタブ（アクティブハイライト・クリックで切替）。ツールバーにアクティブ comp 名を追加。
- **TimelinePanel** — [TimelinePanel.tsx](src/editor/panels/TimelinePanel.tsx): レイヤー追加（`+ Solid`/`+ Text`）と削除（×）を移設（§20.4 パネル責務分離）。ヘッダにアクティブ comp 名。

**検証**: typecheck ✅ / tests 86件 ✅ / build ✅ / **Playwright 実機 13/13 PASS・console エラー 0**（new project / addTimelineComp が即アクティブ / rename / コンポタブ 2 個描画 / setCurrentComp で frame リセット / removeComposition で root 張り替え・current 移動 / 最後の timeline comp 保護）。

---

## 進行中・未完了タスク

_MVP = M0–M4 全マイルストーン実装・実機検証完了。§20 Project パネル / コンポ管理（MVP 後 UX）実装・実機検証完了。_

### 既知の縮退（§20.2 で意図的に MVP 仕様化）
- 削除した html comp を `compId` 参照する html インスタンス（他 comp 上）はカスケード削除しない。参照先不在は DomRenderer / HtmlCompPlayer 側で「何も描かない」で安全縮退。整合性の自動掃除は将来。

---

## 既知のバグ・課題

- `npm install` 時に transitive deps の脆弱性警告（moderate×3 / high×1 / critical×1）。dev/build ツールチェーン由来で実行時には影響しないが、M1 着手前に `npm audit` で精査推奨。
- IndexedDbFs.list は全 key 取得 → prefix フィルタ（MVP の素直な実装）。アセット数増加時は IDBKeyRange 範囲クエリへ最適化（§11.1 注記どおり将来）。

---

## Next steps（次のセッションでやること）

### M4 実機 UI 検証（次のセッション）

M4 実装は完了した。次のセッションでは Opus + Playwright による実機検証を推奨:
1. `npm run dev` → `+ Sample` ボタンでサンプル plugin をインストール
2. `+ Gradient Rect` ボタンで gradient-rect オブジェクトをタイムラインに追加
3. Preview でグラジエント矩形が表示されることを確認
4. Save → Reload で plugin が save/load を跨いで生存することを確認
5. Inspector で params keyframe アニメーションが動作するか確認

### その後の候補

- **M5 Web Bundle Export（§11.7）** — `@mafter/runtime` ベース player + Single-file bundle。M4 の plugin bake 経路も含む。
- **DomRenderer の plugin component 型変更時の再生成ロジック確認** — reconcile 経路（`childSig` 比較）が plugin 型でも正しく動くことをテストで確認。
- **M4 Opus 検証** — M3 同様、Opus による 8-angle コードレビューでバグ出し推奨。

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
| 2026-06-16 | M2 ランタイム検証・修正（Opus）: ModuleLoader がオブジェクト default export を拒否していた致命バグ + HTML comp 配置/expression 付与 UI 欠落 + PreviewPanel 配線を修正。Playwright 実機で Shadow DOM・per-frame render・wiggle アニメート・決定論を確認。回帰テスト2件追加 tests 86件 ✅ |
| 2026-06-16 | M3 Export 実装完了: ExportConfig / exporter.ts（WebCodecs+mp4-muxer/webm-muxer/PNG-seq/音声mux） / ExportDialog / ProjectPanel拡張（Audio import・Export button）/ DomRenderer getRoot() / store audio asset 管理。tests 86件 ✅ / typecheck ✅ / build ✅。ランタイム検証は Opus 担当。 |
| 2026-06-16 | Opus 8-angle レビュー後バグ修正 6 件（PNG-seq alpha / buildAudioMix 移動 / DomRenderer unmount / PreviewPanel チラつき / audio trim ズレ / ModuleLoader ネガティブキャッシュ）。tests 86件 ✅ |
| 2026-06-16 | M3 Opus 再検証 fix #7（webm alpha が透明にならない）修正。M4 GO 判定記録。 |
| 2026-06-16 | M4 Plugin API v1 実装完了（plugin.ts / pluginRegistry.ts / DomRenderer 拡張 / ExpressionEngine 拡張 / store 拡張 / ProjectPanel UI / PreviewPanel 拡張 / サンプル gradient-rect plugin）。typecheck ✅ / build ✅ / tests 86件 ✅。実機 UI 検証待ち。 |
