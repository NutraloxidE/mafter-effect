# Progress

> AIエージェントはセッション開始時にこのファイルを読み、終了時に更新すること。
> 完了済みの詳細はコミット履歴を正とし、ここは「現在地・残タスク・既知バグ・次の一手」に絞る。
> （2026-06-20 に compact 済み。古い詳細な更新履歴は git log を参照。）

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

現行: **393 tests PASS** / typecheck ✅ / build ✅（2026-06-24・§26.3.2 同梱フォント実装）。

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
- **インフラ**: vite LAN 公開 / `deploy:ssh`（.env・パスワード認証・Caddy 自動構成・`root@ssh.gycp.party` 配備済み）/ `cursor-agent` 委任ハーネス（delegate-to-cursor skill）。

---

## 既知のバグ・未解決課題

- **§27.3 SVG 5 種の export 一致（INV-2）未検証**: wave/ripple/turbulent/linearWipe/angularWipe の preview↔export ピクセル parity（feImage href が foreignObject ラスタ経路で再現するか）。pixelSorter は検証済み。
- **Issue B（[doc/distortion-effect-bugs.md](doc/distortion-effect-bugs.md)）**: turbulent プレビュー左端グレー枠の歪み漏れ。未着手。
- **Issue C / fastTurbulent centroid**: 強 amount で centroid ~6–8px ドリフト残（[effectRouting.ts](src/runtime/effectRouting.ts) で self-capture raster 統一後も残るチューニング課題）。
- **ディストーション phase/speed/direction（要設計判断・スキーマ追加）**: AE Ripple/Wave Warp の Ripple Phase（伝播アニメ）・Wave Speed/Type/任意角度 Direction が現状 param 未公開。effects params スキーマ追加になるため Claude Code 設計待ち（`rippleDisplaceMap` は `phaseDeg` を既に受けられる）。
- **§26.4 Draft/Best 残差（許容済み）**: DOM vs SVG 経路差で 100% ピクセル一致は非目標（実測 ≤2px・実用上問題なし）。
- **§28.11 export/bundle parity（follow-up）**: precomp comp 単位ラスタは現状ライブ preview + RAM Preview のみ。`exporter.ts` / `bundleBake.ts`（runtime）へ rasterizer 未注入のため、ファイル export ではネスト comp 内 effect が §23 Phase-1（非焼き込み）のまま。`resolve()` 出力は一致（INV-2 の literal は保持）だがピクセル一致は §27.3 と同じ tracked follow-up。runtime→editor 依存を避けるため optional param 経路で後日配線。
- **調整レイヤー export follow-up**: §27.4.1 multi-pass flush の厳密 sequential 化（積層調整の export 順序）/ precomp ネスト内 Live 調整の export auto_raster（compFrameCapture へ option 未配線）/ RAM preview cache の Live 調整 fidelity。
- **verify スクリプト未整合**: `verify-preview-cache.mjs`（cache 既定 OFF 後の Realtime 期待）・`verify-effects.mjs`（project ロード前提）が現行挙動と FAIL。要更新。
- **3D Phase 1 の意図的な制約（Phase 2 で対応）**: ①**2D 層のカメラ免除は Phase 1.1 で実装済み**（per-object 焼き込みで 3D 層のみカメラ応答・2D は固定＝AE 準拠。当初懸念した特異点/ two-stratum 分離は per-object 方式で不要だった）。②**raster3d は dom にフォールバック** — Phase 1 は GL シーン未実装のため実効 raster3d も dom 描画。③**3D の正準書き出し未対応** — foreignObject は preserve-3d/WebGL 非対応、ブラウザ内 readPixels 取り込みは Phase 2。④**camera zoom/POI のタイムライン KF UI 未配線**（Inspector 静的編集のみ）。⑤**one-node の XY truck**は再センタリングと両立するが、厳密な AE 挙動の調整は Phase 2 ストラタム整備時に再検証。⑥**zoom↔焦点距離↔fov の AE 厳密換算**は未確定（filmSize 連動 UI 未実装）。
- **インフラ**: `npm install` 時の transitive deps 脆弱性警告（dev/build 由来・実行時影響なし・`npm audit` 精査推奨）/ IndexedDbFs.list は全 key 取得 → IDBKeyRange 最適化余地（§11.1）。

> ~~§27 Blur 回帰~~ — **2026-06-20 解消**（`rasterizeFilteredImage` が CSS filter token を捨てていた。filter chain 全体を `<image>` の CSS filter property へ。[test/rasterCapture.test.ts](test/rasterCapture.test.ts) で lock）。

---

## Next steps（次のセッションでやること）

**優先順位: 既知バグ修正 > 手動回帰 > 新機能。**

1. **手動回帰（残）** — §25 Preview（直接操作・ズーム・オーバーレイ・animated KF 書き戻し）/ §24 Ease パネル（F9 メニュー・グラフエディタとの SSoT 共有）。
2. **verify スクリプト更新** — `verify-preview-cache.mjs` / `verify-effects.mjs` を現行 UX（cache 既定 OFF・project ロード手順）に合わせて修正。
3. **§27 INV-2 export parity** — SVG 5 種（wave/ripple/turbulent/wipe）の preview↔export ピクセル検証。Issue B / fastTurbulent centroid チューニング。
4. **§27.4 調整レイヤー follow-up** — multi-pass flush 厳密化 / precomp ネスト Live 調整 export。
5. **ディストーション phase/speed/direction スキーマ** — 設計判断（Claude Code）後に実装。
6. **M5 Phase 2+ Web Bundle** / **Timeline Tier B–D**（~~ラベル色~~/solo/lock/shy・~~ブレンドモード~~/トラックマット・モーションブラー）/ **グラフエディタ Phase 2/3**（per-axis カーブ・空間モーションパス・速度グラフ）。いずれも spec 追記 + INV 評価が前提。
7. **3D Phase 2（plan: `~/.claude/plans/3d-dom-3d-webgl-3d-soft-meadow.md`）** — 共有 Three.js シーン1個 / `raster3d`（レイヤー→テクスチャ板、静的キャッシュ＋スケール時再ラスタ）/ `scene3d` メッシュコンポーネント / カメラ共有（perspective+view）/ **2D 層のカメラ免除（two-stratum）** / **正準3D書き出し（GL readPixels を z 合成）**。`three` を遅延ロード。Phase 3 = ライト/DOF/オービットギズモ。

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
