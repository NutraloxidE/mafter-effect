# Progress

> AIエージェントはセッション開始時にこのファイルを読み、終了時に更新すること。
> 完了済みの詳細なバグ修正履歴は要約済み。コード詳細は spec（SSoT）と git log を正とする。

---

## 現在のマイルストーン状態

| マイルストーン | 状態 |
|---|---|
| M0 Foundations | ✅ 完了 |
| M1 Core animation + DomRenderer | ✅ 完了 |
| M2 HTML comp + expression | ✅ 完了 |
| M3 Export | ✅ 完了（実機 export 9/9 検証済み） |
| M4 Plugin API v1 | ✅ 完了（実機検証済み 14/14） |

**MVP = M0–M4 全マイルストーン実装・実機検証完了。** その後 §20 Project パネル / §21 Timeline AE化 / §22 グラフエディタ / §23 precomp を MVP 後 UX として拡張中。

現行テスト: **186 件全通過** / typecheck ✅ / build ✅（2026-06-19）。

---

## 完了済みタスク（要約）

### M0 Foundations（2026-06-15〜16 完了, spec v0.3 同期済み）
project.json schema（[schema.ts](src/core/schema.ts)）/ 正準シリアライズ（[serialize.ts](src/core/serialize.ts), RFC 8785/JCS + NFC 正規化）/ FileSystem 抽象（[MemoryFs](src/fs/MemoryFs.ts) / [IndexedDbFs](src/fs/IndexedDbFs.ts)）/ 決定論 zip（[zip.ts](src/fs/zip.ts)）/ 作成・読込・validate・マイグレーション。
- **受け入れ**: 作成→保存→再読込→zip→再import が byte 等価（roundtrip.test.ts）。日本語名/zip/float の round-trip 緑化。
- **方針確定**: optional は「値があれば書く・機能不在はキー省略」。`saveProject` は updatedAt を自動 bump しない（command 層で実変更時のみ）。

### M1 Core animation + DomRenderer（2026-06-16 完了）
- **`@mafter/runtime` 境界（INV-7）** — [src/runtime/](src/runtime/)。React/Zustand/UI 非依存、外部依存は `../core/schema` の型のみ。preview / exporter / bundle player の共有核。契約: [runtime/README.md](src/runtime/README.md)。
- 凍結した核: `Mat4`（column-major, [mat4.ts](src/runtime/mat4.ts)）/ `ResolvedScene`・`Renderer` interface / easing（cubic-bezier ソルバ）/ interpolate（成分線形 + clamp + hold）/ `resolve()`（純関数 INV-1, parent チェーン畳み込み・§6.3 合成順・camera viewMatrix）。
- DOM/UI: [DomRenderer.ts](src/runtime/DomRenderer.ts)（flat matrix3d + opacity + z-index + reconcile）/ Zustand [store.ts](src/editor/store.ts)（正は IndexedDbFs）/ [commands.ts](src/editor/commands.ts)（before/after スナップショット undo・**全編集 immutable** が load-bearing 不変条件）/ [WorkspaceLayout.tsx](src/editor/WorkspaceLayout.tsx)（LayoutNode 再帰描画・localStorage 永続化, project.json を汚さない §19.3）/ Preview・Timeline・Inspector・Project パネル。
- **M1→M2 凍結ゲート**: background INV-3 違反除去 / expression 評価シームを `resolve(comp, frame, ctx?)` に凍結（additive）/ undo snapshot 方式確定 / DomRenderer reconcile 化 / scale-to-fit。

### M2 HTML comp + expression（2026-06-16 完了, 実機検証済み）
- **§9 Expression**: [exprHelpers.ts](src/runtime/exprHelpers.ts)（seededRandom=mulberry32 / wiggle / remap, 全純関数）/ [moduleLoader.ts](src/runtime/moduleLoader.ts)（FS→Blob→createObjectURL→dynamic import, ネガティブキャッシュ付き）/ [expressionEngine.ts](src/runtime/expressionEngine.ts)（async prepare → sync evaluator, throw→fallback §9）。
- **§7 HTML Composition (Model A)**: [htmlComp.ts](src/runtime/htmlComp.ts) `HtmlCompPlayer`（Shadow DOM 隔離・inPoint 相対 frame）。DomRenderer に `html` 型サポート。
- **実機修正（型/単体テストで検出不能だった致命バグ）**: ModuleLoader がオブジェクト default export を拒否していた（→ 関数/オブジェクト両対応）/ HTML comp 配置 UI・expression 付与 UI 欠落を補完。Playwright で Shadow DOM・per-frame render・wiggle アニメート・決定論を確認。

### M3 Export（2026-06-16 完了, 実機 export 9/9 PASS）
- [exporter.ts](src/runtime/exporter.ts): Project+compId+FS+config → Blob（mp4 / webm / png-seq）。オフスクリーン DomRenderer で preview と同一パイプライン（INV-2 担保）。DOM→raster は SVG foreignObject + Shadow DOM flatten。WebCodecs VideoEncoder + mp4-muxer/webm-muxer、非対応は PNG-seq フォールバック。音声は OfflineAudioContext mix → AudioEncoder → muxer。[ExportDialog.tsx](src/editor/ExportDialog.tsx)。
- **実機で発見・修正した致命バグ**: tainted canvas（blob: URL → data: URL に変更で解決）/ AVC level 固定（解像度から動的算出 `avcCodecString`）/ HW エンコーダ強制（isConfigSupported フォールバック）。`VideoEncoder` の headless クラッシュは GL backend 起因（`--use-gl=angle --use-angle=swiftshader` で安定）→ 実 Chrome では発生しない見込み。
- **Opus レビュー後のバグ修正計 7 件**: PNG-seq/webm alpha 無視 / buildAudioMix の不要実行 / DomRenderer html unmount 漏れ / PreviewPanel wiggle チラつき / サブレンジ音声 A/V sync ズレ。

