# Progress

> AIエージェントはセッション開始時にこのファイルを読み、終了時に更新すること。
> 完了済みの詳細はコミット履歴を正とし、ここは「現在地・残タスク・既知バグ・次の一手」に絞る。
> （2026-06-20 に compact 済み。古い詳細な更新履歴は git log を参照。）

---

### 2026-06-29（Claude Opus）— 汎用コンテキストメニュー基盤の導入 ✅

- **背景**: 右クリックメニューは KF 専用の ad-hoc 実装（[TimelinePanel.tsx](src/editor/panels/TimelinePanel.tsx) の `kfContextMenu` state＋外クリック useEffect＋イージング JSX ハードコード）しか無く、レイヤー/プロジェクトツリー等には未配線だった。AE パリティに向け、どのパネルからでも開ける単一コントローラ基盤を用意。
- **実装**:
  - **新規 単一コントローラ**: [contextMenuStore.ts](src/editor/contextMenu/contextMenuStore.ts) — 軽量 Zustand（`open` / `openContextMenu(x,y,items)` / `closeContextMenu`）。プロジェクトデータ（FS 投影の useEditorStore）と分離した純 UI 状態。`ContextMenuItem = action | separator`（disabled/danger/icon/shortcut 対応）。
  - **新規 描画ホスト**: [ContextMenuHost.tsx](src/editor/contextMenu/ContextMenuHost.tsx) — body ポータル描画。**画面端クランプ**（useLayoutEffect で実寸測定→補正）、外クリック/Esc/scroll/resize/blur で閉じる契機を1箇所に集約。[App.tsx](src/App.tsx) ルートに1つマウント。
  - **KF メニュー移行**: TimelinePanel の `kfContextMenu` 一式を撤去し `openContextMenu` へ。**罠**: メニュー項目の onSelect クロージャは右クリック時点で store にスナップショットされ後続 re-render を読めない → `applyEasingToSelectedKfs(easing, keysOverride)` を追加し、`handleKfRightClick` で対象 KF 集合を明示キャプチャ（旧 JSX 都度レンダリング前提が崩れる）。
  - **実例**: `LayerRow` ヘッダー行に `onContextMenu`（名前を変更/複製/レイヤーを分割/削除）。既存ストアアクション再利用（`duplicateSelected`/`splitSelected`/`removeObjects`/`selectObjects`）。未選択行は先に単独選択（AE 挙動）。KF 行とは別 div なので二重発火なし。
- **検証**: 新規 [verify-context-menu.mjs](verify-context-menu.mjs) で (A) KF イージングメニュー表示＋Hold 適用＋閉じる (B) レイヤーメニュー 複製/削除→Undo/Esc/連続右クリックで1つだけ を実機 PASS。typecheck 緑。`public/player.js` 再ビルド不要（runtime 非依存・エディタ UI のみ）。
- **残/非ゴール**: ラベル色などの**サブメニュー**（基盤の submenu 対応とセットで次タスク）、プロジェクトツリー/インスペクタ/プレビューへの配線（基盤導入済みなので `onContextMenu` 追加のみ）、メニュー項目のキーボードナビ。
- **既知**: `test/projectBins.test.ts`（treeOrder 順序）が **flaky**（本変更と無関係・project tree シリアライズの非決定性）。要別途調査。

---

### 2026-06-26（Claude Opus）— 静的 HTML bundle の動画再生もっさり 真因修正 ✅

- **症状**: 動画レイヤー入りコンポを §11.7 静的 HTML bundle に書き出すと、preview はスムーズなのに bundle player 上で動画がもっさり（実機では `<video>` が paused のまま currentTime=0 で完全停止することも）。
- **真因**: bundle は動画 src を**相対 HTTP URL 直参照**（[imageAssetCache.ts](src/runtime/imageAssetCache.ts) `registerProjectUrls`）にしていた。`<video>` の再生/seek は HTTP byte-range (206) 対応サーバに依存し、range 非対応ホスト（多くの静的ホスティング・`file://`・range 非対応の簡易サーバ）では buffer/seek できず stall。preview は import 時に**ファイル全体を blob URL 化**（`decodeVideoEntry`）するため常にスムーズ＝経路差。
- **修正**: bundle player でも video のみ「一度 `fetch()` して全体を in-memory blob URL 化」する（[imageAssetCache.ts](src/runtime/imageAssetCache.ts) `loadVideoBlobsFromUrls` 追加・[BundlePlayer.ts](src/player/BundlePlayer.ts) start で await）。単一 GET なので range 非対応ホストでも動き、preview と同一の in-memory 再生になる（INV-2）。画像は単一 GET で十分なため対象外（メモリ非肥大）。**ユーザーの仮説「preview と同じ経路を bundle に適用」通り。**
- **スコープ**: video 型のみ・bundle 経路のみ。export（mp4/png）は `loadFromProject`（既に blob）経由で無変更。
- **検証**:
  - **新規 `verify-bundle-video-playback.mjs`**（恒久）: bundle を export→serve し `<video>.currentTime` を壁時計でサンプル。修正前 `paused=YES・playRate=0.00x`（停止）→ 修正後 `pausedSamples=0/20・playRate=1.00x`（native real-time play）。
  - 無回帰: `npm test` 479 PASS / typecheck 緑 / `verify-bundle-export.mjs`（solid・非video）PASS / `verify-video-export-monotonic.mjs`（reversals=0・onTarget=25/25）/ `verify-video-export.mjs`（playerUi=0%）。
  - `public/player.js` を `npm run build:player` で再ビルド済み。
- **残**: export の絶対速度 ~380ms/frame（foreignObject ラスタ化由来・symptom B）は本件と独立で未対応のまま。

---

## 現在のマイルストーン状態

| マイルストーン | 状態 |
|---|---|
| M0 Foundations | ✅ 完了 |
| M1 Core animation + DomRenderer | ✅ 完了 |
| M2 HTML comp + expression | ✅ 完了 |
| M3 Export | ✅ 完了（実機 9/9 検証済み） |
| M4 Plugin API v1 | ✅ 完了（実機 14/14 検証済み） |
| M5 Web Bundle Export（§11.7） | 🚧 Phase 1（Static HTML/ZIP bundle）実装済み・Phase 2 以降残 |

**MVP = M0–M4 完了。** 以降 §20 Project / §21 Timeline AE化 / §22 グラフエディタ / §23 precomp / §24 Ease / §25 Preview編集 / §26 テキスト / §27 エフェクト & 調整レイヤー / §28 Preview Cache / §30 Null / §19.5 Pipeline パネル を拡張中。

現行: **453 tests PASS** / typecheck ✅ / build ✅（2026-06-25）。

- §23.3b: ネスト comp が自身のカメラを live で適用（`setupCameraRig` 共有・Composer 2.5 実装）。
- §23.3c: ネスト comp 内の expression を live で評価する修正。`renderNestedComp` は子 comp を自前 resolve するため evaluator 未注入で wiggle 等が静的化していた（opacity/effect param 含む）。`DomRenderer.setCompEvaluators(Map<compId, evaluator>)` を追加し preview/export/bundle の 3 経路で配線（INV-2）。`createCompFrameCaptureContext` にも配線して深い階層（depth 2+）の expression を補完。
- §23.3d: ネスト comp 内の**調整レイヤーを live 合成**（`backdrop-filter`・ラスタ無し・collapse OFF）。`renderNestedComp` が `isAdjustment` を無視していたため Comp 内調整の blur/displace がネスト先で全消失していた。調整 div を comp 全面・空にして effect を backdrop-filter に積む（`applyNestedLiveEffects` を filter/backdrop 分離、region=comp 寸法）。実データ Comp 19→Comp 10→camera wiggle expression（depth 2）で単体表示と nested の視覚一致を確認（raster 0 段）。Fast* displacement は live、full displacement は §28.11 ラスタ経路据え置き。collapse ON / 強制ラスタライズ opt-in は将来（phase 2）。

---

## 完了済みの主要機能（要約）

