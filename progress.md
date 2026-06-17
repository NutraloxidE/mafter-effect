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

現行テスト: **119 件全通過** / typecheck ✅ / build ✅（2026-06-18）。

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

### §26 テキストレイヤー本実装（spec v0.10・**仕様確定 2026-06-18 / 実装未着手**）
**→ Cursor へ一括実装させる前提で spec §26 に確定。** 現状 `text` は描画 5 属性のみ・編集 UI 皆無・builtin ComponentDef 未登録（Timeline で scalar フォールバック不具合）。ユーザ確認で採否を明文化済み:
- [ ] **§26.1 スキーマ** — text props 確定: 既存5 + `tracking`/`leading`/`weight`/`italic`/`strokeColor`/`strokeWidth`。単位 px、tracking/leading は px、leading=0→normal。
- [ ] **§26.2 builtin ComponentDef 登録**（バグ修正）— `text` を ParamDescriptor 付きで register → Timeline の kind/label フォールバック不具合解消。汎用 PropRow を string/enum/color/bool kind に対応拡張。
- [ ] **§26.3 Inspector "Text" セクション** — textarea/font/size/align(3btn)/tracking/leading/weight(select)/italic(toggle) + **新規カラースウォッチ**（Fill/Stroke）。animatable はストップウォッチ◇で KF 化。編集中フォーカス時は軽量へ自動降格。
- [ ] **§26.4 プレビュー品質モード** — Preview に**グローバル1ボタン**で軽量(DOM)⇄厳密(SVGアウトライン)切替。ビューア設定で永続化（project.json 非汚染）。**今回スコープは SVG アウトライン描画まで**。キャッシュは `FrameRenderCache` IF を no-op で確保（§26.4.2・将来）。
- [ ] **§26.4.1 SVG アウトライン** — フォントパーサ（推奨 opentype.js）で assets フォントのグリフ path 化。system フォントは SVG `<text>` フォールバック。決定論（INV-1）維持・レンダラ層で生成。
- [ ] **§26.5 グリフ分解（GG 分解）** — 「1文字=1 SceneObject」破壊的コマンド。編集時に measureText でレイアウト→静的 Transform 焼き込み（resolve は不変）。元レイヤーはコンテナ化し各グリフを parent 継承。1 undo。
- [ ] **§26.6 補間** — Source Text は hold のみ。color/stroke は成分補間。font/align/weight/italic 非アニメ。
- [ ] **§26.7 Export** — 厳密モードが基準。export ダイアログで「厳密(アウトライン)のみ / 可能な限り軽量(DOM)」を選択可。INV-2 は scene 解決値一致で担保、ピクセル基準は厳密。
- [ ] **回帰** — typecheck / test / build + ブラウザ実機（作成→編集→KF→グリフ分解→品質切替→export）。
- **将来（§16）**: 段落ボックステキスト / 文字単位混在スタイル / パステキスト / 範囲セレクター式アニメーター / tracking の 1/1000em 方式 / フォントセレクト UI / レイヤー個別品質フラグ / レンダーキャッシュ実体。

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

## 既知のバグ・課題

- `npm install` 時に transitive deps の脆弱性警告（moderate×3 / high×1 / critical×1）。dev/build ツールチェーン由来で実行時影響なし。`npm audit` で精査推奨。
- IndexedDbFs.list は全 key 取得 → prefix フィルタ。アセット増加時は IDBKeyRange 範囲クエリへ最適化（§11.1 注記）。
- 2026-06-17 の Timeline フィードバック修正 + レイヤー DnD ref 修正 + comp trimStart/ゴースト表示は typecheck/test/build 緑（2026-06-18 再確認: **100 tests PASS**）。

---

## Next steps（次のセッションでやること）

1. **§25 Preview ビューア編集 手動回帰** — 直接操作・ズーム・オーバーレイ・animated KF 書き戻し（実装済み・自動テスト 119 PASS）。
2. **§24 Ease パネル手動回帰** — F9 メニュー・グラフエディタとの SSoT 共有確認（実装済み・自動テスト 119 PASS）。
3. ~~**§23 precomp Playwright E2E**~~ → ロジックは `test/precomp.test.ts` で自動化済み。Playwright E2E は任意。
4. **M5 Web Bundle Export（§11.7）** — `@mafter/runtime` ベース player + Single-file/Folder bundle + `exportStrategy:'bake'` レイヤの部分 MP4/WebP 化。境界は M1 で先取り済み。
5. **§26 テキストレイヤー本実装**（spec v0.10 確定済み・Cursor へ一括実装）— builtin ComponentDef 登録（バグ修正）→ Inspector Text セクション + カラースウォッチ → 軽量/厳密プレビュー切替（SVG アウトライン）→ グリフ分解コマンド → export 方式選択。
6. **Timeline バックログ Tier B〜D / グラフエディタ Phase 2**（要 spec 追記・INV 評価）。

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
| 2026-06-18 | (Cursor) §25 Preview ビューア編集 Phase 1 実装（previewViewer / PreviewViewerOverlay / PreviewPanel 拡張 / localStorage 永続化）。119 tests PASS |
