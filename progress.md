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

現行: **355 tests PASS** / typecheck ✅ / build ✅（2026-06-23）。

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
6. **M5 Phase 2+ Web Bundle** / **Timeline Tier B–D**（ラベル色/solo/lock/shy・ブレンドモード・トラックマット・モーションブラー）/ **グラフエディタ Phase 2/3**（per-axis カーブ・空間モーションパス・速度グラフ）。いずれも spec 追記 + INV 評価が前提。
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