- **コア（M0–M2）**: project.json schema / 正準シリアライズ（JCS+NFC）/ FS 抽象（Memory/IndexedDb）/ 決定論 zip / `@mafter/runtime` 単一核（INV-7: Mat4・easing・interpolate・純関数 `resolve()`・module loader・expression engine）/ DomRenderer（flat matrix3d）/ Zustand store（正は FS）/ commands（before/after snapshot undo）/ HTML comp（Shadow DOM 隔離）。
- **Export（M3）**: WebCodecs mp4/webm + PNG-seq フォールバック + 音声 mux。preview と同一パイプライン（INV-2）。
- **Plugin（M4）**: フル登録 API + pluginRegistry + gradient-rect サンプル。
- **§20–§26 UX**: Project パネル / Timeline AE化（Tier A + P0 + P1・KF 複数選択・U/UU・Duplicate/Split・コピペ・DnD 並べ替え）/ グラフエディタ Phase 1 / precomp（Freeze・循環参照 BFS・depth≤4）/ Flow 風 Ease パネル / Preview ビューア編集（ズーム/オーバーレイ/直接操作/KF 書き戻し）/ テキストレイヤー本実装（Draft=DOM・Best=SVG・グリフ分解・opentype.js）/ 画像アセット読み込み（プレビュー縮小プロキシ付き）。
- **§27 エフェクト & 調整レイヤー**: EffectDef（kind=css/svg/raster × executionPath=live/raster）/ builtin blur・tint・wave・ripple・turbulentDisplace・linearWipe・angularWipe・pixelSorter・pixelSortLite / Fast 系（fastWave・fastRipple・fastTurbulent）/ raster パイプライン（rasterCapture 共有・exporter flush）/ Inspector Effects foldout + Timeline effect KF 行。
- **§27.4 Live/Raster 調整レイヤー Phase 1**: `adjustmentMode:"live"|"raster"`（live=backdrop-filter 軽量 / raster=comp 背面 capture 高精度）。export mp4 は `auto_raster_mp4` で Live を自動 raster 化。byte 等価（raster のみ書く）。
- **§27.12 改定3（2026-06-21）— Fast\* を raster 無し live CSS filter 化**: スパイク（`verify-fast-drift-spike.mjs`）でドリフト真因が **filter region の pad 帯**（feImage 未定義域で定数 −scale/2 変位）と判明。`createSvgFilterElement` の displacement region を **(0,0,w,h) クランプ**（pad 廃止）→ live と raster が pixel parity。Fast\*（fastWave/fastRipple/fastTurbulentDisplace）は **raster 無し・フォールバック無し** で live 完結（通常=`filter`、Live 調整=`backdrop-filter`）。full displacement（wave/ripple/turbulentDisplace）は raster 維持。`needsSvgDisplaceCapture` は `hasEnabledFullDisplacement`（fast 除外）参照に。`compNeedsAutoPreviewCache` は full displacement のみ対象（fast-only は live のため除外）。`fastDisplaceDirect` 撤去。**export-parity 実機検証済み**（`verify-fast-export-parity.mjs`: 3 fast effect すべて foreignObject export で変位再現・drift 1.5–2.2px・露出矩形なし。wave raster / tint SVG-url も無回帰）。
- **§27.5 改定4（2026-06-21）— fastWave/fastRipple を `feImage` → `feTurbulence` 直結へ統一（軽量化）**: fastWave/fastRipple はかつて linearGradient/radialGradient の `feImage`（data URI）map を**毎フレーム文字列生成→ブラウザ再デコード**しており、`feTurbulence` 直結の fastTurbulent より重かった。ユーザー要請（「fastTurbulent と同等の軽さ」「Fast 系は Web で動く前提」）で両者を **`feTurbulence`（`type="fractalNoise"`・`numOctaves=1`）純 primitive へ置換**（`fastWaveDisplace`/`fastRippleDisplace`・`effectSvg.ts`）。`feImage`/PNG/data URI を一切生成せず GPU ネイティブ＝ fastTurbulent と同コスト・Web 軽量。正弦/同心円の見た目は意図的に放棄しノイズ歪み近似（承認済みトレードオフ）。真の正弦/同心円が要るならフル `wave`/`ripple`（raster）。死んだ `rippleDisplaceMapSvg`/`fastRippleDisplaceMapSvg`/`WAVE_FAST_QUALITY` は撤去。**実機検証済み**（`verify-fast-turbulence-web.mjs`: store 非依存で実ブラウザ filter render → fastWave/fastRipple/fastTurbulent すべて変位再現・edgeStd 3.1/4.5/10.6 vs baseline 0・露出なし・errors none）。
- **§27.5 改定5（2026-06-21）— Fast 3 種の「見た目の動き」を滑らかに（内部既定・パラメータ不変）**: 改定4 で `feTurbulence` 直結にして軽くなったが、単一オクターブ noise を全帯域のまま `feDisplacementMap` に通すためエッジ変位が粒状で動きがカクついた。ユーザー要請（「軽量化を維持したまま見た目の動きを滑らかに」・制御面 A＝内部既定/パラメータ追加なし）に対し **effect params/§5/INV/直列化 不変・`feImage` 復活なし・INV-2 維持**で builder 内部のみ改善。**(1) map smoothing 常時 ON**: noise map 直後に feature-size 比例 `feGaussianBlur`（`fastSmoothPx`＝`clamp(FAST_SMOOTH_FRACTION(0.06)·特徴サイズ, 0.75, 6)`。wave: λ / ripple: radius/frequency / turbulent: size）で速度を保ったまま flowing に。`antiAlias` は +1px の追加増分として存続。**(2) fastWave phase の段差ジャンプ解消**: `% 360` 折返しを撤廃し連続パン `(phase/360)·λ`、`stitchTiles` を外した座標安定場＋生成域 `|pan|` 対称拡張で boiling/跳躍なし。**(3) パン露出ポップ解消**: `feTurbulence` 生成域を maxPan 拡張し `feOffset` 後も layer 被覆（fastWave=per-frame `|pan|`/stitch off, fastRipple=center 範囲 `0.5·{w,h}` 定数 pad/stitch 維持, fastTurbulent=既存 region/pan 維持で blur のみ＝検証済み centroid 保全）。filter region は改定3 の (0,0,w,h) クランプ維持。**実機検証済み**（`verify-fast-turbulence-web.mjs` を **phase/center/evolution 0→720° アニメ sweep** に拡張: 3 種とも median edgeStd>baseline+2＝効果残存・全フレーム ink 高＝露出ポップなし・隣接フレーム MAD スパイクなし＝段差/露出なし・`feImage` 不使用・errors none・複数回 PASS 安定）。比較 PNG=`verify-fast-smooth-web.png`。
- **§28 Preview Cache / RAM Preview**: 二層キャッシュ（L1 メモリ LRU + L2 専用 IDB）/ ワークエリア / 緑バー / Caching ON/OFF トグル（既定 OFF）/ Auto Preview Cache（full displacement のみ）/ `previewBakeRequired` フラグ（§27.2）。
- **§28.10 per-layer raster キャッシュ（local frame 基準）**: 自己 capture（displacement）の per-layer キャッシュキーを comp 絶対フレーム → **layer-local frame**（`compFrame − inPoint`）に変更。レイヤーをスライド(move)しても内容不変なら再ラスタしない。`ResolvedObject.inPoint` を passthrough（resolve）。タイムラインに per-layer 緑線（レイヤーバー直上, `cacheSegments.framesToSegments` 共有・`previewCacheService.subscribeLayerFrames`）。comp 全体緑バー(ルーラー)は補助として共存。
- **§28.11 precomp comp 単位ラスターキャッシュ（content hash 基準）**: ネスト comp(A) が `compNeedsAutoPreviewCache` を満たす（displacement/raster を含む）とき、comp(A) をオフスクリーンで画像化（`precompRasterService` + `compFrameCapture`）して `<img>` 描画し、キー `precomp:{compId}:f{childFrame}:hash{contentHash}` でキャッシュ。`contentHash`（`compContentHash`）は projectRevision 非依存なので **comp(B) 編集では無効化されない**。rasterizer はライブ preview と RAM Preview の両キャプチャ経路に注入（INV-2: `resolve()` 不変・同一パイプライン）。タイムラインの precomp レイヤーバー直上に緑線（`precompChildToParentFrame` で childFrame→parentFrame 写像・`subscribePrecompFrames`）。**export/bundle 経路への rasterizer 注入は未配線（follow-up）**。
- **§30 Null レイヤー Phase 1** / **§21.8 Parent リンク UI**（循環検証・world 保持 reparent）/ **§19.5 Pipeline パネル Phase 2**（合成順序可視化・崖検出・mp4 auto_raster 注記）。
- **§26.3.1 Font プルダウン / §31 Solid 色編集（2026-06-21・UI 層・スキーマ不変）**: Text の Font を自由入力から **web-safe フォント 15 種のプルダウン＋「Custom…」任意入力**へ（`fontList.ts` 単一定数・`font` は静的 string のまま・描画経路不変）。Solid は Inspector に **"Solid" セクション（Fill スウォッチ・◇ KF 可）** を追加（従来 text 以外は null 描画だった）＋ **Timeline レイヤー行にカラーチップ**（`title="ソリッドの色"`・現フレーム色サンプル・ピッカー操作中は preview override / blur で undo 付き commit・既存 `color: AnimatedProp<RGBA>` を再利用）。**実機検証済み**（Playwright: Solid セクション/チップ表示・初期 #8080e6・チップ→赤 commit・Font 16 option 含 Custom…・Georgia 選択で `Georgia, serif` 書込・console error なし）。
- **§5.4b/§6.5b 3D 導入 Phase 1（2026-06-23・疑似3D DOM + AE 準拠カメラ）**: 仕様承認済み（全3フェーズ計画、AE 準拠ハイブリッド）。**(A) mat4** に `perspective`/`lookAt`/`orthographic`+vec 演算（cross/dot/normalize/sub）追加・単体テスト。**(B) schema**（additive・byte 等価維持）: `SceneObject.threeD?`/`threeDMode?:"auto"|"dom"|"raster3d"`、`TimelineComposition.renderer3d?:"classic"|"advanced"`（serialize で既定値は省略）。**(C) camera builtin 登録**（`cameraType` one/two-node・`pointOfInterest`・`zoom`(px)・`filmSize`・`near`/`far`）。resolve で **zoom→fov**（`fov=2·atan((h/2)/zoom)`）・**two-node lookAt**（注視点 auto-orient・up=+y で one-node 規約と一致＝X 反転なし）・**実効3Dモード解決**（auto→comp.renderer3d）を ResolvedObject に焼く（INV-1/3 維持）。旧 `fov` 後方互換。**(D) DomRenderer（Phase 1.1 で確定）**: 3D メタデータ passthrough。**カメラ CSS リグは per-object 焼き込み**＝root に `perspective`+`perspective-origin` のみ、view は **3D 層の行列に焼く**（`translate(cx,cy,P)·view·world`）。CSS `perspective` は子孫の 3D 変換にしか効かないため root に view を置くと dolly/zoom が無効になる問題（純 DOM 実験 `verify-3d-mechanism.mjs` で確定: 同一要素 perspective+transform は z=0 子を拡大しない）を解消。既定 cameraZ=zoom=P で等倍 neutral、dolly `scale=P/(camZ−z)`、zoom `scale=P/camZ`。**2D 層はカメラ免除**（素の worldTransform・AE 準拠）。**(E) UI**: Timeline 行 3D トグル/モードバッジ/CAM バッジ・ツールバー `+Cam`/activeCamera ドロップダウン/`3D:Classic|Advanced` セレクタ・Inspector「3D」フォールド（threeD/threeDMode）+「Camera」フォールド（type/POI/zoom/near/far/Set Active）・store `addCamera`/`setActiveCamera`/`setThreeD`/`setThreeDMode`/`setCompRenderer3d`。**(F) Export**: 3D 含むコンプに best-effort 注記（正準3D書き出し=GL readPixels は Phase 2）。**実機検証済み**: `verify-3d-camera.mjs`（camera 登録・activeCamera・scene.camera・fov=50・3D 実効 dom・content 中央・**3D 層パン応答 / 2D 層免除**・退化描画なし・error なし）+ `verify-3d-camera-investigate.mjs`（**dolly 半距離→2.0倍/倍距離→0.5倍、zoom 望遠→2.0倍/広角→0.5倍、既定→等倍、2D 全条件で不動**＝AE 準拠を実測 PASS）。355 tests / typecheck / build 緑。
- **§6.5b カメラ bundle-bake 誤判定 修正（2026-06-23）**: Static HTML 書き出しで、組み込み live エフェクト(blur/fastTurbulent)+カメラのみのコンプが「plugin / bake レイヤ 1 件」と表示・カメラ層を無意味に動画化していた。原因 = [bundleCollect.ts](src/runtime/bundleCollect.ts) の `BUILTIN_COMPONENT_TYPES` に **`camera` が欠落** → `componentNeedsBake` がプラグイン扱い → `bundleExportDefault` 未指定で既定 bake。修正 = set に `"camera"` 追加（非描画なので絶対 bake しない）。effects は元々 bundle bake 対象外（components のみ判定）。**回帰テスト追加**（`test/bundleExport.test.ts`: camera 非 bake / camera+調整(blur/fastTurbulent) で bakeTargets=0）+ **実機検証**（`verify-export-bake.mjs`: 同シナリオで cameraNeedsBake=false・bakeTargetCount=0・error なし PASS）。357 tests / typecheck / build 緑。
- **§21.8.2 Null/親付けの world 保持を全 KF へ修正 + §30.1 toggleAdjustment ガード（2026-06-24・Null 振る舞い監査）**: ユーザー報告「KF で動きのついたレイヤーの親に Null を与えると座標がおかしくなる」を起点に Null 振る舞いを広く監査。**実害バグ 2 件のみ**に絞り修正（他のグレー項目＝viewport クリック選択は全レイヤー未実装で Null 固有でない／3D・effect on Null は AE 準拠・§30 許可で意図的、は対象外と判定）。**Fix A（本命）**= [reparent.ts](src/editor/reparent.ts) `buildReparentPatch` が**現フレームの 1 KF のみ補正**していた（`setVec3Keyframe` がその frame だけ書換）ため、KF 付きレイヤーを親付けすると他フレームで Null(既定 960,540)のオフセット分ずれていた。**child の全 KF を各 frame で補正**する形に書換: 各 frame f で `L_new(f)=invert(W_parentNew(f))·W_childOld(f)` を decompose しその frame の KF 値へ上書き（**KF 位置・easing 保持**、`computeWorldTransforms` は対象 frame 集合に 1 回ずつ）。**static 親（Null の常態＝定数オフセット）→ 全フレーム厳密保持（KF 間補間も一致）**、animated 親→各 KF frame で保持・間は近似。static チャンネルは現フレーム decompose で value 更新。**Fix B（軽微）**= [store.ts](src/editor/store.ts) `toggleAdjustment` 先頭に `if (obj.isNull) return;`（§30.1 排他をストア操作でも担保）。spec §21.8.2/§30.1 を先行更新。**回帰テスト**（`test/reparent.test.ts`: position KF 0/15/30 を Null へ親付け → world が 0/7/15/22/30 すべてで親付け前と一致 / easing 保持 / KF 本数不変）+ **実機検証**（`verify-reparent-null.mjs`: 実ストア reparent 経路＋canonical `resolve()` で maxDelta=0・KF 補正 [0,15,30]・Null 移動で子追従 maxFollowErr=0・error なし PASS）。359 tests / typecheck / build 緑。
- **§20.4b 新規プロジェクト保存確認ダイアログ（2026-06-23・UI 層・スキーマ不変）**: Project パネルの `New` を押すと**常に**保存確認モーダル（[はい（保存）] [いいえ] [キャンセル]）を表示。[はい]＝**web 版は zip ダウンロード**（`onExportZip` 経由）→ `newProject()`、[いいえ]＝保存せず `newProject()`、[キャンセル]＝何もせず閉じる。Esc/暗幕クリック＝キャンセル。**デスクトップ版の保存先指定は未実装**（`onNewSaveThenCreate` に `TODO(desktop)` コメント。File System Access API / Electron で OS ダイアログ、現状は zip フォールバック）。dirty 判定は持たない（自動保存により IndexedDB 基準の未保存が常に無いため）。spec §20.4b。typecheck 緑。
- **§11.5/§11.5.1 オーディオ再生 + タイムライン波形表示（2026-06-24・spec §11.5/§11.5.1 追記済み・§5/INV/直列化 不変）**: 従来エディタプレビューは無音（[previewPlaybackLoop.ts](src/editor/previewPlaybackLoop.ts) は純 rAF）で波形も非表示だった。**(A) プレビュー音声マスタークロック**＝[previewAudioClock.ts](src/editor/previewAudioClock.ts) `PreviewAudioClock`：再生時に audio レイヤーがあれば `AudioContext` をマスタークロック化（`currentFrame = rangeStart + floor((ctx.currentTime−t0)·fps)`・INV-8 フレームスキップ）、各レイヤーを `inPoint/outPoint/trimStart/gain` で `AudioBufferSourceNode` スケジュール、loop wrap で再スケジュール。[PreviewPanel.tsx](src/editor/panels/PreviewPanel.tsx) 再生 effect で `hasAudioLayers` 判定→音声ありは audio clock、無し/decode 全失敗は従来 rAF（`runPreviewPlaybackLoop`/`runPreviewFrameClock`）へフォールバック。スクラブ/停止は無音。**(B) 波形 DSP**＝[waveform.ts](src/audio/waveform.ts)（純関数・WebAudio 非依存・node テスト可）：`computePeaks(channels, sampleRate, mode, buckets)` が正準 4096 バケットの min/max ピークを生成。`raw`／`donshari`（RBJ biquad lowshelf 80Hz+highshelf 6kHz 自前実装でキック/ハイ強調）／`transient`（fast/slow エンベロープ差分で海苔波形のアタックを過剰強調）。**(C) キャッシュ**＝[WaveformCacheDb.ts](src/fs/WaveformCacheDb.ts) `globalWaveformCache`：project FS とは別 IndexedDB（`mafter-effect-waveform-cache`）に `assetId:mode:buckets` キーで Float32Array 保存＋メモリ L1＋アセット単位 decode メモ化。`project.json` 非直列化。**(D) UI**＝[TimelinePanel.tsx](src/editor/panels/TimelinePanel.tsx) `WaveformOverlay`（audio 層バー上に Canvas、`getLayerSourceExtent` で trimStart/sourceDuration を取得しトリム追従）＋ツールバーに波形モード循環ボタン（RAW→DON→TRN）。モードは store `waveformMode`（グローバル・localStorage 永続・非直列化）。**実機検証済み**（`verify-audio.mjs`: WAV をプログラム生成→import→audio 層追加→波形 Canvas 描画確認、raw/donshari/transient で描画ピクセルが相違（1763/1193/1030）＝DSP 効果、transient で海苔波形のアタックがスパイク化（`verify-audio-transient.png`）、再生で frame 0→18 前進＝audio clock 駆動、`hasAudioLayers`=true・error なし PASS）。364 tests（+waveform 5）/ typecheck / build 緑。
- **§11.5 オーディオ プリロード + duration メタ（2026-06-24・spec §11.5 追記済み・§5/INV/直列化 不変）**: 2 件のバグ/UX 修正。**(1) 再生レイテンシ**＝新規 [audioBufferCache.ts](src/editor/audioBufferCache.ts)（decode 済み `AudioBuffer` を assetId キーで共有メモリ常駐・`loadAudioBuffer`/`peekAudioBuffer`/`probeAudioMeta`）。[PreviewPanel.tsx](src/editor/panels/PreviewPanel.tsx) に編集中 comp の audio をプリロードする effect を追加し、再生ボタンで decode 待ちなく即発音（実測 ~120ms で frame 前進）。[previewAudioClock.ts](src/editor/previewAudioClock.ts) `prepareAudioLayers` と [WaveformCacheDb.ts](src/fs/WaveformCacheDb.ts) も同キャッシュを共有し、66MB 級ソースの多重 decode を排除。**(2) 波形が右へ徐々に縮み最後は直線化する不具合**＝原因は audio asset の duration メタ未記録 → `getLayerSourceExtent` の `sourceDuration` がレイヤー長（≒comp 5s）にフォールバックし、数分の曲全体がバーに圧縮表示され、曲の verse→breakdown→outro 包絡が「右へ縮んで最後は無音=直線」に見えていた。修正は二段構え: (a) [store.ts](src/editor/store.ts) `importAudioAsset` が import 時に 1 回 decode して `asset.meta`（`duration`/`sampleRate`/`channels`）を記録（`AssetEntry.meta` は既存任意フィールド・image と同様・§5 非変更）。(b) **より堅牢に**、[TimelinePanel.tsx](src/editor/panels/TimelinePanel.tsx) `WaveformOverlay` がソース全長を **decode 済み `AudioBuffer` の実尺（秒×fps）を最優先**で使う（`peekAudioBuffer`/`loadAudioBuffer`・fps を prop 追加）。これにより **meta 未記録の旧アセット（修正前に import 済みで project.json に meta が無い）でも** 圧縮表示されない。peaks が L2 キャッシュヒットで decode を経由しない場合も `loadAudioBuffer` で実尺を確実に取得。**実機検証済み**: `verify-audio-fix.mjs`（fresh import: `meta.duration=230.64s`・波形均一 ratio 0.93・再生レイテンシ 120ms PASS）＋ `verify-audio-nometa.mjs`（**meta を剥がした旧アセット相当**で 5 分割セグメント高 6.5/6.0/5.2/6.9/6.9＝右端も潰れず均一・lastToFirst 1.05 PASS）。
- **§5.4d 描画モード / ブレンドモード（2026-06-24・Tier C 部分・spec §5.4d/§21.0 追記済み）**: AE の描画モードをレイヤーに追加。**Web ネイティブ合成**でできるだけラスター化しない構造。**型** = プレーン enum `SceneObject.blendMode?: BlendMode`（CSS 直結 16 種＋`ditherDissolve`・キーフレーム不可・[schema.ts](src/core/schema.ts) `BLEND_MODES`）。**直列化** = `"normal"` 以外のみ書く（[serialize.ts](src/core/serialize.ts)・byte 等価維持）、不明値は validate で strip。**resolve** = `ResolvedObject.blendMode`（既定 normal・補間なし・INV-3）。**preview / Live HTML バンドル** = [DomRenderer.ts](src/runtime/DomRenderer.ts) `applyBlendMode` で 16 種は CSS `mix-blend-mode` 直設定（**ラスター化ゼロ・ネイティブ合成**）、`ditherDissolve` は `mask-image` に Bayer 秩序ディザ（[ditherMask.ts](src/runtime/ditherMask.ts)・opacity を閾値へ・div α=1・**Math.random 不要で INV-1**・α しきい値なので foreignObject でもそのまま出る）。**動画キャプチャ（mp4/webm/png）** = comp に非 normal の 16 種があれば [exporter.ts](src/runtime/exporter.ts) `captureRendererFrame` が **レイヤー別キャプチャ→Canvas 2D `globalCompositeOperation`** で z 順合成（[blendCompose.ts](src/runtime/blendCompose.ts) で blendMode→GCO 写像・INV-2）。非 blend comp は従来の単一スナップショット高速経路を維持。**UI** = [InspectorPanel.tsx](src/editor/panels/InspectorPanel.tsx) の Transform 内に Blend Mode ドロップダウン・store `setBlendMode`（normal→undefined で省略・undo 付き）。**テスト**（`test/blendMode.test.ts` 10 件: 直列化省略/byte 等価・validate strip・resolve 素通し・GCO 写像・Bayer 全階調&単調&決定論）+ **実機検証**（`verify-blend-mode.mjs`: multiply で `mix-blend-mode:multiply`・ditherDissolve で `mask-image` 設定/blend クリア/opacity 1 PASS）。**動画キャプチャの per-layer 合成は 3D 層 perspective/調整レイヤーとの相互作用が best-effort**（foreignObject 既存制約と同等）。
- **§26.3.2 同梱フォント Noto Sans / Noto Sans JP（2026-06-24・spec §26.3.2 追記済み・§5/INV/直列化 不変）**: システム依存の web-safe フォント（§26.3.1）は環境差で preview↔export 一致（INV-2）を保証できないため、**実 TTF を同梱**して環境非依存に。**対象** = `Noto Sans`（ラテン）+ `Noto Sans JP`（日本語グリフ含む）、各 **Regular(400)/Medium(500)/Bold(700)** の計 6 ファイル（`public/fonts/*.ttf`・Google Fonts 完全版 TTF・JP 各 ~5.3MB / Latin 各 ~558KB）。**登録の単一情報源** = [builtinFonts.ts](src/runtime/builtinFonts.ts)（`BUILTIN_FONTS`・`registerBuiltinFonts(baseUrl)` が family×weight の `@font-face` を 1 `<style>` 注入・冪等・`font-display:swap` で**使用時のみ遅延ロード**＝起動コスト増なし）。**適用範囲** = (a) [main.tsx](src/main.tsx) 起動時 `registerBuiltinFonts("/fonts")` で**エディタ + 同一 document の WebCodecs/PNG export を一括カバー**。(b) **Web Bundle（§11.7）** は file:// 自己完結のため、[bundleExporter.ts](src/runtime/bundleExporter.ts) が text 層を走査して使用 family×weight のみ zip 同梱＋`BundleManifest.builtinFonts` 列挙し、[BundlePlayer.ts](src/player/BundlePlayer.ts) が `FontFace(family, url, {weight})` 登録。**ウェイト** = `font` は family 文字列のみ（スキーマ不変）、太さは既存静的 `weight` で選択（400/500/700 の `@font-face` を CSS が解決）。**outline** = `@font-face` 実ロード済みなので precise の SVG `<text>` フォールバックでも正確（opentype per-glyph 化は将来最適化）。**UI** = [InspectorPanel.tsx](src/editor/panels/InspectorPanel.tsx) ドロップダウンに `optgroup`「Bundled」を先頭追加・`isKnownFont` が built-in も既知扱い。**テスト**（`test/builtinFonts.test.ts` 3 件: 3 ウェイト構成・スタック先頭 family 判定・weight 最近傍スナップ）+ **実機検証**（Playwright: `@font-face <style>` 登録・`document.fonts.check("700 64px 'Noto Sans JP'", "日本語")`=true・text 層を Noto Sans JP/700/日本語に設定→ computed `font-family="Noto Sans JP", sans-serif"` / `font-weight=700` で実描画 PASS）。393 tests / typecheck / build 緑。
- **§5.6 背景未設定コンポ = 透明に統一（2026-06-24・spec §5.6/§25.2 追記済み・スキーマ/INV/直列化 不変）**: `CompositionMeta.background` 未設定（undefined）の扱いが経路ごとにバラバラ（preview=黒・ネスト PNG ベイク=黒・bundle=黒・export alpha=透明）で INV-2 が部分的に崩れていた問題を、ユーザー要請「背景に何も置かれていないコンポは透明」に従い**「未設定＝透明」へ統一**。**スキーマは不変**（`background?: RGBA` のまま・散文明確化のみ）。**変更**: (1) [compFrameCapture.ts](src/runtime/compFrameCapture.ts) `compBackground` 未設定→`"transparent"`（ネスト precomp ベイクが親へ透過合成）。(2) [BundlePlayer.ts](src/player/BundlePlayer.ts) `setupViewport` の `#000` 既定を削除（未設定はホストページの地が透ける）→ `npm run build:player` で `public/player.js` 再生成済み。(3) [PreviewPanel.tsx](src/editor/panels/PreviewPanel.tsx) stage 背景を未設定時に **`⬚` トグル ON=CSS チェッカー / OFF=黒** へ（`CHECKERBOARD_STYLE`・既存 `viewerSettings.checkerboard` 再利用）、従来コンテンツの前面に乗っていた [PreviewViewerOverlay.tsx](src/editor/panels/PreviewViewerOverlay.tsx) の SVG チェッカー rect＋`pv-checker` pattern を撤去（潜在バグ解消）。**不透明 export（alpha 無 MP4/WebM/不透明 PNG）は従来どおり黒マット**（[exporter.ts](src/runtime/exporter.ts) 変更なし＝AE 準拠）。**追加（同日・既定値変更）**: 新規コンポは従来 `background:{0,0,0,1}`（不透明黒）を明示生成しており「何も置かれていない」状態にならず ⬚ 切替も効かなかったため、[store.ts](src/editor/store.ts) `addTimelineComp` / [createProject.ts](src/core/createProject.ts) の **既定 background を削除（未設定＝透明）**。既存プロジェクト（黒保存済み）は不変。**背景編集 UI** = store `setCompBackground(RGBA|null)`・undo 付き・`null` で背景キー省略＝透明。DomRenderer root は [PreviewPanel](src/editor/panels/PreviewPanel.tsx) effect で**ライブ反映**（mount 後の編集で再マウント不要）。**2026-06-24 追記**: 背景編集 UI を **Preview ツールバー → Inspector（レイヤー未選択時 Composition セクション）** へ移設（Unity 的選択駆動）。`BackgroundControl` + `CHECKERBOARD_STYLE` を [BackgroundControl.tsx](src/editor/panels/BackgroundControl.tsx) / [checkerboardStyle.ts](src/editor/checkerboardStyle.ts) に共有化。選択解除 = Escape + TL ruler ラベル列空白 click（§21.4）。393 tests / typecheck / build:player 緑。
- **§5.6/§23.2 コンポジション設定をインスペクターで編集可能化（2026-06-25・spec §5.6/§23.2/§25.2 追記済み・スキーマ/INV 不変）**: 従来 Inspector の「Composition」セクションは `background` のみ編集可で `width`/`height`/`fps`/`duration` は読取専用だった。AE Composition Settings 基本相当を **`ScrubNumber` で編集可能**に。**スコープ = 既存スキーマフィールドのみ**（§5 型変更なし）。**(A) リサイズ** = [compEdit.ts](src/editor/compEdit.ts) `resizeCompCentered`（純関数）: width/height を `>=1` 整数化、`parent===null` の層のみ `position` x/y を `((newW-oldW)/2,(newH-oldH)/2)` オフセット（**中央基準維持・子は parent 継承で追従＝二重移動なし**・z 不変・base値と全 KF 両方）。store `resizeComp`。**(B) fps 変更** = `rescaleCompFps`（純関数）: `ratio=newFps/oldFps` で全 AnimatedProp（transform4+opacity+component+effect）の全 KF frame・各層 inPoint/outPoint・duration を `round(*ratio)`（**秒タイミング維持**・INV-5 準拠）。comp コンポーネントの `trimStart` は子 frame 単位なので不変。store `setCompFps`（再生ヘッドも秒維持で再配置）。**(C) duration 変更** = store `setCompDuration`（再生ヘッド超過時クランプ）。3 アクションとも command パターン（undo 可）。**(D) ネスト fps 不一致 = 秒ベースマッピング** = [compLayer.ts](src/runtime/compLayer.ts) `compChildFrame` に `parentFps`/`childFps` 引数追加し `childFrame=clamp(round((parentFrame-inPoint)/parentFps*childFps)+trimStart,0,dur-1)`（AE 既定）。**fps 一致時は旧式と完全一致＝後方互換**（既存プロジェクト描画・precomp キャッシュキー不変）。preview/export 両経路（[DomRenderer.ts](src/runtime/DomRenderer.ts) 2 箇所）が同一式共有で INV-2 維持。**注意（follow-up）**: 緑線写像 [precompFrameKey.ts](src/cache/precompFrameKey.ts) `precompChildToParentFrame` は 1:1 のまま（best-effort UI・fps 一致では同一）。**UI** = [InspectorPanel.tsx](src/editor/panels/InspectorPanel.tsx) の Size/Frame Rate/Duration 行を `ScrubNumber` 化（読取専用 span 撤去）。**テスト**（`test/compEdit.test.ts` 11 件 + `test/precomp.test.ts` に fps-aware 4 件＝equal-fps 旧式一致の不変条件含む）+ **実機検証**（`verify-comp-settings.mjs`: 中央オフセット 200,100→300,200・fps30→60 で dur150→300・KF [0,30]→[0,60]・undo 復元 すべて PASS）。
  - **追補（2026-06-25・ネスト fps 真因修正）**: 上記の `compChildFrame` fps 化だけでは**実機で 2 倍速が直っていなかった**。真因は DomRenderer が親 fps を **`this.currentComp.fps`（mount 時スナップショット）** から取っていたため、マウント後の fps 変更や comp 切替で stale 値（=子と同じ fps）になり 1:1 へ退行していた。**修正**: [resolve.ts](src/runtime/resolve.ts) が comp コンポーネントに **`_parentFps`（解決中 comp の fps）を注入**し、[DomRenderer.ts](src/runtime/DomRenderer.ts) の両呼び出しが `c.props["_parentFps"]` を使用（`this.currentComp.fps` 依存を撤廃・nested-of-nested も resolve(childComp) が childComp.fps を注入）。**実機検証**（`verify-nested-fps.mjs`: 60fps 親に 30fps 子をネスト → 親フレーム 0/30/60/120 で実効 childFrame 0/15/30/60＝**1 倍速**・以前は 0/30/60/120 の 2 倍速）。`test/precomp.test.ts` に `_parentFps` 注入ケース追加。431 tests / typecheck / build 緑。