### M4 Plugin API v1（2026-06-16 完了, 実機 14/14 PASS）
- **§12 フル登録 API**: [plugin.ts](src/runtime/plugin.ts)（型）/ [pluginRegistry.ts](src/runtime/pluginRegistry.ts)（`globalPluginRegistry`・`activate`・`getComponentDef`/`getExprHelpers`/`getEasings`）。DomRenderer・ExpressionEngine が registry を lazy 参照。store に `loadPlugins`/`installSamplePlugin`/`togglePlugin`/`addPluginObject`。pluginRefs は project.json に永続化 → loadFromFs 時に自動ロード。
- **サンプル plugin**: gradient-rect（width/height/colorA/colorB/angle, 全 animatable）。
- 留意点: plugin `ComponentDef.render` は host div の**子要素**に適用。keyframe easing は `{ type: "linear" }`（`kind` ではない）。

---

## MVP 後の UX 拡張（実装済み）

### §20 Project パネル / コンポジション管理（spec v0.4, スキーマ不変, 実機 13/13）
AE の Project パネル化。store に `addTimelineComp`/`removeComposition`（最後の timeline comp 保護・root 張り替え・html comp の FS 掃除）/`renameComposition`。ProjectPanel = Compositions / Footage / Plugins の倉庫ビュー。PreviewPanel にコンポタブ。データモデルに新フィールドは足さず UI 層 + store 規約で実現。

### §21 Timeline AE化 — Tier A + P0 + P1（spec v0.5〜0.7, スキーマ不変, 実機検証済み）
[TimelinePanel.tsx](src/editor/panels/TimelinePanel.tsx)。詳細作業計画は [doc/timeline-panel-wip.md](doc/timeline-panel-wip.md)。
- **Tier A**: SMPTE タイムコード（non-drop, INV-5 保持）/ 時間ルーラー+プレイヘッド / プロパティツリー+ストップウォッチ+インライン値編集+KF ダイヤ行 / レイヤーバー drag（in/out トリム・スライド・footage 源オフセット連動）。実バグ修正: graphRef 未接続で px→frame 変換が無効化していた。
- **§21.5 KF 複数選択**: ラバーバンド（全レイヤー/プロパティ横断・中心 hit-test・Shift 追加）/ まとめて移動・削除 / ハイライト。`cmdUpdateObjects`/`updateObjects`（複数オブジェクト 1 undo）。
- **§21.6 U/UU キー**: U=KF ありプロパティのみ展開 / UU=変更済みのみ。物理キー `e.code` 併用で IME 環境対応。
- **§21.7 Duplicate(Ctrl+D)/Split(Ctrl+Shift+D)**: footage 系の source offset 連動。
- **P0**: Ctrl+スクロールズーム / Shift+パン / `\`=fit all / 下部スクロールバー / `isPlaying` をストア昇格 / KF 右クリックでイージングメニュー（F9=Easy Ease 等・ダイヤ色で easing 種別）/ ←→ フレーム移動・J/K で前後 KF。
- **P1**: レイヤー DnD 並べ替え（zOrder 降順ソート・再採番, 上=#1）/ 複数レイヤー選択（Shift 範囲・Ctrl トグル）/ component props の animatable KF 行（PropPath を string 拡張）/ スナップ（再生ヘッド/秒境界/端に ~10px 吸着）/ KF・レイヤーのコピー/カット/ペースト（AE 準拠の文脈分岐: KF 選択中は KF・それ以外はレイヤー / ペーストは再生ヘッド基準 / `flashStatus` フィードバック）。

### §22 グラフエディタ Phase 1（spec v0.7, スキーマ不変, 実機検証済み）
ツールバー 📈 で値カーブレーンに切替。実サンプラでカーブ描画（hold/オーバーシュート反映, Vec3 は x/y/z 色分け）。KF 点ドラッグで時間+値編集 / ベジェハンドルで区間 easing 編集（linear→bezier 自動変換・y クランプ無し）。参照軸=|Δ|最大。1 操作 1 undo（`setPropByPath`）。`GraphLane` コンポーネント。
**未実装（Phase 2/3）**: ① per-axis 値カーブ（Vec3 軸独立カーブ=`Keyframe<Vec3>` per-axis easing override の additive スキーマ要）② 空間モーションパス（spatial tangent + resolve 補間拡張 + INV-1/2 再検証）③ 速度グラフ ④ グラフ内 KF 追加/削除・ラバーバンド ⑤ opacity 等の値域クランプ。詳細は spec §22.0。

### §23 comp layer (precomp) Phase 1（スキーマ不変, 実機検証中）
Project パネルの timeline/HTML comp を draggable 化（DnD 必須）。`store.addCompLayer(compId)` + BFS 循環参照検出。DomRenderer に `setTimelineComps`/`renderNestedComp`（depth≤4, non-collapse 相当）。`resolve()` が `comp` type に `_inPoint` を注入 → childFrame = clamp(parentFrame - inPoint + trimStart, 0, duration-1) で Freeze 挙動。spec §23 追記。
- **2026-06-18 (Cursor)**: comp レイヤーの split/左端トリムで `trimStart` 連動（§21.3 相当・AE 準拠）。タイムラインにトリム済み源のゴースト表示（comp/html/video/audio）。
- **2026-06-18 (Cursor)**: 自動検証追加 — `test/precomp.test.ts`（14 件）+ `src/runtime/compLayer.ts` 純関数抽出。✅ Freeze 時間マッピング / ✅ 循環参照 BFS 拒否（store 統合含む）/ ✅ depth≤4 ガード / ✅ resolve `_inPoint` 注入。comp-in-comp **描画**はユーザー確認済み。

### インフラ / デプロイ（2026-06-17）
- `vite.config.ts` に `server.host = true`（LAN 公開）。
- `scripts/deploy-ssh.mjs` + `npm run deploy:ssh`: SSH ホストへ `dist` 転送（`--build`/`--clean`/`--identity`/`--port`）。`.env`（`DEPLOY_HOST`/`DEPLOY_PASSWORD` 等）対応で無引数実行可。パスワード認証は sshpass / plink+pscp 自動選択。配備後 Caddy コンテナで 80/443 自動待受（`DEPLOY_SITE_HOST` で HTTPS, `--no-serve` で無効）。`.env` は `.gitignore` 済み。
- `scripts/claude-auto-continue.ps1`: 500 検知で `続けて` を stdin 送出。

---

## 進行中・未完了タスク

### §23 precomp Phase 1 — 残（手動のみ）
- [x] **Freeze** 時間マッピング — `test/precomp.test.ts` + `compChildFrame()` で自動検証済み
- [x] **循環参照拒否** — BFS + `store.addCompLayer` 統合テストで自動検証済み
- [x] **depth 制限（≤4）** — `isCompNestDepthAllowed()` 単体テストで自動検証済み
- [x] comp-in-comp **描画** — ユーザー確認済み
- [ ] **Playwright 実機 E2E**（DnD 配置・ネスト描画のブラウザ回帰）— 未セットアップ。ロジック面は上記でカバー済み

### §24 Flow 風イージングプリセットパネル（spec v0.8・Phase 1 スキーマ不変・**実装済み 2026-06-18**）
仕様は spec §24 に確定。[EasePanel.tsx](src/editor/panels/EasePanel.tsx) + 共有モジュール群。
- [x] **パネル登録** — 右カラム tabs `[inspector, ease]`（§19.3 localStorage 永続・project.json 非汚染）
- [x] **EasePanel** — カーブプレビュー/エディタ + 数値入力 + プリセットグリッド + default/user セット + ★保存 + in/out/both + APPLY
- [x] **組み込みプリセット** — [builtinEasingPresets.ts](src/editor/builtinEasingPresets.ts) §24.4 全件
- [x] **適用ロジック** — [easingApply.ts](src/editor/easingApply.ts) + `test/easingApply.test.ts`（7 件）。KF 選択は store `selectedKfKeys` でタイムラインと共有
- [x] **★保存** — [easingPresetFs.ts](src/editor/easingPresetFs.ts) → `presets/easing/<id>.json`
- [x] **回帰（自動）** — typecheck / **107 tests PASS** / build ✅
- [ ] **回帰（手動）** — §21 F9 メニュー・§22 グラフエディタとの SSoT 共有をブラウザで確認

### §25 Preview ビューア編集（spec v0.9・スキーマ不変・**実装済み 2026-06-18**）
spec §25 に確定。AE コンポビューア相当の編集機能を Preview に実装。
- [x] **§25.1 ビューア制御** — viewZoom/viewPan、Ctrl+ホイール（カーソルアンカー）、スペース/中ボタン パン、Fit/Fit≤100%/100%/%ドロップダウン
- [x] **§25.2 オーバーレイ** — 透明チェッカー / セーフマージン / グリッド・中心十字・定規 / 解像度プロキシ（表示専用・INV-2 不変）
- [x] **§25.3 直接操作** — 選択 bbox＋8 ハンドル scale＋回転＋移動＋アンカー点（先頭 1 レイヤー）
- [x] **§25.4 座標逆算** — [previewViewer.ts](src/editor/previewViewer.ts) 純関数 + `test/previewViewer.test.ts`（11 件）
- [x] **§25.5 KF 書き戻し** — animated→現 frame KF / static→value（§21.2 同一規約）
- [x] **§25.6 再生コントロール** — 1フレーム前後 / 末尾へ / ループ / タイムコード直接入力
- [x] **§25.7 永続化** — [previewViewerStorage.ts](src/editor/previewViewerStorage.ts) localStorage（comp ごと可）、project.json 非汚染
- [x] **回帰（自動）** — typecheck / **119 tests PASS** / build ✅
- [ ] **回帰（手動）** — ブラウザで直接操作・ズーム・オーバーレイ・animated KF 書き戻し確認
- **将来**: ガイド線ドラッグ / マスク・シェイプ オンキャンバス編集 / モーションパス / チャンネル・スナップショット / ROI

### §26 テキストレイヤー本実装（spec v0.10・**実装済み 2026-06-18**）
spec §26 に確定。`text` builtin ComponentDef 登録 + Inspector Text セクション + Draft/Best 品質切替 + SVG アウトライン + グリフ分解 + export 方式選択。
- [x] **§26.1 スキーマ** — `addText` 既定値（tracking/leading/weight/italic/stroke）。静的 props は raw 値、animatable は AnimatedProp。
- [x] **§26.2 builtin ComponentDef** — [builtinComponents.ts](src/runtime/builtinComponents.ts) + Timeline PropRow kind 拡張（string/color/enum/bool）。
- [x] **§26.3 Inspector Text** — [InspectorPanel.tsx](src/editor/panels/InspectorPanel.tsx) + [ColorSwatch.tsx](src/editor/ColorSwatch.tsx)。編集中 draft 自動降格。
- [x] **§26.4 品質モード** — Preview Draft/Best トグル + [previewViewerStorage.ts](src/editor/previewViewerStorage.ts) 永続化。[textRender.ts](src/runtime/textRender.ts) **Draft=DOM（分解前の正）** / Best=SVG（DOM line box に baseline 合わせ）。[fontOutlineCache.ts](src/runtime/fontOutlineCache.ts) + opentype.js。
- [x] **§26.4.2 キャッシュ IF** — [frameRenderCache.ts](src/runtime/frameRenderCache.ts) no-op。
- [x] **§26.5 グリフ分解** — [glyphDecompose.ts](src/editor/glyphDecompose.ts) + store `decomposeGlyphs` + Inspector ボタン。
- [x] **§26.6 補間** — `sampleRgba` + string hold（[interpolate.ts](src/runtime/interpolate.ts)）。
- [x] **§26.7 Export** — ExportDialog テキスト描画方式 + DomRenderer `textRenderMode`。
- [x] **回帰（自動）** — typecheck / **136 tests PASS** / build ✅
- [x] **回帰（手動・部分 2026-06-18）** — ユーザー確認: Undo ✅ / グリフ分解 ✅ / Draft↔Best 切替 ✅（**わずかな誤差あり・実用上問題なし**）/ 位置 KF アニメ ✅ / export（precomp・テキスト・MP4/PNG）Playwright 確認 ✅
- [x] **既知バグ潰し（ブロッカー）解消 2026-06-18** — §26.4 Draft/Best 「位置が一致しない」根因を特定・修正。**根因**: `PreviewPanel` の renderer は comp 準備後に生成されるが、`effectiveTextQuality→setTextQuality` effect は値不変時 re-run しないため、生成された renderer に "draft" が届かず DomRenderer 既定 "precise" のまま固定 → **Draft 切替が無効化し常に SVG 描画**だった。修正: `textQualityRef` を導入し renderer 生成時に `setTextQuality(textQualityRef.current)` を適用（[PreviewPanel.tsx](src/editor/panels/PreviewPanel.tsx)）。**検証**: Playwright ピクセル差分で left/center/right/multiline/96px/stroke 全件 draft↔best が AA バンド相当（330〜1084/128000、位置ズレなら数千px差）→ グリフ実体が縦横・baseline・leading とも整合を実機確認。export は `setTextQuality` を生成後明示呼びで無影響。
- [x] **§25 × §26 Preview 四隅 scale ハンドル** — 2026-06-18 手動確認で **solid 同等に修正済み**（Canvas bounds + ドラッグ起点相対 scale）。
- **将来（§16）**: 段落ボックステキスト / 文字単位混在スタイル / パステキスト / 範囲セレクター式アニメーター / tracking 1/1000em / フォントセレクト UI / レイヤー個別品質 / レンダーキャッシュ実体

### §27 エフェクト & 調整レイヤー（spec v0.11・**実装完了 2026-06-19**）

- [x] **スキーマ（§5.5b）**: `EffectInstance` / `SceneObject.effects?` / `isAdjustment?`（[schema.ts](src/core/schema.ts)）
- [x] **基盤（§27.1/§27.2）**: [plugin.ts](src/runtime/plugin.ts) `EffectDef` / [pluginRegistry.ts](src/runtime/pluginRegistry.ts) / [builtinEffects.ts](src/runtime/builtinEffects.ts)（blur/tint）
- [x] **解決・描画（§27.5/§27.1/§27.4）**: [resolve.ts](src/runtime/resolve.ts) / [resolved.ts](src/runtime/resolved.ts) / [DomRenderer.ts](src/runtime/DomRenderer.ts)（filter + backdrop-filter + svg defs + fxSig）
- [x] **UI（§27.6/§27.7）**: [InspectorPanel.tsx](src/editor/panels/InspectorPanel.tsx) Effects foldout / [TimelinePanel.tsx](src/editor/panels/TimelinePanel.tsx) effect KF 行 + ADJ バッジ
- [x] **ストア（§27.8）**: [store.ts](src/editor/store.ts) `addEffect`/`removeEffect`/`reorderEffect`/`toggleEffect`/`addAdjustmentLayer`/`toggleAdjustment`
- [x] **PropPath**: [keyframeEdit.ts](src/editor/keyframeEdit.ts) `effects.<id>.<key>`
- [x] **テスト**: [test/effects.test.ts](test/effects.test.ts) + [test/effectSvg.test.ts](test/effectSvg.test.ts) + 既存回帰 **169 tests PASS** / typecheck / build ✅
- [x] **Playwright 実機**: Blur preview + KF アニメ / Tint url filter / 調整レイヤー backdrop-filter ✅
- **調整レイヤー export**: preview ベストエフォート（§27.4）。export ピクセル一致は未検証 → **許容済み既知差候補**（foreignObject + backdrop-filter 経路依存）。通常レイヤー effects は既存 export パイプライン（filter 文字列）で preview 一致想定。

#### §27.3 追加エフェクト（**AE 寄せリファイン 2026-06-19・コア修正＋視覚検証 完了**）

> **2026-06-19 リファイン（Opus）**: 仮実装の **構造的バグと AE 乖離を修正**。spec §27.3/§27.1 を修正済みレシピに更新。typecheck / **172 tests PASS** / build ✅。
> **Playwright 視覚検証済み（4 象限・別レイヤー分離）**: Wave=クリーンな横波（旗状・tearing なし）/ Ripple=中心起点の同心円ディストーション / Linear Wipe(0.5)=左半分残し＋feather エッジで**実切り抜き** / Angular Wipe(0.3)=真上から CW に 108°扇形除去。コンソールエラーなし。検証スクリプト [verify-effects.mjs](verify-effects.mjs)（空 IDB → アプリ boot → 各エフェクトを別象限に配置 → screenshot）。
>
> **検証中に判明・修正した追加バグ（Opus・実機でのみ顕在化）**:
> 1. **横波化**: Wave は当初 longitudinal（進行方向と同軸の変位）で文字が縦割れ（tearing）→ AE 同様 **transverse**（進行方向に垂直な変位）に修正（[effectSvg.ts](src/runtime/effectSvg.ts)）。
> 2. **レイヤー実寸サイズの ctx**: SVG エフェクトの filter はレイヤー（host div）座標系で効くのに ctx に **comp 寸**を渡していたため、comp サイズの mask/map が小さいレイヤーの一部しか覆わず**ワイプが全く効かない**（mask 左端の白だけ見える）バグ。`EffectRenderCtx` をレイヤー実寸に変更（[DomRenderer.ts](src/runtime/DomRenderer.ts)）。host div は absolute 子（solid 等）だと offsetWidth=0 に潰れるため、**コンポーネント子要素の border box** から実寸を測る。調整レイヤーのみ comp 全体寸を渡す。

| type | label | 2026-06-19 修正内容 |
|---|---|---|
| `wave` | Wave | **noise→真の正弦波 displacement map**（feImage linearGradient + feDisplacementMap、scale=2A）。**phase が seed 跳躍ではなく滑らかにスクロール**。AE Wave Warp 相当に。 |
| `turbulentDisplace` | Turbulent Displace | 変更なし（AE 同様ノイズが正・既存確認済み）。evolution の連続進化は SVG seed 制約で離散近似のまま。 |
| `ripple` | Ripple | **noise→同心円 displacement map**（radialGradient userSpaceOnUse、sin/cos で半径方向に変位回転、(1−o) 減衰）。**center が実際にリング中心を動かす**（旧実装は seed 入力のみで無効だった）。 |
| `linearWipe` | Linear Wipe | **構造バグ修正**: マスクが luminance で、feComposite "in" は alpha 参照のため**実際は切り抜いていなかった** → `feColorMatrix luminanceToAlpha` を挿入。**completion 極性を AE 準拠に反転**（0=表示/恒等・1=全 wipe）。feather 二重適用解消。 |
| `angularWipe` | Angular Wipe | 同上の luminanceToAlpha 修正 + 極性反転。白背景＋黒扇形（消去領域）が startAngle(=真上) から CW に completion·360° で拡大。 |

**共通**: DomRenderer の `<filter>` に region `-25%/150%` を付与（displacement/feather のエッジクリップ回避）。feImage は (0,0,w,h) 固定で region 拡張に不感。

**ディストーション 3 種の既知バグ（未解決）**: Wave / Turbulent Displace / Ripple で Amplitude / Amount 増加時に実体が右下へスライドする報告が継続。複数回の修正試行はコミット済み／未コミット混在で紛らわしかったため、**事例・仮説・試行履歴を [doc/distortion-effect-bugs.md](doc/distortion-effect-bugs.md) に集約**（ワイプは対象外）。次回修正時は同ドキュメントを正とする。

**残タスク**:
- [x] **per-effect 視覚検証** — 2026-06-19 完了（上記）。
- [ ] **export 一致（INV-2）**: 新 5 種 SVG エフェクトの preview↔export ピクセル検証（feImage href が foreignObject ラスタ経路で再現するか要確認）。
- [x] **pixelSorter export 一致（INV-2）** — 2026-06-19 (Cursor) 完了。根因: `captureElementToCanvas` の `cloneNode` が canvas bitmap を複製しない → [`rasterCapture.ts`](src/runtime/rasterCapture.ts) `inlineCanvasBitmaps(cloned, source)` で source 側から `toDataURL`。**Playwright**: plain solid 120k px / pixelSorter 120k px（修正前 0 px）。preview↔export サンプル差分は foreignObject 二重経路による軽微残差（許容）。
- [ ] **調整レイヤー + 新エフェクト**: backdrop-filter 経路での作用確認
- [ ] **Timeline**: Wave `direction` enum 行の編集 UI（現状 Inspector `<select>` のみ）
- [ ] **turbulentDisplace の size→frequency / evolution チューニング**（任意・既存確認済みのため低優先）
- **KF アニメ実機**: 今回は静的値で検証。completion/phase/amplitude の KF アニメは resolve 経路（test 済み）だが preview スクラブの実機確認は任意で残。

**関連ファイル**: [effectSvg.ts](src/runtime/effectSvg.ts) / [builtinEffects.ts](src/runtime/builtinEffects.ts) / [DomRenderer.ts](src/runtime/DomRenderer.ts) / spec §27.3 / 検証スクリプト [verify-effects.mjs](verify-effects.mjs)

#### §27.3 `pixelSorter` — Pixel Sorter + raster パイプライン（**実装完了 2026-06-19**）

> spec §27.1 raster パイプライン + §27.3 `pixelSorter`（AEPS2 Phase 1 コア）。**途中セッションから Cursor が継続実装・export バグ修正まで完了。**

- [x] **コア（純関数）**: [`pixelSort.ts`](src/runtime/pixelSort.ts) — 輝度しきい値 / angle 回転 / simple|highlights|shadows|random / sortBlocks / feather（INV-1）
- [x] **EffectDef**: [`builtinEffects.ts`](src/runtime/builtinEffects.ts) `pixelSorter` — `{ kind: "raster" }` + `processPixels`
- [x] **DomRenderer §27.1**: pre css/svg → raster capture → canvas overlay → post filter。`flushRasterEffects()` / `rasterRunKey`（frame 含む stale ガード）
- [x] **共有ラスタ化**: [`rasterCapture.ts`](src/runtime/rasterCapture.ts) — exporter と DomRenderer 共有。`flattenShadow` / `inlineCanvasBitmaps(cloned, source)`（export 用 canvas bitmap 焼き込み）
- [x] **exporter**: [`exporter.ts`](src/runtime/exporter.ts) — 各 frame `await renderer.flushRasterEffects()` 後 root capture
- [x] **テスト**: [`test/pixelSort.test.ts`](test/pixelSort.test.ts)（6 件）+ [`test/effects.test.ts`](test/effects.test.ts) pixelSorter 3 件。**186 tests PASS**
- [x] **Playwright preview**: raster canvas 400×300・非ゼロピクセル確認 ✅
- [x] **Playwright export**: pixelSorter 付き solid が PNG-seq に出力（修正前は全黒）✅
- **非目標（Phase 1）**: Gradients / Random Length / 調整レイヤー + raster / AEPS2 100% 一致
- **許容済み既知差**: preview ライブ canvas と export foreignObject 二重ラスタの軽微色差。random mode は frame seed 依存（INV-1 準拠）。

### Timeline AE化バックログ（spec §5 スキーマ拡張 + INV 影響評価を伴い別リビジョンで導入）
**→ 実用性優先度リストは [doc/timeline-panel-wip.md](doc/timeline-panel-wip.md)。**
- **Tier B（additive スキーマ）**: ラベル色 / solo / lock / shy / parent リンク UI。`SceneObject` にフラグ追加。
- **Tier C（renderer + INV 拡張）**: ブレンドモード（mix-blend-mode）/ トラックマット。flat DOM レンダラ(INV-3) と exporter foreignObject の両方で best-effort 対応要。
- **Tier D（大規模）**: モーションブラー / フレームブレンド / 3D レイヤートグル / 調整レイヤー。決定論モデル整合評価要。
- **DF タイムコード**: 29.97/59.94 の `0;00;00;00` 表示（現状 non-drop）。
- **グラフエディタ Phase 2/3**（上記 §22 未実装項目）。

### 既知の縮退（§20.2 で意図的に MVP 仕様化）
削除した html comp を `compId` 参照する html インスタンスはカスケード削除しない。参照先不在は DomRenderer/HtmlCompPlayer 側で「何も描かない」で安全縮退。自動掃除は将来。

---

## 開発方針（2026-06-18 明記）

**§26 テキストレイヤーは機能実装済み。§26.4 Draft/Best の大きな位置ズレ（ブロッカー）は 2026-06-18 解消済み。**
Draft↔Best は **100% ピクセル一致ではない**（DOM vs SVG アウトラインの経路差によるわずかな残差）。手動回帰（2026-06-18）で実用上問題なしと確認 — **許容済み既知差**として扱い、ブロッカー対象外。
Preview 四隅 scale ハンドルも 2026-06-18 手動確認で修正済み。自動テスト（136 PASS）だけでは UI 品質は保証されないため、実機（Playwright）検証を併用する。

> **次の機能・マイルストーン（M5 / Timeline Tier B 等）に進む前に、既知バグを必ず潰すこと。**
> バグが残ったまま新規スコープを広げない。優先順位は **既知バグ修正 > 手動回帰 > 新機能**。

---

## 既知のバグ・課題

### §26 テキスト × §25 Preview

- ~~**§26.4 Draft / Best 切替の位置ズレ（ブロッカー）**~~ — **2026-06-18 解消（2 段階）**。詳細は更新履歴参照。
- **§26.4 Draft / Best — 残差（許容済み・非ブロッカー）**: Draft(DOM) と Best(SVG) は描画経路が異なるため **100% ピクセル一致は保証しない**。修正後も切替時にわずかな位置/形状差が残りうる（Playwright 実測では ≤2px 級、手動回帰 2026-06-18 でも目視でわずかな差を確認・**実用上問題なし**と判断）。INV-2（preview↔export 一致）は export 時に選択した `textRenderMode` 経路内での一致が正準。
- ~~**Preview 四隅 scale ハンドル（テキストレイヤー）**~~ — **2026-06-18 手動確認で修正済み**。solid と同等にドラッグ開始ジャンプなし。
- **§26 手動回帰（2026-06-18 ユーザー）**: Undo ✅ / グリフ分解 ✅ / Draft↔Best ✅（残差許容）/ 位置 KF アニメ ✅。Inspector Source Text 入力バグは 2026-06-18 修正済み。
- ~~**export 通し（precomp / MP4）**~~ — **2026-06-18 (Cursor) 修正**: §23 precomp 追加後 `exporter.ts` が `setTimelineComps` 未注入のままだったため comp レイヤーが export で空描画（preview のみ正しい）。`PreviewPanel` と同様に timeline comp 一覧を注入。Playwright 実測: precomp preview/export インクピクセル **delta=0**。MP4/WebM/PNG-seq + テキストは UI 経由でダウンロード確認済み。

### §27.3 ディストーション 3 種（wave / turbulentDisplace / ripple）

- **Amplitude / Amount 増加時の実体スライド（未解決）**: 3 種とも同型。歪みは見えるがレイヤー実体が右下へ動く／左上の見え方が減る。詳細・再現手順・修正試行履歴は **[doc/distortion-effect-bugs.md](doc/distortion-effect-bugs.md)**。
- **解消済み（参考・同 doc）**: host 0×0 による効果無効化・境界線への歪み漏れはセッション内修正で解消報告あり（現行コミットへの取り込み状況は doc 参照）。

### インフラ・その他

- `npm install` 時に transitive deps の脆弱性警告（moderate×3 / high×1 / critical×1）。dev/build ツールチェーン由来で実行時影響なし。`npm audit` で精査推奨。
- IndexedDbFs.list は全 key 取得 → prefix フィルタ。アセット増加時は IDBKeyRange 範囲クエリへ最適化（§11.1 注記）。

---

## Next steps（次のセッションでやること）

**ゲート: 下記 1〜2 が完了するまで、4 以降（新機能）に着手しない。**

1. ~~**§26.4 Draft/Best 切替バグ修正**~~ — **2026-06-18 解消済み**（renderer 初期化順 + baseline 式・Playwright 検証済み）。**残差は許容済み（100% 一致非目標）**。
2. ~~**§26 手動回帰（残）** — 作成→編集（即時反映）→export 通し~~ — **2026-06-18 export 修正済み**（§23 precomp `setTimelineComps` 欠落 + 動画 encode 失敗時 PNG-seq フォールバック）。
3. **§25 Preview 手動回帰** — 直接操作・ズーム・オーバーレイ・animated KF 書き戻し（solid / text）。
4. **§24 Ease パネル手動回帰** — F9 メニュー・グラフエディタとの SSoT 共有確認。
5. ~~**§23 precomp Playwright E2E**~~ → ロジックは `test/precomp.test.ts` で自動化済み。Playwright E2E は任意。
6. **M5 Web Bundle Export（§11.7）** — 上記ゲート通過後。`@mafter/runtime` player + bundle export。
7. **Timeline バックログ Tier B〜D / グラフエディタ Phase 2** — 上記ゲート通過後（要 spec 追記・INV 評価）。

### 参考: 先取り済みの境界（spec v0.3 新規）
- **INV-7 `@mafter/runtime` 単一核**: resolve / Renderer / module loader(§11.3) / expression engine(§9) / 再生クロック をエディタ非依存ライブラリに括出し。preview / video exporter / web bundle player が共有。
- **INV-8**: web bundle player は実時間・別の決定論クラス（フレーム精度非保証, マスタークロック=音声）。MP4/headless とは別保証。
- **§19 パネルシステム**: `LayoutNode` 直列化ツリー + レジストリ。MVP は固定レイアウト + スプリッタ resize のみ。レイアウト状態は project.json に入れない（§19.3）。ドッキングは将来。

---

## 更新履歴（主要マイルストーンのみ）

| 日時 | 内容 |
|---|---|
| 2026-06-15 | progress.md 初期化 / M0 Foundations 完了（schema・正準シリアライズ・FS・zip・テスト） |
| 2026-06-16 | spec v0.3 同期 + M0 リファイン。M1 凍結ゲート + 決定論コア（@mafter/runtime 境界 / Mat4 / easing / resolve / §19）。M1 DOM/UI 層完了（DomRenderer / store / commands / パネル群）。M1→M2 検証リファクタ |
| 2026-06-16 | M2 HTML comp + expression 完了。実機修正（ModuleLoader オブジェクト default export 拒否の致命バグ等）Playwright 検証 |
| 2026-06-16 | M3 Export 完了。実機致命バグ修正（tainted canvas / AVC level / HW エンコーダ）+ Opus レビュー後 7 件。実機 export 9/9 PASS |
| 2026-06-16 | M4 Plugin API v1 完了（plugin.ts / pluginRegistry / DomRenderer・ExpressionEngine 拡張 / gradient-rect サンプル）。実機 14/14 PASS。**MVP 全クローズ** |
| 2026-06-16〜17 | spec v0.4 §20 Project パネル（実機 13/13）。spec v0.5〜0.7 §21 Timeline Tier A + P0 + P1 + §21.5 KF 複数選択 + §21.6 U/UU + §21.7 Duplicate/Split。実機検証・実バグ修正（graphRef 未接続 / IME J/K / box-sizing 原点ズレ等） |
| 2026-06-17 | spec v0.7 §22 グラフエディタ Phase 1（実機検証済）。Timeline コピー/カット/ペースト AE 準拠化（実機検証済） |
| 2026-06-17 | デプロイ基盤: vite LAN 公開 / `deploy:ssh`（.env・パスワード認証・Caddy 自動構成） |
| 2026-06-17 | §23 comp layer (precomp) Phase 1 実装（スキーマ不変・循環参照 BFS 検出・Freeze 挙動）。実機検証待ち |
| 2026-06-18 | §23 precomp 自動検証: `compLayer.ts` + `test/precomp.test.ts`（14 件）。typecheck/test/build 一括確認（100 tests PASS） |
| 2026-06-18 | §24 Flow 風 Ease パネル Phase 1 実装（EasePanel / easingApply / builtin presets / FS 保存 / store KF 選択共有）。107 tests PASS |
| 2026-06-18 | spec v0.8 §24 Flow 風イージングプリセットパネル仕様確定（独立常設パネル / in-out-both 3 モード / カーブ編集+★保存 / cubic-bezier プリセットのみ・bounce/elastic は Phase 2）。実装は progress バックログに記載・未着手 |
| 2026-06-18 | (Cursor) §26 テキストレイヤー本実装（builtin text ComponentDef / Inspector Text + ColorSwatch / Draft-Best 品質 / SVG アウトライン + opentype.js / グリフ分解 / export textRenderMode）。128 tests PASS |
| 2026-06-18 | (Cursor) §26 テキスト scale ジャンプ修正: `textMeasure.ts`（Canvas `measureText` 実測）+ `previewViewer` の `getLayerLocalBounds` テキスト case を推定式から差し替え |
| 2026-06-18 | (Cursor) §25/§26 テキスト scale ハンドル ジャンプ修正: `scaleFromOppositeCorner` をドラッグ起点相対に変更 / Draft DOM を Canvas bounds と一致 / Best 時は opentype bounds でハンドル整合。130 tests PASS |
| 2026-06-18 | (Cursor) §26 手動確認: Preview 四隅 scale ハンドル **修正済み**。§26.4 **Draft/Best 切替は未修正（ブロッカー継続）** — 次セッション優先 |
| 2026-06-18 | §26.4 Draft/Best 位置ズレ **解消(1)**: renderer 初期化順（生成後の renderer に "draft" が届かず常に precise=SVG 固定）。`textQualityRef` で生成時に品質適用（PreviewPanel.tsx）。130 tests ✅ |
| 2026-06-18 | §26.4 Draft/Best **縦ズレ解消(2)**: Best baseline 式をインク基準→CSS line-box 同式（フォントメトリクス + 正 half-leading, system は fontBoundingBox）に修正（textLayout.ts textBaselineY）。Playwright インク実測で 0.08em→≤0.02em。baseline 回帰 3 件追加。133 tests / typecheck / build ✅ |
| 2026-06-18 | (Cursor) エージェントルール更新: 実装→修正ループで **Playwright + Chromium 実機検証を必須**と明記（`.cursor/rules/mafter-effect-agent.mdc` / `debug-visual-render-bug.mdc` / skill 同期） |
| 2026-06-18 | (Cursor) §26 グリフ分解: 分解前テキストを **`{name} (source)`** レイヤーとして複製保存（`enabled: false` で二重描画回避）。元 ID は従来どおり空テキスト container + glyph 子。133 tests ✅ |
| 2026-06-18 | (Cursor) §26.5 グリフ分解位置ズレ **解消**: 原因は (1) center/right で SVG `text-anchor` 行描画と per-glyph レイアウトの不一致 (2) `translate(-minX)` + `g.x-minX` の二重オフセット。修正: `resolveTextLayout` を Draft/Best/分解の単一正に、per-glyph 描画へ統一。Playwright 実測 center/right/multiline dx≈0（37px→0）。136 tests ✅ |
| 2026-06-18 | (Cursor) Inspector/Timeline プロパティ編集の **Preview 即時反映**: `previewOverride`（スクラブ/カラーピッカー中の undo 対象外 patch）+ `ScrubNumber`/`ColorSwatch` `onLiveChange` + `PreviewPanel` `renderComp` マージ。選択ハンドルも `mergeObjectPreviewOverride` で bounds/transform 追従。136 tests ✅ |
| 2026-06-18 | (ユーザー) §26 手動回帰（部分）: Undo ✅ / グリフ分解 ✅ / Draft↔Best ✅。**Draft↔Best は 100% ピクセル一致ではない**（わずかな残差）が実用上問題なし → progress に許容済み既知差として明記 |
| 2026-06-18 | (ユーザー) §26 手動回帰: 位置 KF アニメ ✅ |
| 2026-06-18 | (Cursor) **export 回帰修正**: §23 precomp 後 `exporter.ts` に `setTimelineComps` 未注入 → comp レイヤーが export で空。Preview と同型注入 + encode 失敗時 PNG-seq フォールバック + `flushVideoEncoder` タイムアウト。Playwright: precomp preview/export ink delta=0 / PNG+MP4 UI ダウンロード確認。136 tests ✅ |
| 2026-06-18 | (Cursor) **MP4/WebM 再生不能バグ修正**: 前回追加の encode 健全性チェックが `flush()` 前に走り「9/10 chunks」で誤フォールバック → ZIP が `.mp4`/`.webm` 名で保存され再生不能に。**修正**: 検証を flush 後へ移動 / VP9 は decoderConfig 不要 / 偶数解像度 / キュー drain / `ExportResult` で実際の format を返し拡張子一致。Playwright: テキスト含む MP4+WebM `<video>` 再生 OK。136 tests ✅ |
| 2026-06-18 | (Cursor) **export 常時 PNG-seq フォールバック修正**: `drainEncoderQueue` が毎フレーム `encodeQueueSize===0` を 30s 待ち → HW エンコーダ環境でタイムアウトし MP4/WebM 選択でも ZIP 出力に。**修正**: 閾値ベース `backpressureEncoderQueue`（旧挙動）へ戻す / `decoderConfig` 検出を `description` 限定から緩和。Playwright: MP4/WebM 150f + `<video>` 再生 OK。136 tests ✅ |
| 2026-06-18 | (Cursor) **export 常時 PNG-seq フォールバック修正(2)**: 誤検知の `assertVideoEncodeHealthy`（chunkCount/decoderConfig）と `flush()` 20s タイムアウト、音声 encode 失敗が映像まで PNG-seq フォールバックに連鎖。**修正**: 実エンコーダ error のみ検査 / flush は通常 await / 音声失敗は映像-only で継続。136 tests ✅ |
| 2026-06-18 | (Claude Code) `cursor-agent` CLI を Composer 2.5 への実装委任ハーネスとして追加: [.claude/skills/delegate-to-cursor/SKILL.md](.claude/skills/delegate-to-cursor/SKILL.md)（隔離 worktree + `--print --force` 非対話実行 + マージ前レビュー必須）。ユーザー明示依頼時のみ起動 |
| 2026-06-18 | (Cursor) **`deploy:ssh` 修正・デプロイ完了**: SFTP 有効化（`openssh-sftp-server` + `kill -HUP`）/ SFTP 優先 + tar fallback（接続分離）/ Windows build spawn / Caddy bash 構文修正 / Docker 不可時 `python3 -m http.server :80` fallback。**`root@ssh.gycp.party:~/mafter-effect` へ配備済み** |
| 2026-06-19 | (Claude Code) **spec v0.11 §27 エフェクト & 調整レイヤー 設計確定**: §5.5b additive スキーマ（`EffectInstance` / `SceneObject.effects?` / `isAdjustment?`・byte 等価）+ §27 基盤（`EffectDef`/`registerEffect`/CSS filter 連結）+ builtin Blur/Tint + 調整レイヤー backdrop-filter 最小設計 + Inspector/Timeline 統合 + INV 評価 + 作業分解。**実装は Cursor 委任予定**（weekly limit 残 7%・設計に予算集中） |
| 2026-06-19 | (Cursor) **Inspector Unity 風 foldout UI**: [InspectorPanel.tsx](src/editor/panels/InspectorPanel.tsx) に `InspectorFoldout`（▶/▼ 三角・コンポーネント毎の仕切り）を導入。Transform / components[]（text）/ Expression / Keyframes / In-Out を個別展開・折りたたみ可（レイヤー毎に状態保持・既定展開）。機能は不変。136 tests ✅ / Playwright 折りたたみ検証 ✅ |
| 2026-06-19 | (Cursor) **§27 エフェクト & 調整レイヤー実装**: schema §5.5b + EffectDef/blur/tint + resolve/DomRenderer filter/backdrop-filter + Inspector Effects foldout + Timeline effect KF 行 + store アクション。144 tests / typecheck / build ✅。Playwright: Blur KF / Tint / 調整レイヤー backdrop ✅。調整レイヤー export 一致は未検証（§27.4 許容済み既知差候補） |
| 2026-06-19 | (Cursor) **§27.3 ディストーション & ワイプ 5 種追加（仮実装・要修正）**: spec §27.3 追記 + [effectSvg.ts](src/runtime/effectSvg.ts) + builtin `wave`/`turbulentDisplace`/`ripple`/`linearWipe`/`angularWipe` + Inspector enum（Wave direction）。169 tests / typecheck / build ✅。Playwright: Wave/Turbulent/Linear/Angular preview filter ✅。**Ripple・export 一致・見た目チューニングは未完了 → progress §27.3 要修正リスト参照** |
| 2026-06-19 | (Cursor) **ワイプ角度レンジ修正**: `linearWipe.angle` / `angularWipe.startAngle` の ParamDescriptor `min/max`（0..360）を削除し AE 同様に負値・360 超を入力可能に。レンダリングは元から任意角度対応。spec §27.3 更新 + テスト追加。173 tests ✅ |
| 2026-06-19 | (Cursor) **§27.3 ディストーション 3 種スライドバグを doc 化**: 未解決の Amplitude 比例スライド（wave/turbulentDisplace/ripple）の再現手順・仮説・修正試行を [doc/distortion-effect-bugs.md](doc/distortion-effect-bugs.md) に集約。途中の未コミット pad/margin 試行は作業ツリーから撤回。176 tests ✅ |
| 2026-06-19 | (Cursor) **§27.3 pixelSorter + raster パイプライン実装完了**: spec §27.1 raster / §27.3 pixelSorter + [pixelSort.ts](src/runtime/pixelSort.ts) + DomRenderer canvas overlay + [rasterCapture.ts](src/runtime/rasterCapture.ts) exporter 共有 + export `inlineCanvasBitmaps` 修正（clone canvas 空バグ）。186 tests / Playwright preview+export ✅ |
| 2026-06-19 | (Cursor) **画像アセット読み込み**: [imageAssetCache.ts](src/runtime/imageAssetCache.ts)（data URL + natural size）+ store `importImageAsset`/`addImageLayer` + Project/Timeline UI（+Image / DnD / OS ドロップ）+ DomRenderer `asset` 解決 + exporter/preload 配線 + builtin image ComponentDef。189 tests / typecheck / build ✅。Playwright: 1×1 PNG + 4032×2268 JPG preview 実寸表示 ✅ |