- **§5.6/§21.1 Duration・タイムコードを AE `H:MM:SS:FF` 表示へ（2026-06-25・spec §5.6/§21.1 追記済み・スキーマ/INV 不変・UI/表示層のみ）**: ユーザー要請「Duration 指定を AE 形式に（frame は具体的だが人間に分かりにくい）」+「タイムラインパネル右上の数字も同フォーマットに」。**内部値は INV-5 どおり整数 Frame のまま**（§5 型変更なし）、見た目だけ変換。**(A) 純関数** = [timecode.ts](src/editor/timecode.ts) `framesToTimecode`（frame→`H:MM:SS:FF`・MM/SS/FF 2桁ゼロ詰め・H 非ゼロ詰め・fps 依存）/ `parseTimecode`（`:`または`;`区切り右詰め解釈: 4=H:MM:SS:FF / 3=MM:SS:FF / 2=SS:FF / **1=生フレーム数**・桁あふれ自然繰上げ・負数/非数値拒否）。**(B) Duration 入力** = [TimecodeScrub.tsx](src/editor/TimecodeScrub.tsx)（従来 ScrubNumber の drag UX 維持＝1px/frame、click で timecode テキスト編集）。[InspectorPanel.tsx](src/editor/panels/InspectorPanel.tsx) の Duration 行を ScrubNumber→TimecodeScrub に差替（`fps` prop 追加）。**(C) タイムライン統一** = [TimelinePanel.tsx](src/editor/panels/TimelinePanel.tsx) のローカル `framesToTimecode`（SMPTE 2桁時）を撤去し共有 `framesToTimecode` を import。右上の生フレーム `F{frame} / {duration}` → `timecode / timecode`（title に旧 `F..` 併記）。toolbar 現在時刻・ルーラー目盛りも同じ共有実装に。**§21.1 を SMPTE `HH:MM:SS:FF`→AE `H:MM:SS:FF` に改定**（唯一の共有実装明記）。**スコープ外（未変更）**: Preview パネル上部 toolbar の timecode（別パネル・2桁時のまま）。**テスト**（`test/timecode.test.ts` 13 件: format/parse/round-trip/fps 依存/拒否）+ **実機検証**（`verify-duration-timecode.mjs`: 30fps/150f→`0:00:05:00`・setCompFps(60)で dur 300 維持 `0:00:05:00` PASS / `verify-timeline-shot.mjs`: 右上 `0:00:01:15 / 0:00:05:00` 表示確認）。446 tests / typecheck / build 緑。
- **§9 Expression Phase 0.5（2026-06-26）**: `SceneObject.expressionPresets[]`（Effect 同型 UI + param KF）+ 共有 FS 脚本 `presets/expressions/<presetId>.js`（write-if-absent）+ `ctx.presetParams` 注入。Inspector: +追加/disable/× + ExpressionPresetFields。Timeline: `expressionPresets.<id>.<key>` 行。legacy `@mafter:preset` + per-object script は読取専用表示（編集で新形式へ）。**498 tests** / typecheck 緑。
- **§11.7 HTML bundle — expression preset 未同梱バグ修正（2026-06-26）**: Phase 0.5 の共有脚本 `presets/expressions/*.js` が bundle の `manifest.textFiles` に入らず player の ModuleLoader が null → expression 無視（動画 export は FS 直読のため正常）。**修正**: [builtinExpressionPresetScripts.ts](src/runtime/builtinExpressionPresetScripts.ts) に脚本正本を集約、[bundleCollect.ts](src/runtime/bundleCollect.ts) で path 収集、[bundleExporter.ts](src/runtime/bundleExporter.ts) で FS 未存在時に `injectBuiltinExpressionPresetScripts` で manifest へ埋め込み。`test/bundleExport.test.ts` +2 件。

---

## 既知のバグ・未解決課題

- **§11.7 HTML bundle — MP4 入りコンポの再生もっさり（優先度高）**: 動画 Footage（`component.type === "video"`）を含む timeline comp を **HTML bundle（§11.7）で書き出し、player で再生**すると preview より重く・カクついて感じる（MP4 export のもっさり issue と同型の症状が bundle 再生経路でも報告）。bundle は video を bake せず live `<video>` + 同梱 mp4 で再生する設計だが、現状は **Preview パネルで直した `previewVideoPlayback`（`video.play()` でネイティブ decode に任せる）経路と完全には一致していない**可能性が高い（毎フレーム `renderFrame` → seek / DOM reconcile 由来のオーバーヘッド等）。**想定修正方針**: PreviewPanel / [videoElementSync.ts](src/runtime/videoElementSync.ts) と同様に BundlePlayer から `previewVideoPlayback: true` を再生中一貫適用し、停止・スクラブ時のみ seek（[BundlePlayer.ts](src/player/BundlePlayer.ts) は一部配線済みだが不十分の可能性）。関連: [doc/issue/video-footage-export-sluggish.md](doc/issue/video-footage-export-sluggish.md)（MP4 export 側の追跡 issue・症状は近いが経路は別）。
- **§27.3 SVG 5 種の export 一致（INV-2）未検証**: wave/ripple/turbulent/linearWipe/angularWipe の preview↔export ピクセル parity（feImage href が foreignObject ラスタ経路で再現するか）。pixelSorter は検証済み。
- **Issue B（[doc/distortion-effect-bugs.md](doc/distortion-effect-bugs.md)）**: turbulent プレビュー左端グレー枠の歪み漏れ。未着手。
- **Issue C / fastTurbulent centroid**: 強 amount で centroid ~6–8px ドリフト残（[effectRouting.ts](src/runtime/effectRouting.ts) で self-capture raster 統一後も残るチューニング課題）。
- **ディストーション phase/speed/direction（要設計判断・スキーマ追加）**: AE Ripple/Wave Warp の Ripple Phase（伝播アニメ）・Wave Speed/Type/任意角度 Direction が現状 param 未公開。effects params スキーマ追加になるため Claude Code 設計待ち（`rippleDisplaceMap` は `phaseDeg` を既に受けられる）。
- **§26.4 Draft/Best 残差（許容済み）**: DOM vs SVG 経路差で 100% ピクセル一致は非目標（実測 ≤2px・実用上問題なし）。
- **§28.11 export/bundle parity（follow-up）**: precomp comp 単位ラスタは現状ライブ preview + RAM Preview のみ。`exporter.ts` / `bundleBake.ts`（runtime）へ rasterizer 未注入のため、ファイル export ではネスト comp 内 effect が §23 Phase-1（非焼き込み）のまま。`resolve()` 出力は一致（INV-2 の literal は保持）だがピクセル一致は §27.3 と同じ tracked follow-up。runtime→editor 依存を避けるため optional param 経路で後日配線。
- **調整レイヤー export follow-up**: §27.4.1 multi-pass flush の厳密 sequential 化（積層調整の export 順序）/ precomp ネスト内 Live 調整の export auto_raster（compFrameCapture へ option 未配線）/ RAM preview cache の Live 調整 fidelity。
- **§23.3d 派生 TODO（phase 2・未着手・要ユーザー確認＋§5 スキーマ判断）**:
  - **collapse ON オプトイン**: ネスト comp 内の調整レイヤーが親 comp の下位レイヤーにも染み出すモード（AE collapse transformations 相当）。現状は collapse OFF 固定（isolation:isolate で precomp 内スコープ）。レイヤー単位 opt-in が必要なら `SceneObject` への schema 追加が要る → 事前にユーザー確認（INV/§5 変更ゲート）。
  - **強制ラスタライザ opt-in**: HTML 書き出しを必要としないユーザー向けに、comp/レイヤー単位で「決定論的にラスタ化して再生」を強制できるオプション（例: `forceRaster?` フィールド）。プロフェッショナル動画出力向けフォールバック。schema 追加のため事前にユーザー確認が必要。
  - 両方ともユーザーの了承（「live調整(§23.3d)+evaluator補完を今回実装」のみ今回スコープ）により今回は対象外。次にこの領域に着手する際は、まず仕様（§23.3 系）に追記してから実装する。
- **verify スクリプト未整合**: `verify-preview-cache.mjs`（cache 既定 OFF 後の Realtime 期待）・`verify-effects.mjs`（project ロード前提）が現行挙動と FAIL。要更新。
- **3D Phase 1 の意図的な制約（Phase 2 で対応）**: ①**2D 層のカメラ免除は Phase 1.1 で実装済み**（per-object 焼き込みで 3D 層のみカメラ応答・2D は固定＝AE 準拠。当初懸念した特異点/ two-stratum 分離は per-object 方式で不要だった）。②**raster3d は dom にフォールバック** — Phase 1 は GL シーン未実装のため実効 raster3d も dom 描画。③**3D の正準書き出し未対応** — foreignObject は preserve-3d/WebGL 非対応、ブラウザ内 readPixels 取り込みは Phase 2。④**camera zoom/POI のタイムライン KF UI 未配線**（Inspector 静的編集のみ）。⑤**one-node の XY truck**は再センタリングと両立するが、厳密な AE 挙動の調整は Phase 2 ストラタム整備時に再検証。⑥**zoom↔焦点距離↔fov の AE 厳密換算**は未確定（filmSize 連動 UI 未実装）。
- **インフラ**: `npm install` 時の transitive deps 脆弱性警告（dev/build 由来・実行時影響なし・`npm audit` 精査推奨）/ IndexedDbFs.list は全 key 取得 → IDBKeyRange 最適化余地（§11.1）。

> ~~§27 Blur 回帰~~ — **2026-06-20 解消**（`rasterizeFilteredImage` が CSS filter token を捨てていた。filter chain 全体を `<image>` の CSS filter property へ。[test/rasterCapture.test.ts](test/rasterCapture.test.ts) で lock）。

---

## Next steps（次のセッションでやること）

**優先順位: 既知バグ修正（**動画 bundle もっさり含む**）> 手動回帰 > 新機能。**

0. **§11.7 HTML bundle — MP4 入りコンポの再生もっさり（優先度高）** — 動画 Footage 入り comp を HTML bundle 書き出し → player 再生で preview より重い。Preview 経路と同じ `previewVideoPlayback` + `video.play()` 方式に揃えれば治りそう（[videoElementSync.ts](src/runtime/videoElementSync.ts) / [BundlePlayer.ts](src/player/BundlePlayer.ts) / [DomRenderer.ts](src/runtime/DomRenderer.ts)）。`verify-video-import-edges.mjs` の preview 系 + bundle player 実機で before/after 計測。MP4 export 側は [doc/issue/video-footage-export-sluggish.md](doc/issue/video-footage-export-sluggish.md) で別追跡。
1. **手動回帰（残）** — §25 Preview（直接操作・ズーム・オーバーレイ・animated KF 書き戻し）/ §24 Ease パネル（F9 メニュー・グラフエディタとの SSoT 共有）。
2. **verify スクリプト更新** — `verify-preview-cache.mjs` / `verify-effects.mjs` を現行 UX（cache 既定 OFF・project ロード手順）に合わせて修正。
3. **§27 INV-2 export parity** — SVG 5 種（wave/ripple/turbulent/wipe）の preview↔export ピクセル検証。Issue B / fastTurbulent centroid チューニング。
4. **§27.4 調整レイヤー follow-up** — multi-pass flush 厳密化 / precomp ネスト Live 調整 export。
5. **ディストーション phase/speed/direction スキーマ** — 設計判断（Claude Code）後に実装。
6. **M5 Phase 2+ Web Bundle** / **Timeline Tier B–D**（~~ラベル色~~/solo/lock/shy・~~ブレンドモード~~/トラックマット・モーションブラー）/ **グラフエディタ Phase 2/3**（per-axis カーブ・空間モーションパス・速度グラフ）。いずれも spec 追記 + INV 評価が前提。
7. **3D Phase 2（plan: `~/.claude/plans/3d-dom-3d-webgl-3d-soft-meadow.md`）** — 共有 Three.js シーン1個 / `raster3d`（レイヤー→テクスチャ板、静的キャッシュ＋スケール時再ラスタ）/ `scene3d` メッシュコンポーネント / カメラ共有（perspective+view）/ **2D 層のカメラ免除（two-stratum）** / **正準3D書き出し（GL readPixels を z 合成）**。`three` を遅延ロード。Phase 3 = ライト/DOF/オービットギズモ。
8. **§23.3d 派生 phase 2（ユーザー確認待ち・着手前に仕様化必須）** — (a) collapse ON opt-in（ネスト調整レイヤーが親 comp 下位層へ染み出すモード・レイヤー単位）。(b) 強制ラスタライザ opt-in（`forceRaster?` 等の §5 スキーマ追加で決定論的ラスタ出力をユーザーが選べるフォールバック・HTML export 不要層向け）。どちらも INV/§5 変更を伴いうるため、着手前に選択肢＋推奨案を提示してユーザー確認を取ること。

### 参考: 先取り済みの境界
- **INV-7**: `@mafter/runtime` 単一核（resolve / Renderer / module loader / expression / 再生クロック）。preview / exporter / web bundle player が共有。
- **INV-8**: web bundle player は実時間・別の決定論クラス（マスタークロック=音声）。
- **§19 パネルシステム**: `LayoutNode` 直列化ツリー。レイアウト状態は project.json に入れない（§19.3・localStorage 永続）。

### §27.4.1 / §19.5 合成順序モデル（設計確定済み）
canvas 化結果は以降から見て通常の背面ピクセルと等価（zOrder 昇順単一規則）/ precomp は non-collapse 固定 / Raster 出力を確定境界（上の live は再計算なし）/ export = multi-pass flush（zOrder 昇順・各 raster ポイントで背面 capture・depth≤4）。PipelinePanel が live/raster 経路と崖を可視化。

---

## 開発方針

- 「先に spec（SSoT）→ 次に実装」を厳守。散文を根拠にスキーマを変えない。
- INV / §5 スキーマ / project.json 直列化形式の変更は事前にユーザー確認（選択肢＋推奨案）。
- 自動テスト緑だけでは UI 品質を保証しない。視覚・パリティ系は Playwright + Chromium 実機検証を併用（`window.__mafterEditorStore` 経由。dynamic import は別 Zustand インスタンスになる点に注意）。
- 新規スコープを広げる前に既知バグを潰す。

---

### 2026-06-24（Cursor）— ラベル色パレットに旧ベージュ追加

- **index 16**: 旧 LayerBar 既定色 `#b89b6a` をパレット 17 色目として追加（`LabelIndex` 0–16 に拡張）。パレット表示名「ベージュ（旧デフォルト）」。

### 2026-06-24（Cursor）— ラベル色バー連動 + 種別デフォルト

- **§21.10.2b 種別既定ラベル色**: `defaultLabelIndexForObject` + `cmdAddObject` で新規レイヤーに `labelIndex` 自動付与（Solid=0, Text=1, Footage=2, Null=4, Adj=5, Camera=7, HTML/Comp=9, fallback=14）。
- **LayerBar / SourceGhostBars**: 固定茶/青を廃止し `timelineBarFill(labelIndex)` に連動。パレット「なし」は中立グレー（種別既定に戻らない）。
- **検証**: `test/layerLabels.test.ts` / `test/cmdAddObjectLabel.test.ts` / `verify-layer-rename-label.mjs` PASS。

### 2026-06-24（Cursor）— レイヤーパネル拡充（リネーム + ラベル色）

- **§21.9 レイヤー名リネーム**: Timeline `LayerRow` ダブルクリック→インライン編集、Inspector ヘッダ input。`store.renameObject`（`renameComposition` 対称・undo 可）。§5 `name` はスキーマ不変。
- **§21.10 / §5.4c ラベル色**: `SceneObject.labelIndex`（0–15、AE 16 色パレット）追加。左端 4px 色バー + パレットポップアップ。複数選択時は一括適用。`resolve`/export 非影響（エディタ UI のみ）。`src/editor/layerLabels.ts`。
- **検証**: `test/layerLabels.test.ts` + `serialize` labelIndex roundtrip / typecheck 緑 / Playwright `verify-layer-rename-label.mjs` PASS。

### 2026-06-24（Cursor）— 波形ズーム解像度修正 + Footage 削除

- **波形解像度（§11.5.1）**: 曲全体を固定 4096 バケットに圧縮→可視区間へ写像していたため、長尺ソースでズーム時にバケットが枯渇し波形が潰れる不具合を修正。`computePeaksForFrameRange` / `computePeaksForSampleRange` を追加し、`WaveformOverlay` が decode 済みバッファから**可視ソース区間をバー幅ピクセル数で直接ピーク化**する方式へ変更（ズームで解像度が上がる）。spec §11.5.1 散文更新（§5/INV 不変）。
- **Footage 削除（§20.2b）**: Project パネルの audio/image 行に × ボタン＋確認ダイアログ。`store.removeAsset` が asset 削除・参照レイヤーの全 comp 横断カスケード削除・FS 掃除・audio バッファ/波形キャッシュ evict を 1 undo command で実行。spec §20.1/§20.2b 追記。
- **検証**: 365 tests / typecheck 緑。Playwright 実機（30s WAV・旧方式 137 vs 新方式 500 バケット・canvas 956px・`removeAsset` で asset/layer 消滅）+ `verify-audio.mjs` 無回帰 PASS。

### 2026-06-24（Claude Opus）— グリフ分解リグレッション修正 + boxHeight + ボックスリサイズギズモ

- **グリフ分解リグレッション（commit 06e9fa9）**: Phase 1 でレンダラを anchor 相対（glyph 絶対 local x = `g.x`）に直したが `layoutGlyphsForDecompose` が旧 0 基準（`g.x - bounds.minX`）のままで、中央/右寄せテキストの分解が横ズレ。生の `g.x` を使うよう修正＋分解グリフの `boxWidth/boxHeight` を 0 リセット（box 引き継ぎで選択枠が膨らむのを防止）。実機 before==after で確認。
- **boxHeight（§5/§26.1 追加）**: `boxHeight: AnimatedProp<number>`（0=自動高さ, >0=固定でクリップ）。`computeTextContentBounds` が box の maxY を boxHeight or 内容で返す。[textRender.ts](src/runtime/textRender.ts) は boxHeight>0 で `overflow:hidden`。store/builtinComponents/Inspector（Box Height 行）配線。**builtinComponents は Phase2/3 で未更新だった align justify/boxWidth も今回登録**。
- **ボックスリサイズギズモ（§26.3.3）**: `boxWidth>0` のテキスト選択時、ギズモを scale → boxResize に切替（破線枠で区別）。8 ハンドルが boxWidth/boxHeight を編集、反対辺を comp 空間で固定し左/上辺で position 補正。
  - [previewViewer.ts](src/editor/previewViewer.ts) `resizeBoxFromOppositeEdge`（`positionForFixedLocalPoint` 再利用）。
  - [PreviewViewerOverlay.tsx](src/editor/panels/PreviewViewerOverlay.tsx) boxResize モード（横ハンドル=boxWidth のみ/縦=boxHeight のみ で自動高さ保持）。ライブは previewOverride、確定は updateObject（[PreviewPanel.tsx](src/editor/panels/PreviewPanel.tsx) の onComponentPreview/Commit）。
  - **bounds バグ修正**: `resolveTextPropsAtFrame` のサンプル対象キーに `boxWidth/boxHeight` が無く、ギズモ bounds が箱でなく内容幅になっていた（→ リサイズ起点が狂う）。キー追加で修正。
- **検証**: typecheck / 406 tests / build。Playwright: `verify-text-box-gizmo.mjs`（E=幅+自動高さ維持・S=高さのみ explicit・W=左伸長で posX 補正 PASS）、`verify-decompose.mjs`（before==after 維持）。
- **Box Edit トグル**: ギズモのボックスリサイズ ⇄ 通常 scale を明示切替（store `boxGizmoEnabled`・既定 ON・非直列化）。Inspector の Box Width/Height 近くにボタン配置（[InspectorPanel.tsx](src/editor/panels/InspectorPanel.tsx)）。overlay は `boxGizmoEnabled && boxWidth>0` で box モード。`verify-box-toggle.mjs` で破線枠の ON/OFF 切替を確認。

### 2026-06-24（Claude Opus）— テキスト整列バグ修正 + ボックステキスト/折返し + justify

- **Phase 1: 整列バグ（commit 4df2301）**: `align` は schema/UI/layout 全層に在ったが、center/right で**ギズモ枠だけ左へズレ文字が動かない**不具合。原因 = ギズモ bounds は align を反映（`minX` 負）するのにレンダラがグリフを常に local 原点 0 へ再正規化していた不一致。**Fix** = [textRender.ts](src/runtime/textRender.ts) `applyDraftText`/`renderPreciseText` でテキスト要素を `bounds.minX` だけ左シフトし、描画矩形を `[minX,maxX]` に置いてギズモと一致（AE point text 相対）。left=minX0 は無変化＝非破壊。preview/export/bundle は同一 DomRenderer 経由で 1 箇所修正でカバー。
- **Phase 2/3: ボックステキスト + justify**: §5/§26.1 スキーマに `boxWidth: AnimatedProp<number>`（0=point text・後方互換、>0=固定幅で折返し）追加、`align` に `"justify"` 追加。
  - [textLayout.ts](src/runtime/textLayout.ts): `wrapParagraph`/`breakLongWord`（空白境界グリーディ折返し・長語char-break・決定論 INV-1）、justify の語間均等配分（非最終行のみ）、box 時 align は箱 [0,boxWidth] 基準、bounds は箱枠。`boxWidth` を全シグネチャ末尾に伝播。
  - [builtinComponents.ts](src/runtime/builtinComponents.ts)/[store.ts](src/editor/store.ts)/[glyphDecompose.ts](src/editor/glyphDecompose.ts)/[InspectorPanel.tsx](src/editor/panels/InspectorPanel.tsx)（Box Width 行 + J ボタン）配線。
- **既知の限定事項**: テキストに**エフェクト**を付けると center/right/box で effect region（[DomRenderer.ts:426](src/runtime/DomRenderer.ts#L426) `offsetWidth` ベース）が負シフト/箱を拾わずズレうる。エフェクト無しテキストは問題なし（follow-up）。
- **検証**: typecheck / 402 tests 緑 / build（player.js 再生成）。Playwright 実機 — Phase1: anchor 固定で L/C/R が実再配置（`verify-text-align.mjs` PASS）。Phase2/3: point=1行・box=折返し複数行・justify が非最終行を箱端まで広げる（`verify-text-box.mjs` PASS）。

### 2026-06-24（Cursor）— レイヤーコピペ parent（Null）リマップ修正

- **§21.7 Duplicate/Paste parent 欠落**: コピー段階（`cloneObject`）は `parent`/`isNull` を正しく保持していたが、`cmdDuplicateObjects` が新 ULID のみ付与し **複製セット内の `parent` を旧 ID のまま残していた**（Null+子をカット→ペーストで dangling → world 座標が親なし扱い、コピー→ペーストで子が元 Null にぶら下がる）。**Fix** = [duplicateObjects.ts](src/editor/duplicateObjects.ts) `duplicateObjectsWithRemap`（セット内 parent→新 ID、comp 内既存 parent 維持、dangling→null）を [commands.ts](src/editor/commands.ts) `cmdDuplicateObjects` から呼ぶ（Ctrl+D / Ctrl+V 共通）。spec §21.7 散文追記（§5/INV 不変）。
- **follow-up（未着手）**: expression `scripts/<objectId>/...` パスは Duplicate 時未リマップ（潜在バグ）。
- **検証**: `test/duplicateObjects.test.ts` 5 件 + Playwright 実機（copy-paste / cut-paste で parentRemapped・worldDelta=0・errors none PASS）。369 tests / typecheck 緑。

### 2026-06-24（Cursor）— ZIP 保存（⬇ zip）が UI と不一致 / 動かないように見える不具合

- **原因（§20.4b `newProject` 導入が契機）**: `onExportZip` が **IndexedDbFs を直接読む**のに **`saveToFs()` でストア→FS フラッシュしない**＋`newProject()` が **メモリだけ切替えて FS に旧 `project.json` / `assets/*` を残す**。典型再現 = 編集後すぐ zip、または New→いいえ 後に zip → ダウンロード内容が画面と無関係（「壊れた」）。`serializeProject` 失敗時も `void saveProject` が握りつぶし zip は古い FS を返す。
- **Fix**: [ProjectPanel.tsx](src/editor/panels/ProjectPanel.tsx) `onExportZip` で `await saveToFs()` → `getFs()` 経由で `exportZip`、エラー UI 表示、ダウンロード anchor を body に付与。[store.ts](src/editor/store.ts) `newProject` で FS 全削除後に正準 `project.json` 書込。
- **予防**: `CLAUDE.md` / `.cursor/rules/mafter-effect-agent.mdc` に「Store 投影と FS 正本の整合」ガイド追記。
- **検証**: Playwright（New discard 後 zip が空 Untitled と一致・旧レイヤー名なし・orphan assets なし）/ typecheck 緑。

### 2026-06-24（Claude Opus）— ネスト comp のブレンド/エフェクトをライブ描画（§23.3a・ラスタ無し）

- **症状**: エフェクト/ブレンドの効いたテキストを含む timeline comp を別 comp にネストすると、外側からはエフェクト・描画モードが効いていないように見えた。
- **原因**: `renderNestedComp`（§23 Phase 1 ライブ経路）が `worldTransform`/`opacity`/`z-index` のみ反映で、トップレベルの `applyEffects`/`applyBlendMode` を呼んでいなかった（片側未配線）。
- **Fix**（[DomRenderer.ts](src/runtime/DomRenderer.ts)・ラスタ無し）:
  1. ネスト comp コンテナに `isolation:isolate`（AE collapse OFF 相当）→ 内部ブレンドを precomp 内に閉じ、export 単一 capture でもネイティブに焼ける（INV-2）。
  2. 各内側 div に `setBlendModeStyle`（トップレベルと共有の純ヘルパへ抽出）で `mix-blend-mode` / dither を適用。
  3. `applyNestedLiveEffects` で `EffectDef.apply` の css/svg ピースを内側 div の `filter` に適用。
- **スコープ（#1 = live filter only で確定）**: live filter（blur/色/glow/Fast* displacement）のみ。
- **注意点（spec §23.3a にも記載）**:
  - **full displacement（wave/ripple/turbulentDisplace）・raster 系 effect は live 非対応** → §28.11 の comp 単位ラスタ経路に依存（ブレンドモード自体は全てラスタ無し）。
  - **3D（preserve-3d）× mix-blend-mode**: CSS 仕様上ブレンドが 3D 文脈を flatten。ネスト内に 3D 層＋ブレンド混在で AE と差が出うる（エッジケース・別途）。
  - **Fast\* displacement の region**: 毎フレーム DOM 再構築のため実測サイズが取れないフレームで SVG filter region クランプが甘くなりうる（通常 filter には無影響）。
- **検証**: typecheck / 393 tests / build 緑。spec §23.3a・§23.5 表更新（§5/INV 不変）。実機ブラウザ確認は未実施（follow-up）。

### 2026-06-24（Cursor）— ZIP 前処理のインライン進行表示

- **UX**: `⬇ zip` の前処理（`saveToFs` → FS 読み込み → JSZip 圧縮）に時間がかかり無反応に見えていた。**Fix** = [zip.ts](src/fs/zip.ts) に任意 `ZipExportProgress` コールバック（list/read/pack）/[ProjectPanel.tsx](src/editor/panels/ProjectPanel.tsx) で `zipBusy`・フェーズ文言・ボタン無効化・§20.4b モーダル連動。spec §20.1/§20.4b 散文追記。
- **検証**: `test/zipProgress.test.ts` + Playwright（`⬇ 準備中…` とフェーズ文言表示 PASS）/ typecheck 緑。

### 2026-06-24（Cursor）— コンポ背景編集を Inspector へ移設（Unity 的選択駆動）

- **§5.6 UI**: Preview ツールバーの `BackgroundControl` を撤去し、**レイヤー未選択時** [InspectorPanel.tsx](src/editor/panels/InspectorPanel.tsx) **Composition** セクション（Background 行 + Size 読取）へ移設。共有 = [BackgroundControl.tsx](src/editor/panels/BackgroundControl.tsx) + [checkerboardStyle.ts](src/editor/checkerboardStyle.ts)。store `setCompBackground` / Preview DomRenderer ライブ反映 effect は不変。
- **§21.4 選択解除**: Escape + タイムライン ruler 左ラベル列空白 click → `selectObjects([])` → Composition インスペクター表示。
- **spec**: §5.6 / §25.2 / §21.4 散文追記（§5/INV/直列化 不変）。
- **検証**: `verify-bg-toggle.mjs` 更新 + typecheck / npm test 緑。

### 2026-06-24（Cursor）— ScrubNumber 適応桁数表示 + Inspector Transform 精度欠落修正

- **症状**: 0.01 未満の値が `0.00` / `0.0` と表示され微調整・KF 編集が不便。Inspector Transform は `propVec3ToDisplay`（`toFixed(1)`）→ `parseFloat` の round-trip で **実データが欠落**していた。
- **Fix**:
  1. [formatScrubDisplay.ts](src/editor/formatScrubDisplay.ts) — 適応桁数 + 末尾ゼロ除去（`0.003`→`0.003`、`1920`→`1920`）。内部値は丸めない。
  2. [ScrubNumber.tsx](src/editor/ScrubNumber.tsx) — 表示を `formatScrubDisplay` に一本化。編集時・title はフル精度。
  3. [InspectorPanel.tsx](src/editor/panels/InspectorPanel.tsx) — `Vec3Row` を `sampleVec3` の number 直渡しに変更。`propVec3ToDisplay` 削除（[store.ts](src/editor/store.ts)）。
- **spec**: §27.7.1 ScrubNumber 数値表示（散文・§5/INV 不変）。
- **検証**: `test/formatScrubDisplay.test.ts` 9 件 + Playwright 実機（opacity `0.003` 表示・KF 保持・position `100.04` PASS）/ 415 tests / typecheck 緑。

### 2026-06-25（Cursor）— コンポジション Inspector 桁表示修正

- **症状**: Composition の Size が `192`×`108` のように末尾桁が欠けて表示。ラベル `Background` も左端が切れる。
- **原因**:
  1. **主因**: `ScrubNumber` の `decimals={0}` 表示で `toFixed(0).replace(/\.?0+$/, "")` が整数末尾ゼロまで除去（`1920`→`192`、`1080`→`108`）。
  2. **副因**: Inspector `Row` ラベル列 52px 不足・ScrubNumber が flex 縮小しうる。
- **Fix**:
  1. [formatScrubDisplay.ts](src/editor/formatScrubDisplay.ts) — `formatScrubFixed` 追加（`decimals===0` は末尾ゼロ除去しない）。
  2. [ScrubNumber.tsx](src/editor/ScrubNumber.tsx) — `formatScrubFixed` 使用、`flexShrink:0`、表示桁数ベース `minWidth`。
  3. [InspectorPanel.tsx](src/editor/panels/InspectorPanel.tsx) — `Row`/`Vec3Row` ラベル 72px、`flexWrap`。
- **検証**: `test/formatScrubDisplay.test.ts`（`formatScrubFixed`）+ Playwright（`1920`/`1080` 全文・Background ラベル PASS）/ 433 tests / typecheck 緑。

### 2026-06-25（Cursor）— アクティブカメラを「最前面の自動カメラ」に（AE 準拠）

- **要望**: コンポ映像に使うカメラがプルダウンで手動固定されていた。AE 同様、その時刻で最前面（最大 zOrder）のアクティブなカメラレイヤーを自動で出力カメラにしたい。
- **確定仕様**（§6.5 更新）:
  - 出力（preview/export 共通）= その frame で `enabled && inPoint<=f<outPoint`（=`isVisible`）を満たす camera レイヤーのうち最大 zOrder。該当無し＝デフォルト視点。`resolve()` 内で自動選択（INV-1/INV-2 維持）。
  - 手動プルダウンは**プレビュー視点専用**（AE の 3D View 相当・非永続）。`ResolveContext.previewCamera?: ObjectId|"default"` で、PreviewPanel だけが渡す。export/bundle/nested は渡さない。
  - `TimelineComposition.activeCamera`（§5）を**削除**。旧 project.json はロード時に無視（[serialize.ts](src/core/serialize.ts) で canonicalize 時に drop）。
- **実装**:
  1. [resolve.ts](src/runtime/resolve.ts) — `activeCameraAt(comp, frame)` export + `ResolveContext.previewCamera` + カメラ選択ブロック書換。
  2. [schema.ts](src/core/schema.ts) / [serialize.ts](src/core/serialize.ts) — `activeCamera` 削除 + 後方互換 drop。
  3. [store.ts](src/editor/store.ts) — `setActiveCamera` → 非永続 `previewCamera` / `setPreviewCamera`（undo 非対象）。comp 切替でリセット。`addCamera` は activeCamera 設定をやめた。
  4. [PreviewPanel.tsx](src/editor/panels/PreviewPanel.tsx) — resolve 4 経路に previewCamera 注入。override 中は RAM キャッシュをバイパス（editingLive 扱い）。
  5. [TimelinePanel.tsx](src/editor/panels/TimelinePanel.tsx) — プルダウンを「View: …」プレビュー視点セレクタ化。CAM● バッジは `activeCameraAt` の自動結果に。
  6. [InspectorPanel.tsx](src/editor/panels/InspectorPanel.tsx) — 「Active」ボタン → 「Preview through」トグル。
- **検証**: `test/resolve.test.ts` にカメラ自動選択・フォールバック・override・INV-2 ケース追加 / 453 tests / typecheck / build 緑。
- **未**: ブラウザ実機での UI 配線（プルダウン・バッジ・プレビュー切替）の目視確認は未実施（ユーザー確認待ち）。

### 2026-06-25（Cursor）— ネスト comp のカメラを live で適用（§23.3b・AE non-collapse 準拠）

- **症状**: カメラ付き comp をネストすると、ライブ preview で平面（オルソ）描画になる。`resolve()` は `childScene.camera` を正しく算出していたが `renderNestedComp` が perspective / per-object view を捨てていた（ラスタ経路のみ正しかった）。
- **Fix**（[DomRenderer.ts](src/runtime/DomRenderer.ts) のみ）:
  1. `setupCameraRig` を抽出し `renderFrame` と `renderNestedComp` で共有（§6.5b 同一リグ）。
  2. `objectWorldTransformWithCamera` ヘルパで 3D 層のみ `cameraPre·world`、2D 層は免除。
  3. カメラ無しネスト comp は `perspective` 未設定＝従来どおり無回帰。
- **spec**: §23.3b 新設 + §23.5 比較表に nested camera 行追加（§5/INV/直列化 不変）。
- **検証**: 453 tests / typecheck 緑。Playwright — `verify-nested-3d-camera.mjs`（ネスト内 perspective・3D パン応答 / 2D 免除 / カメラ無し無回帰 PASS）+ `verify-3d-camera.mjs` 無回帰（`activeCameraSet` 断言撤去＝§6.5 自動カメラ移行後の整合）。

### 2026-06-25（Cursor）— コンポ切替時タイムライン viewRange 競合修正

- **症状**: 親 comp（長尺）から別 comp に切り替えると、レイヤーバーが親 comp の表示尺（`viewRange.end`）のまま配置され、短い comp ではバーが圧縮表示・長い comp では伸びきらない。
- **真因**: [TimelinePanel.tsx](src/editor/panels/TimelinePanel.tsx) の comp 切替 effect（`viewRange` 全リセット）と duration クランプ effect が同一 tick で両方走り、後者が `min(prev.end, duration)` で旧 comp の短い `viewRange.end` を保持していた。
- **Fix**: `prevCompIdRef` で comp 切替を検出し、切替時は `{0, duration}` へ全リセットのみ。duration クランプは同一 comp 内の duration 短縮時のみ実行。
- **検証**: Playwright 実機（150↔300f 切替・full-span レイヤー 100% 幅）PASS / typecheck 緑。

### 2026-06-25（Cursor）— comp レイヤー初期尺を子コンプ duration に合わせる（§23.4a）

- **症状**: 15秒 comp に 5秒 comp を DnD すると、レイヤーバーが親 comp 全尺（15秒）で置かれる。ゴースト（`getLayerSourceExtent`）は子 5秒を示すが `outPoint` が親 duration のまま。
- **Fix**:
  1. [compLayer.ts](src/runtime/compLayer.ts) — `compLayerDefaultOutPoint()` 追加（§23.2 秒ベースで親 frame 換算、`parent.duration` で clamp）。
  2. [store.ts](src/editor/store.ts) — `addCompLayer` の初期 `outPoint` を上記ヘルパに差し替え（`inPoint=0`, `trimStart=0` 既定）。
- **spec**: §23.4a 新設（散文・§5/INV 不変）。
- **検証**: `test/precomp.test.ts`（ヘルパ 4 件 + store 配置尺）/ typecheck 緑 / Playwright（450f 親 + 150f 子 → `outPoint=150` PASS）。

### 2026-06-25（Cursor）— MP4 export 調整レイヤー parity（§27.4.1 / Comp 10）

- **症状**: プレビュー/HTML bundle は正しいが MP4 で Live 調整レイヤー（blur / fastTurbulent）が効かない／弱い。Comp 10（for-debug-data）で再現。
- **真因**: (1) export の `forceAdjustmentRaster` 経路で複数 Live 調整の backdrop capture が **並列起動**（`Promise.all`）し z 順積層が preview compositor と一致しない。(2) foreignObject が `backdrop-filter` / `preserve-3d` 非対応（設計上の export 制約）。
- **Fix**:
  1. [DomRenderer.ts](src/runtime/DomRenderer.ts) — `flushExportComposite()` 追加: 非調整 raster を `flushRasterEffects` で待った後、Live 調整 bake を **zOrder 直列キュー**（`exportAdjustmentQueue`）で実行。`trackRasterWork()` で `forceAdjustmentRaster && isAdjustment` のみ直列化。
  2. 調整 backdrop capture — `captureAdjustmentBackdrop()` + threeD 下位層の snapshot→img 置換（foreignObject 3D flatten 緩和）。
  3. [exporter.ts](src/runtime/exporter.ts) — `flushRasterEffects` → `flushExportComposite` に差替。
  4. 検証 — `verify-comp10-export-parity.mjs`（for-debug-data zip → Comp 10）、`verify-export-adjustment.mjs` に `forceAdjustmentRaster` 追加。
- **検証**: typecheck / 458 tests 緑 / `verify-comp10-export-parity.mjs` PASS（f7 完全一致、f0 export blur 検出）。
- **follow-up**: f100 等で上位数位レイヤー（z>14）が計測域を覆うため edgeStd 比較だけでは偽陽性/偽陰性あり。preview パネル screenshot 比較の強化、§23.3d ネスト内調整 export。

### 2026-06-25（Cursor）— Live 調整 export 経路修正（preview 真・Comp 10 消える問題）

- **症状**: MP4 export で Live 調整レイヤーのエフェクト発動時に下位コンテンツ（3D ネスト comp 等）が消える。通常レイヤー直付け effect は問題なし。preview / HTML bundle は正しい。
- **spec 上の真**:
  - **preview / HTML bundle** = Live 調整の `backdrop-filter` 経路が正（§27.4 INV-2）。
  - **mp4/png** = 見た目は preview と一致すべき。旧 spec の `auto_raster_mp4`（Live 調整を comp 背面 capture へ強制 bake）は、foreignObject が `backdrop-filter` 非対応という前提だったが、**最終 root capture では Chromium で live backdrop が preview と一致**（Comp 10 f100 で実測 0% diff）。
  - **Raster 調整**（`adjustmentMode="raster"`）= 常に capture bake が正。
- **真因**: exporter の `forceAdjustmentRaster: true` が Live 調整を comp 背面 bake + `reapplyAdjustmentSuppression`（下位レイヤー `visibility:hidden`）へ強制。3D ネスト comp の bake が壊れ、調整 canvas だけが残りコンテンツが消えた。
- **Fix**:
  1. [exporter.ts](src/runtime/exporter.ts) — `forceAdjustmentRaster` 削除。Live 調整は preview 同様 `backdrop-filter` + `flushRasterEffects`。
  2. [DomRenderer.ts](src/runtime/DomRenderer.ts) — Raster 調整専用の直列 bake は維持（`shouldSerialExportAdjustment`）。`prepareAdjustmentBackdropForCapture` で multi-pass 時に suppressed 下位を再表示しない（§27.4.1）。
  3. 検証 — `verify-comp10-export-parity.mjs` / `verify-export-adjustment.mjs` を preview↔export ピクセル diff に更新。
- **検証**: typecheck / 458 tests 緑 / Comp 10 f0/f7/f100/f145 diff 0% / 単純 blur 調整 diff 0% / f100 screenshot 目視一致。
- **follow-up**: `auto_raster_mp4` spec 散文（§27.4）を実測結果に合わせて更新検討。foreignObject で live backdrop が効かないケースの parity 検出→フォールバック bake。

### 2026-06-25（Cursor）— Live 調整 export 経路修正 → **未解消**（issue doc 更新）

- **ユーザー確認**: 「消える」症状は直ったが **調整レイヤー effect が MP4 で効かなくなった**。
- **整理**: foreignObject は `backdrop-filter` 非対応 → bake（`forceAdjustmentRaster`）が必要。現行は bake を外したため effect 欠落。旧 bake は 3D ネスト comp で壊れて「消える」。
- **trade-off**: A=live backdrop（effect ✗ / 表示 ✓） vs B=bake（effect ✓ / 表示 ✗ when broken）。目標は B を直して exporter に戻す。
- **検証の誤り**: `verify-comp10-export-parity.mjs` が同一 offscreen 経路同士比較で 0% — Preview パネル vs MP4 の一致を証明していなかった。
- **記録**: [doc/issue/mp4-live-adjustment-layer-parity.md](doc/issue/mp4-live-adjustment-layer-parity.md) を現状に合わせて更新（状態=未解消）。

### 2026-06-25（Sonnet）— MP4 Live 調整 parity **解消**（bake 復帰 + 真因＝3D flatten 除去）

- **方針**: bake 経路 B を復帰（ユーザー確認済み）。getDisplayMedia 案は INV-2 非決定性リスクで不採用。
- **実機局在化（empirical, debug-visual-render-bug）** — Comp 10 f100 を 3 経路で capture し真因を特定:
  - A `forceAdjustmentRaster:false`（旧）: blue diamond **写る**（blueRatio 0.069）→ **foreignObject は 3D ネスト comp を焼ける**（doc の「foreignObject 3D 非対応」前提は誤り）。
  - B `forceAdjustmentRaster:true`（bake 現状）: **grey 一色・content 消失**（blueRatio 0）。
  - flatten を切ると B = blueRatio 0.126（content 復活 + effect 適用）。
  - **真因**: `snapshotThreeDSubtreesBelow`（3D 下位 subtree を capture→img 置換）が **それ自体コンテンツを空 img に潰していた**。flatten こそが「消える」原因だった。
- **Fix**:
  1. [exporter.ts](src/runtime/exporter.ts) — `forceAdjustmentRaster:true` 復帰 + `flushRasterEffects`→`flushExportComposite`（MP4 / PNG 連番 両経路）。
  2. [compFrameCapture.ts](src/runtime/compFrameCapture.ts) — 同種欠陥（RAM Preview / precomp raster / bundle bake が `flushRasterEffects` のみ）を同様に修正。
  3. [DomRenderer.ts](src/runtime/DomRenderer.ts) — `snapshotThreeDSubtreesBelow` / `hasNestedCameraRig` / `data-has-camera-rig` マーカーを**全削除**。`captureAdjustmentBackdrop` は root を直接 capture（foreignObject が 3D も焼く）。
  4. 検証スクリプト — `verify-comp10-export-parity.mjs` / `verify-export-adjustment.mjs` を **実 Preview パネル screenshot vs export(bake)** に書換（旧版は同一 offscreen 経路同士で無意味）。判定は pixel-diff ではなく **中央走査線 std（効果シグネチャ）**（消失時 export std が崩れる／pixel-diff は blank の方が小さく出るため不適）。Preview 取得用に PreviewPanel に `data-testid="preview-canvas-root"` 追加。
- **検証**: typecheck / 458 tests 緑 / `verify-comp10-export-parity.mjs` PASS（f100 export std 2.9→23.9 ≈ preview 30）/ `verify-export-adjustment.mjs` PASS（blur ぼけ縁 mid=96）/ 回帰 verify 全 PASS（verify-nested-3d-camera, verify-3d-camera, verify-export-bake, verify-export-filter, verify-fast-export-parity, verify-comp19-adjustment）/ f100 export 画像で content+blur 目視確認。
- **follow-up**: §27.4 spec 散文の「foreignObject は preserve-3d 非対応 → 3D 個別 capture 必要」記述が実測と矛盾（root capture で 3D も焼ける）。spec 更新は §5/INV 不変なので Cursor 主導で可。

### 2026-06-25（Opus）— MP4 Live 調整の**ちらつき**を構造解消（export 合成をオフDOMへオーバーホール）

- **症状**: bake 復帰後 effect は乗るが MP4 が**ちらつく**（ユーザー報告・`for-debug-data/Comp_10 (2).mp4`）。
- **真因**: bake（`forceAdjustmentRaster`）は毎フレーム **live DOM を破壊操作**（`visibility` トグル + raster overlay + `holdLastRaster`/`frameRenderCache` 使い回し + 直列キュー）。非同期競合で前フレーム状態が次フレームのキャプチャに混入 → ちらつき。
- **方針決定（ユーザー確認）**: デプロイは**ブラウザのみ**（静的・バックエンドなし）→ ヘッドレス Chromium 正準書き出し（spec §16/M3.5, A 案）はクライアント不可。getDisplayMedia（B 案）は実時間/解像度/精度で不適。→ **C1: ブラウザ内のまま、export 合成を live DOM 非破壊・ステートレスに作り直す**。
- **実装**:
  1. [exportComposite.ts](src/runtime/exportComposite.ts)（新規） — `compositeExportFrame`: 毎フレーム fresh に z 昇順で累積 master canvas を組み、調整レイヤー到達点で master（=確定背面）に effect chain を適用。調整/blend 無しなら単一ショット root capture（3D 深度保持）の高速経路。
  2. [effectRaster.ts](src/runtime/effectRaster.ts)（新規） — `applyFilterChainToBuffer`（旧 DomRenderer.applyCssSvgFilterToBuffer を pure 化、live/export 共有）。
  3. [DomRenderer.ts](src/runtime/DomRenderer.ts) — `exportCompositeMode` 追加（true 時、調整レイヤーは live DOM を触らず effect chain を `entry.exportChain` に保存するだけ）。`getExportLayers()` / `hasAdjustmentLayers()` 追加。
  4. [exporter.ts](src/runtime/exporter.ts) / [compFrameCapture.ts](src/runtime/compFrameCapture.ts) — `forceAdjustmentRaster`→`exportCompositeMode`、`flushExportComposite`→`flushRasterEffects`、capture を `compositeExportFrame` に一本化。
- **raster effect**: レイヤ直付け raster は従来どおり自前 canvas に焼かれ単体キャプチャが拾う。調整 raster（displacement 含む）は master に既存 helper を pure 適用。両方 export で焼ける（f100 で目視確認）。
- **検証**: typecheck / 458 tests / build 緑。`verify-comp10-export-parity.mjs` 書換（**ちらつき＝フレーム間状態リーク検査**: seq[1 renderer 順次] vs iso[frame ごと新 renderer] の diff。stateless なら 0%）→ **f82–100 全フレーム seqVsIso=0.000%**（＝ちらつき根絶）+ parity OK + f88/f100 目視で content+effect 確認。回帰 verify 全 PASS（export-adjustment / export-bake / export-filter / fast-export-parity / 3d-camera / nested-3d-camera / comp19-adjustment）。
- **未削除（意図的・低リスク優先）**: `forceAdjustmentRaster` フラグ + bake pipeline（`runAdjustment*Pipeline` / `captureAdjustmentBackdrop` / `flushExportComposite` / `exportAdjustmentQueue`）は **live preview の displacement / raster-mode 調整経路と entangle** しているため残置。`forceAdjustmentRaster` はどこからも true にされず（export は `exportCompositeMode` を使う）ちらつき経路は再活性化しない。完全削除は `effectRouting.ts` / `adjustmentMode.test.ts` に波及するため follow-up（要回帰確認）。

#### 追補（同日 Opus）— 調整フレームで**カメラがちらつく**バグも修正

- **症状**: 上記オーバーホール後、調整 effect/opacity は安定したが、**カメラ(perspective)が効くフレームと効かないフレームが断続的に出る**（ユーザー報告）。
- **真因**: perspective / perspective-origin / preserve-3d は **root** に付き、preview では全レイヤがその perspective root の子。初版 compositor は調整フレームでレイヤを **root から切り離して個別 capture** していたため 3D 層の perspective 射影が落ち、`hasAdjustmentLayers()` が in/out で切り替わるたびに fast path(root 一括=カメラ有り) と slow path(per-layer=カメラ無し) が交代 → カメラのちらつき。
- **実機局在化**（`verify-diag-capture.mjs`）で f100 を計測: root 一括 capture=std37.1（カメラ正）/ per-layer 無 perspective=std70.1（カメラ落ち）/ **per-layer を root と同じ perspective ラッパで包む=std37.1（root と pixel 一致）**。
- **修正**: [exportComposite.ts](src/runtime/exportComposite.ts) を **per-layer + perspective ラッパ**方式に変更（`captureLayerWithPerspective`: 各レイヤを `perspective`/`perspective-origin` = root と同値の div に入れて capture）。2D 層は perspective 無影響、3D 層は正しく射影。blend は `globalCompositeOperation`、調整は master に chain 適用。調整も blend も無いフレームは root 一括 capture の高速経路。
- **検証**: typecheck / 458 tests / build 緑。`verify-comp10-export-parity.mjs` に **camera 保持検査**追加 → f100 で per-layer+persp std=37.1 == root std=37.1（rel 0.0% / pixel diff 0.00%）＝カメラ完全保持。ちらつき seq≡iso=0.000% 継続。f100 export 目視でコンテンツが perspective 射影＋blur されているのを確認。回帰 verify 全 PASS（export-bake / export-filter / fast-export-parity / 3d-camera / nested-3d-camera / export-adjustment / comp19-adjustment）。

#### 追補（2026-06-26 Opus）— **ネスト comp 内の調整レイヤーが export で焼けない**バグも修正

- **症状**: Comp 19 → Comp 10（調整5枚=blur/fastTurbulentDisplace）をネストした状態で **Comp 19 を書き出すと、子 Comp 10 内の調整 effect が適用されない**（preview では効くが mp4/png で消える・ユーザー報告 `for-debug-data/Comp_20.mp4`）。
- **真因**: ネスト comp は `renderNestedComp` で live 描画され、子の調整は CSS `backdrop-filter`。親 export の `compositeExportFrame` は子 comp を**1枚の通常レイヤーとして foreignObject capture** していたため、§27.4 と同じ理由で **`backdrop-filter` が落ちて子の調整が消える**。さらに調整専用 comp は `compNeedsAutoPreviewCache` の raster 対象でないため preview rasterizer でも拾われない。exporter は nestedCompRasterizer も持たない。
- **修正方針（spec §27.4.1 軸1「precomp は1枚に合成・確定してから親が1レイヤーとして扱う」に準拠）**: ネスト comp が（再帰的に）調整を含むなら、**子 comp 自身の座標系で同じオフDOM・ステートレス z 順コンポジタに掛けて1枚へ確定**してから親へ置く（再帰・depth ≤ 4）。**何段ネストしても**各段で調整が確定する。
- **実装**:
  1. [effectChain.ts](src/runtime/effectChain.ts)（新規） — `resolveEffectChain`（pre/raster/post の token・svg defs・rasterChain 構築を純関数化）。top-level `applyEffects` とネスト export タグ付けで共有（chain が2本にならない・INV-2）。
  2. [DomRenderer.ts](src/runtime/DomRenderer.ts) — `applyEffects` を `resolveEffectChain` へ集約。`renderNestedComp` は `exportCompositeMode` 時、調整 div に `backdrop-filter` を立てず **解決済み chain を `div.__exportLayer`** に、コンテナに **`__nestedComposite` + `data-nested-composite` 属性**を付与。`frameHasNestedComposite` / `hasNestedComposite()` 追加（高速経路の除外判定）。
  3. [exportComposite.ts](src/runtime/exportComposite.ts) — `compositeContainer`（コンテナを子座標系で z 順合成）+ `captureLayerNode`（レイヤ subtree に composite 必要なネスト comp があれば、子を先に確定 → **クローン側でコンテナ中身を確定画像 `<img>` に差し替え**てから capture・live DOM 非破壊）を相互再帰。fast path 判定に `hasNestedComposite()` を追加。
- **検証**: typecheck / 458 tests / build 緑。新 `verify-comp19-nested-export.mjs`（恒久・回帰用）で **新経路 `compositeExportFrame` vs 旧高速経路 `captureElementToCanvas(root)`（=backdrop 落ち）を対照**: Comp 19 f0/f100 + **WRAP→19→10 の depth-2** すべて PASS（子の blur が焼け flat はシャープ＝旧バグ・edge↓最大75.5%・目視確認）。`hasNestedComposite=true`。回帰 verify 全 PASS（comp10-export-parity の flicker 0%/camera 保持・nested-3d-camera・3d-camera・export-adjustment・export-bake・export-filter・fast-export-parity・comp19-adjustment preview backdrop）。
- **carve-out**: 調整も CSS blend も持たないネスト comp は従来どおり親の単一 capture に含めて焼く（3D 文脈保持の高速経路・無回帰）。

### 2026-06-25（Cursor）— 実装ループスキル化 + エージェントプロンプト追記

- **要請**: 直近の修正メソッド・思考フレームワーク・一連の流れを抽象化し、新機能/バグ修正時にエージェントが参照する統合ループとしてスキル化。
- **追加**: [.claude/skills/implementation-loop/SKILL.md](.claude/skills/implementation-loop/SKILL.md) — Phase 0–5（progress/spec → スコープ → 影響地図化 → 最小実装 → Playwright+経路間 parity → 固定・記録）。バグは経路分解、視覚系は `debug-visual-render-bug`、エフェクトは `implement-visual-effect`、新型は `add-layer-component-type` へ分岐。
- **プロンプト追記**: [CLAUDE.md](CLAUDE.md)「実装ループ（必須スキル）」、[mafter-effect-agent.mdc](.cursor/rules/mafter-effect-agent.mdc) 実装ワークフロー Phase 番号化 + バグ修正時スキル分岐表、[implementation-loop.mdc](.cursor/rules/implementation-loop.mdc)（要約ルール）、[debug-visual-render-bug.mdc](.cursor/rules/debug-visual-render-bug.mdc) から親ループへのリンク。下位 3 スキルに親参照を追加。

### 2026-06-25（Cursor）— 実装ループのプロンプト隔離

- **要請**: ループ本体が `CLAUDE.md` / `alwaysApply` ルールに重複してシステムプロンプトを汚染しないよう隔離。
- **変更**: 正本は `.claude/skills/implementation-loop/SKILL.md` のみ（一貫性ゲート・Playwright 手順・抽象要請の確認をスキルへ移設）。`CLAUDE.md` / `mafter-effect-agent.mdc` / `implementation-loop.mdc` / `debug-visual-render-bug.mdc` は**ポインタのみ**に縮小。ループ更新はスキルファイルだけ編集すればよい。

### 2026-06-26（Cursor）— 動画 Footage インポート（image と同型 UX）

- **要請**: 画像インポートと同じバイブスで動画を読み込み・タイムライン配置できるようにする。
- **実装**:
  - [videoAssetProbe.ts](src/runtime/videoAssetProbe.ts) — import 時 `width`/`height`/`duration`/`mime` を probe
  - [imageAssetCache.ts](src/runtime/imageAssetCache.ts) — `loadFromProject` で video を blob URL 読み込み、`evictAsset` / `registerPreviewImageCache`
  - [store.ts](src/editor/store.ts) — `importVideoAsset` / `addVideoLayer`（ソース尺で `outPoint` 自動トリム）、`removeAsset` に video 許可
  - [ProjectPanel.tsx](src/editor/panels/ProjectPanel.tsx) / [TimelinePanel.tsx](src/editor/panels/TimelinePanel.tsx) — `+ Video`、DnD、OS ドロップ
  - [builtinComponents.ts](src/runtime/builtinComponents.ts) — `VIDEO_COMPONENT_DEF`
  - [DomRenderer.ts](src/runtime/DomRenderer.ts) — video に `fit`（objectFit）適用
  - spec §11.4 / §20.1 / §20.2b 散文更新（§5 非変更）
- **検証**: `npm run typecheck` 緑、`test/videoAssetProbe.test.ts` 追加、459 tests（`previewPlaybackLoop` 1件は既知フレーク）、`verify-video-import.mjs` PASS
- **エッジケース検証（追補）**: `verify-video-import-edges.mjs`（12項目 PASS）— +Video ボタン / Footage クリック配置 / blob キャッシュ / 再生トグル / 1回再生停止 / **レイヤーカット（in·out + trimStart）** / **途中スクラブ・途中から再生**。ユニット: `test/videoLayerOutPoint.test.ts`・`imageAssetCache` video blob
- **スコープ外（別タスク）**: export 時 `requestVideoFrameCallback` による seek 精度改善、動画内蔵音声

### 2026-06-26（Cursor）— HTML bundle：MP4 入りコンポの再生もっさりを優先タスク化

- **ユーザー要請**: MP4 が入ったコンポジットを HTML bundle で書き出すと再生がもっさる件を、優先度高めで progress に記録。
- **記録先**: 「既知のバグ・未解決課題」+ Next steps **#0（優先度高）**。想定修正方針 = Preview 経路と同様の `previewVideoPlayback`（`video.play()` でネイティブ decode）に揃える。
- **未着手**（実装・verify は次セッション）。

### 2026-06-26（Cursor）— 動画 preview 再生のもっさり感修正

- **症状**: 動画レイヤー入りコンポの再生が、通常コンポより重く・カクついて感じる。
- **真因**: DomRenderer が毎フレーム `video.currentTime` で seek していた。さらに 0.05s 閾値のため 30fps では約2フレームに1回しか更新されず、見た目も15fps相当に。
- **修正**: [videoElementSync.ts](src/runtime/videoElementSync.ts) — preview 再生中は `video.play()` でネイティブ decode に任せ、停止/スクラブ/export は半フレーム閾値で seek。`setPreviewRenderOptions({ previewVideoPlayback })` を PreviewPanel / BundlePlayer から配線。
- **検証**: `test/videoElementSync.test.ts` 7件、`verify-video-import-edges.mjs` 12/12 PASS

### 2026-06-26（Cursor）— 動画レイヤー export（foreignObject + もっさり修正）

- **症状**: 動画入りコンポの書き出しでブラウザ標準の video プレイヤー UI が出る。修正後は映像は出るが書き出し動画がもっさり。
- **真因（UI）**: SVG `foreignObject` は `<video>` を描画できない → clone 側でフレームを img 化が必要。
- **真因（もっさり）**: `waitForVideoFrame` が `readyState` だけ見て seek 完了前に capture → 古いフレームを繰り返し焼く。加えて毎フレーム full-res PNG インライン + 二重 wait で export が重い。
- **修正**:
  - [rasterCapture.ts](src/runtime/rasterCapture.ts) — `inlineVideoFrames`（clone のみ img 化）、`inlineExportMedia`
  - [videoElementSync.ts](src/runtime/videoElementSync.ts) — `waitForVideoFrame`: `seeking` → `seeked` → `requestVideoFrameCallback`（rVFC 未応答時 400ms フォールバック）
  - [DomRenderer.ts](src/runtime/DomRenderer.ts) — `flushVideoFrames()`、`controls=false`
  - export 経路（[exporter.ts](src/runtime/exporter.ts) / [compFrameCapture.ts](src/runtime/compFrameCapture.ts)）で capture 前に `flushVideoFrames`
  - インラインは表示サイズ + JPEG（二重 wait 削除）
- **もっさり追補（export play-step）**:
  - `exportVideoStep` — 連続フレームは `play()` でデコードを進め、逆行・大ジャンプのみ seek（毎フレーム seek の 400ms+ を回避）
  - `waitForVideoFrame(video, targetSec)` — ターゲット時刻に乗るまでポーリング + rVFC
  - exporter / compFrameCapture で `exportVideoStep: true`
- **検証**: `test/videoElementSync.test.ts` 12件、`verify-video-export.mjs` PASS（avg ~139ms/frame、以前 ~472ms）。**ユーザー手動確認は未解消** → [doc/issue/video-footage-export-sluggish.md](doc/issue/video-footage-export-sluggish.md)

### 2026-06-26（Claude Opus）— 動画 export ちらつき（戻り進み）・もっさり 真因修正 ✅

- **症状（更新）**: export play-step 後、出力が「戻ったり進んだりちらつく」「もっさりより悪化」（ユーザー報告）。
- **真因1（ちらつき = 前後振動）**: `exportVideoStep` の `play()`。play は**実時間進行**のため export ループの離散フレーム処理とズレ、ターゲットを行き過ぎ→逆行 seek→再度行き過ぎ、でキャプチャフレームが前後に振動。INV-2（フレーム決定論）違反。
  → **修正**: `syncVideoElementExportStep` を `play()` 廃止し**各フレーム決定論 seek**に（[videoElementSync.ts](src/runtime/videoElementSync.ts)）。
- **真因2（もっさり = 1/3 フレーム重複）**: フレーム境界 `k/fps` ちょうどへの seek は float 丸めで currentTime が境界をわずかに下回り、**前フレームが選ばれる**（k≡2 mod 3 等で毎3フレーム重複 → 実質20fps化）。タイムベース 1/15360 で `2/30*15360=1023.99…→floor 1023→frame1`。
  → **修正**: `videoSeekTargetSec(target, fps) = target + 0.5/fps`（**フレーム区間中央へ seek**）。scrub（preview 停止）と export 双方で共有＝preview↔export 同一フレーム表示（INV-2 単一の正）。
- **真因3（stale capture）**: `waitForVideoFrame` が seek 直後の古い present で resolve。
  → **修正**: `waitPresentedFrame` で rVFC の `mediaTime ≈ target` を満たす present まで待機（present budget 300ms フォールバック）。
- **スコープ**: 変更は `videoElementSync.ts` のみ（export step / scrub seek / present wait）。preview **再生**（`play()`）は不変。`rasterCapture` / `DomRenderer` / `exporter` は無変更。
- **検証**:
  - `test/videoElementSync.test.ts` 14件 PASS、`npm test` 全 479 PASS、typecheck 緑。
  - **新規 `verify-video-export-monotonic.mjs`**（恒久）: 連続フレームを順に書き出し `<video>.currentTime`／フレーム間差分を測定し **reversals=0・stuckFrames=0・onTarget=25/25** を確認。旧 `verify-video-export.mjs` は静的な劣化アセット（`video_test.mp4` 自体が旧プレイヤーUIバグの焼き込み＋ほぼ静止）で**動き検出が無効**だったため、ffmpeg `testsrc2` で生成した動く素材 `for-debug-data/video_motion.mp4`（`ffmpeg -f lavfi -i testsrc2=size=1280x720:rate=30:duration=3 -pix_fmt yuv420p`）を使用。`VERIFY_VIDEO` で差し替え可。
  - 既存 `verify-video-export.mjs` PASS（playerUi=0%・非blank 無回帰）。
- **残（別タスク・symptom B）**: 1フレーム ~320ms は foreignObject ラスタ化（~290ms）が主因で本修正と独立。高速化は「video を foreignObject 外で直接 canvas 合成 / WebCodecs」案（issue §未試行 #1/#2）。出力の動き（symptom A）は解消。

### 2026-06-26（Cursor）— Project Bin v1（仮想フォルダ・単一ツリー）

- **要請**: AE 型 Project パネルで comp/footage を仮想フォルダ（Bin）で整理。v1 は Bin ツリーのみ（font import / Replace Footage は Phase 2）。新規 import / +Comp / +HTML は常にルート直下。
- **スキーマ（additive・ユーザー承認済）**: `Project.bins` / `Project.treeOrder` / `CompositionMeta.binId` / `AssetEntry.binId`（resolve・compRef・asset 参照は ULID のまま非接触）。
- **実装**:
  - [projectTree.ts](src/core/projectTree.ts) — ツリー純関数（create/delete/move/register、`ensureProjectTree`、`treeOrderIsRedundant`）
  - [serialize.ts](src/core/serialize.ts) — `bins` id 昇順、`treeOrder` ユーザー順保持、既定順と同じ `treeOrder` は省略（byte 等価）
  - [validate.ts](src/core/validate.ts) — bin 循環検出、未知 `binId` warn + root 化
  - [store.ts](src/editor/store.ts) — `createBin` / `renameBin` / `deleteBin` / `moveProjectEntries`、既存 add/import/remove に tree 配線
  - [ProjectTreeView.tsx](src/editor/panels/projectTree/ProjectTreeView.tsx) — 単一ツリー、検索、フォルダ CRUD、DnD（フォルダへドロップ）、Timeline DnD 維持
  - [projectBinStorage.ts](src/editor/projectBinStorage.ts) — フォルダ開閉 localStorage
  - [ProjectPanel.tsx](src/editor/panels/ProjectPanel.tsx) — `ProjectTreeView` 置換、Plugins は下部固定
  - spec §5 / §20.5 / §5.6-canon 追記
- **検証**: `npm run typecheck` 緑、`test/projectBins.test.ts` 7件、`npm test` 486 PASS（roundtrip / canonical-edge 回帰なし）
- **Phase 2（v1 外）**: `importFontAsset`、`replaceAsset`、行間 DnD 並べ替え、OS→Project 直接 DnD、Playwright 実機 verify スクリプト

### 2026-06-26（Cursor）— Expression プリセット: Oscillate / Pulse

- **要請**: wiggle に加えオシレーション（position Y 軸 sin）とパルス（scale 均一 sin）の Inspector プリセットを追加。
- **実装**:
  - [expressionPresets.ts](src/editor/expressionPresets.ts) — 3 プリセット定義・`@mafter:preset` marker・脚本テンプレート
  - [expressionModuleHub.ts](src/editor/expressionModuleHub.ts) — Preview/store 共有 ModuleLoader + `invalidateExpressionPath`
  - [store.ts](src/editor/store.ts) — `applyExpressionPreset` / `disableExpression`（`addWiggleExpression` 置換）
  - [InspectorPanel.tsx](src/editor/panels/InspectorPanel.tsx) — Expression 折りたたみに 3 ボタン・active 判定
  - [PreviewPanel.tsx](src/editor/panels/PreviewPanel.tsx) — 共有 expression loader 経由
  - spec §9 散文追記、`test/expr.test.ts` に marker / 評価テスト
- **検証**: `npm run typecheck`、`npm test`（expr プリセットテスト含む）

### 2026-06-27（Cursor）— Pulse Scale 波形プルダウン

- **要請**: pulse scale インスペクタで波形形状をプルダウン選択（KF 不要）。
- **実装**: [expressionPresets.ts](src/editor/expressionPresets.ts) — `waveform` enum（sine / triangle / square / sawtooth・非アニメ）+ 脚本の波形分岐。`ensurePresetScript` を正本同期（既存 FS も起動時更新）。[InspectorPanel.tsx](src/editor/panels/InspectorPanel.tsx) `ExpressionPresetFields` に enum 行（Effect 同型）。`test/expressionPresetInstance.test.ts` に waveform 注入・形状テスト追加。
- **検証**: `npm test` expressionPresetInstance 7 PASS / typecheck 緑。

### 2026-06-27（Cursor）— Pulse Scale 波形プルダウンが効かない 修正

- **症状**: Waveform を変えてもプレビューが sine のまま。
- **真因 (2)**: (1) `makeEvaluator(comp)` が comp をクロージャ固定 → Inspector で `expressionPresets.props` を更新しても評価時は古い props。(2) 脚本更新後 `ModuleLoader` キャッシュ未破棄 → 旧 pulse-scale.js（波形分岐なし）が動き続ける。legacy 表示は readOnly で enum 変更が migrate デフォルトのみ。
- **修正**: `makeEvaluator(comp, resolveComp?)` + PreviewPanel で store から live comp 参照。`ensurePresetScript` 書込時に `invalidateExpressionPath`。legacy enum 変更は migrate 時に選択波形を `propsOverrides` で渡す。
- **検証**: `test/expressionPresetInstance.test.ts` live props テスト追加・typecheck 緑。

### 2026-06-27（Cursor）— Pulse Scale Bend +/-（Serum 風位相ワープ）

- **要請**: のこぎり等の波形に対し Bend -/0/+ でランプを凹/直線/凸に歪める（Serum BEND +/- 相当）。
- **実装**: [expressionPresets.ts](src/editor/expressionPresets.ts) — `bend` scalar（-1..1・KF 可・既定 0）。`bendPhase(t,bend)` = bend>0 なら `t^(1/(1+bend))`（急上昇→緩やか）、bend<0 なら `t^(1-bend)`（緩やか→急上昇）。全 waveform の周期位相 `t` に適用後に形状評価。
- **検証**: sawtooth で bend+ > neutral > bend- を単体テスト固定。

### 2026-06-27（Cursor）— Bend 視認性改善（強度 4x + 波形プレビュー）

- **症状**: Bend を動かしてもプレビュー上で効いているか分かりにくい。
- **修正**: (1) `bendPhase` の指数を `PULSE_BEND_GAIN=4` で強化（±0.5 でも明確な差）。(2) [pulseScaleWave.ts](src/runtime/pulseScaleWave.ts) に数学を集約し脚本・UI・テストで共有。(3) Inspector Pulse Scale に **1 周期 SVG プレビュー**（緑=変調曲線・赤=現在位相・sawtooth 推奨表示）。スクラブ中は previewOverride を反映。
- **検証**: `test/pulseScaleWave.test.ts` 3件・typecheck 緑。

### 2026-06-27（Cursor）— Pulse Scale Phase / Polarity + Bend 細スクラブ

- **要請**: Bend を 0.1 倍細かくスクラブ / Phase 360°+ オフセット / Polarity 反転。
- **実装**: `phase`（°・KF 可・min 0・上限なし）`polarity` enum（`+`/`-`）追加。[pulseScaleWave.ts](src/runtime/pulseScaleWave.ts) `pulseCycleT`・`polaritySign`。Bend 行のみ `ScrubNumber speed=0.1`（1px=0.1）。プレビューに φ°・polarity 表示。
- **検証**: `test/pulseScaleWave.test.ts` 5件・typecheck 緑。

### 2026-06-28（Cursor）— Orbit Position エクスプレッション追加

- **要請**: 実用的なエクスプレッションをもう 1 個追加。
- **実装**: `orbit-position` — 基準位置を中心に円運動。パラメータ: `radius`（既定 80）/ `frequency`（既定 0.5 Hz）/ `phase`（°・KF 可）。既存 `ctx` API のみ・ランタイム変更なし → `build:player` 不要。
- **検証**: `test/expressionPresetInstance.test.ts` orbit 2件・`test/expr.test.ts` marker 更新・11+27 tests PASS。

### 2026-06-29（Opus）— コンポ BPM 併記表示（非破壊・編集補助・§21.1b）

- **要請**: コンポに BPM/beatsPerBar を持たせ、タイムラインの時間表示に `Bar.Beat` を併記（音楽 MV 編集補助）。
- **設計**: `bpm`/`beatsPerBar` を `CompositionMeta` に additive。表示専用メタで `resolve()`/export/bundle 非参照（INV-1/2/3/5 不変）。spec §5.6 + §21.1b 追記（SSoT 先行）。
- **実装**:
  - [schema.ts](src/core/schema.ts) `CompositionMeta` に `bpm?`/`beatsPerBar?`。
  - [serialize.ts](src/core/serialize.ts) `stripBpmMeta`（bpm 無効=両キー省略=byte 等価 / 既定 beatsPerBar=4 省略）を **timeline・html 両分岐**に適用。
  - [validate.ts](src/core/validate.ts) `validateCompMeta` を**全 comp**（timeline/html）で実行（負/非数 bpm strip・bpm=0 で beatsPerBar 落とし・不正 beatsPerBar→4）。
  - [beatTimecode.ts](src/editor/beatTimecode.ts) 純関数 `formatBarBeat`/`formatTimeWithBeat`。拍境界の浮動小数誤差を epsilon でスナップ（frame 60@120BPM/30fps → "2.1"）。
  - [store.ts](src/editor/store.ts) `setCompBpm`/`setCompBeatsPerBar`（command・undo 可・bpm 無効時 beatsPerBar no-op）。
  - [InspectorPanel.tsx](src/editor/panels/InspectorPanel.tsx) Composition に BPM 行（+ライブ bar.beat）/ Beats per Bar 行（bpm>0 時のみ）。
  - [TimelinePanel.tsx](src/editor/panels/TimelinePanel.tsx) toolbar 現在時刻・右上 current/duration・ルーラー目盛り（薄色付加）の 3 箇所で併記。
- **添削で直した懸念**: ① validate がタイムライン comp しか回らない → 全 comp meta パス追加。② canonicalize の bpm 省略を両分岐に。③ `beats % beatsPerBar` の FP 誤差 → epsilon。④ 9px ルーラーのクラッタ → bar.beat を薄色化。
- **検証**: `test/beatTimecode.test.ts`(7)・serialize byte 等価(3)・validate 正規化(3) 追加。`npm test` 526 PASS・typecheck 緑。実機 [verify-bpm-timeline.mjs](verify-bpm-timeline.mjs) で BPM トグルの併記出現/消滅・3/4 拍を確認（PASS）。
- **build:player**: 不要（ランタイム非変更・`playerBuildFreshness` 緑）。
- **スコープ外**: 拍/小節スナップ・ルーラー拍単位切替・Preview 併記・downbeat offset。

### 2026-06-29（Opus）— BPM ルーラー二段表示

- **要請**: bpm≠0 のとき時間ルーラーを上下二分割（上=タイムコード / 下=BPM の Bar.Beat）。表示のみでタイムライン挙動は不変。
- **実装**: [TimelinePanel.tsx](src/editor/panels/TimelinePanel.tsx) `Ruler` を二段化。上段=従来タイムコード目盛り（bpm 有効時は高さ 50%）／下段=**拍に整列した独自 Bar.Beat 目盛り**（拍/小節単位で適応間引き・小節頭は明色・中央分割線）。bpm 無効時は従来どおり単段。spec §21.1b 更新。
- **検証**: typecheck 緑・実機 [verify-bpm-ruler.mjs](verify-bpm-ruler.mjs) で下段 Bar.Beat 目盛り（1.1/1.3/2.1…）描画・bpm=0 で単段化を確認。toolbar 併記（formatTimeWithBeat）は従来どおり維持。

### 2026-06-29（Opus）— BPM ルーラー目盛り密度アップ

- **要請**: 広い範囲を見ているときも BPM をもう少し細かく表示。
- **実装**: [TimelinePanel.tsx](src/editor/panels/TimelinePanel.tsx) `Ruler` の下段拍目盛りの密度目安を `viewSpanBeats / 8` → `/ 16`（上段タイムコードより細かく）。全尺 60s でも 2 小節ごと（1.1/3.1/5.1…）まで表示・重なりなしを実機確認。

### 2026-06-29（Cursor）— ⬆ zip インポート時の保存確認（§20.4b 拡張）

- **要請**: `New` と同様に、別プロジェクト zip を開く（`⬆ zip`）前にも「保存しないと失われます」確認を出す。
- **実装**: spec §20.4b を `New` / `⬆ zip` 共通に更新。[ProjectPanel.tsx](src/editor/panels/ProjectPanel.tsx) で `discardConfirmAction`（`new` | `import`）に統合し、`ProjectDiscardConfirm` モーダルを共有。`はい`＝zip 保存後に続行（import はファイル選択）、`いいえ`＝保存せず続行、`キャンセル`＝中止。
- **build:player**: 不要（UI のみ）。
