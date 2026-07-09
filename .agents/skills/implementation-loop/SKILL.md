---
name: implementation-loop
description: Mafter Effect で新機能実装・バグ修正・視覚/レンダリング変更を行うときの統合ワークフロー。spec 先行、影響経路の洗い出し、INV-2 全経路一貫性、Playwright 実機検証、計測駆動の局在化、純関数テストでの固定、progress 記録までの一連のループ。バグ修正（視覚・parity・配線漏れ）やピクセルに触れる新機能の着手時に必ず実行する。専門タスクは debug-visual-render-bug / implement-visual-effect / add-layer-component-type へ分岐する。
---

# Mafter Effect 実装ループ（implementation loop）

> **正本（隔離）**: 実装・バグ修正の手順・チェックリスト・一貫性ゲート・Playwright ハーネスは**すべて本ファイルに集約**する。
> `AGENTS.md` / `.cursor/rules/mafter-effect-agent.mdc` はポインタのみ。ループの自己アップデートは本ファイルだけを編集すること。

このスキルは **「先に spec → 影響を地図化 → 最小実装 → 経路横断で実機検証 → 固定・記録」**
の一連の流れを抽象化したもの。個別のバグ手法は下位スキルに委譲するが、
**着手から完了判定までの骨格は常にここに従う。**

## いつ実行するか（必須）

- **バグ修正**（視覚・レンダリング・preview↔export・配線漏れ・ちらつき・「片経路だけ壊れる」）
- **新機能・仕様追従の実装**（特に DomRenderer / export / bundle / resolve / store / タイムライン）
- **ピクセル・時間・合成順に触れる変更**（effect / blend / 3D / 調整レイヤー / transform / フォント 等）

`npm test` / `typecheck` が緑でも完了にしない。緑は**必要条件**であって**十分条件ではない。**

## ループ全体像

```
[0 開始] progress + spec 把握
    ↓
[1 スコープ] spec 確定？ INV/§5 変更はユーザー承認？
    ↓
[2 地図化] 触れる経路・ディスパッチ点を列挙（コードを書く前）
    ↓
[3 実装] 最小 diff・単一の正（shared math / shared pipeline）
    ↓
[4 検証] typecheck/test → Playwright 実機 → 経路間 parity
    ↓
[5 固定] 純関数 unit test・progress 追記・一時物削除
    ↓
  未達なら [3] または [2] へ戻る（推測で直さない）
```

## Phase 0 — セッション開始

1. [progress.md](../../../progress.md) を読み、既知バグ・未配線・直近の教訓を把握する。
2. [doc/mafter-effect-spec.md](../../../doc/mafter-effect-spec.md) の該当節を読む（§5 型 > §4 INV > §15 受け入れ > 散文）。
3. 散文だけを根拠にスキーマを変えない。未確定なら実装に入らずユーザーへ確認（選択肢＋推奨案）。

## Phase 1 — スコープ・仕様ゲート

| 変更の種類 | ルール |
|-----------|--------|
| INV 追加・変更・緩和 | **実装前にユーザー確認** |
| §5 型 / `project.json` 直列化形式 | **実装前にユーザー確認** |
| 散文・§5 に触れない spec 追記 | Cursor 主導で可。ただし **spec → 実装** の順 |
| 実装で「事実上の仕様」を作る | 禁止。曖昧なら先に spec 化 |

**ユーザーの要請は基本的に抽象的なアイデア**として受け取る。スコープ・UX・トレードオフ・既定値など
曖昧な点が 1 つでもあれば、推測で進めず実装前にユーザーへ確認（選択肢＋推奨案）。

**バグ修正でも Phase 1 を飛ばさない。** 「直し方」が spec と矛盾していないか確認する
（例: Live 調整は preview が正・INV-2 で export も同じ見た目、等）。

## Phase 2 — 影響地図化（コードを書く前）

推測で直す前に、**どこが壊れうるかを列挙**する。これが局在化の最短経路。

### 2a. レンダリング経路（INV-2）

同一 frame で次が**同じ scene 解決値・同じ見た目**になるか意識する:

- Preview パネル（live DOM）
- Browser export（mp4 / webm / PNG 連番）
- Web bundle player（§11.7）
- RAM Preview / precomp ラスタキャッシュ（該当時）

**同一経路同士の diff=0 は意味がない。** preview の実画面と export 出力を比較する。

### 2b. レンダリング context 依存

親/root にしか無い context に依存していないか洗う:
`perspective` / `preserve-3d` / stacking context / `isolation` /
`mix-blend-mode` の背面 / `backdrop-filter` の背面 / `mask` 等。
**部分キャプチャで context を取りこぼさない。**

### 2c. ディスパッチ点（配線漏れ）

型・挙動は `c.type` 分岐や集合定数に **10〜15 箇所**散在する。
新型・新挙動軸を足すときは grep で全ヒットを洗い、各点で「何をするか」を明示決定する
（"何もしない" も決定）。詳細は [add-layer-component-type](../add-layer-component-type/SKILL.md)。

### 2d. バグの経路分解（局在化）

症状から**最初に壊れる層**を切る:

| 観察 | 疑う層 |
|------|--------|
| resolve 値は正しいが描画だけおかしい | Renderer / capture / compositor |
| 1 経路だけ（例: MP4 のみ） | その経路の exporter フラグ・capture 方式 |
| mount 後の編集だけ効かない | stale スナップショット・effect 未再実行 |
| 強さに比例してずれる | 座標系・filter region・素材の平均バイアス |
| 前フレームに依存してちらつく | ステートフル DOM 操作・async 競合 |
| **メディア要素が「戻ったり進んだりちらつく」** | **export ループに `play()`（実時間進行）が混ざっている**。export は離散フレーム処理なので、ターゲットを行き過ぎ→逆行 seek→再度行き過ぎ、で前後に振動する。export は常に決定論 seek（pause + 目的フレームへ seek）に統一する。 |
| **メディアの動きが間引かれる（n フレームに1回重複）** | **フレーム境界 `k/fps` ちょうどへ seek している**。float 丸めで `currentTime` が境界をわずかに下回り前フレームが選ばれる（タイムベースによっては毎 2〜3 フレームに1回再現）。`target + 0.5/fps`（フレーム区間の**中央**）へ seek するよう直す。scrub と export で同じ seek 先を共有すること（INV-2）。 |

過去事例: [doc/issue/mp4-live-adjustment-layer-parity.md](../../../doc/issue/mp4-live-adjustment-layer-parity.md)、[doc/issue/video-footage-export-sluggish.md](../../../doc/issue/video-footage-export-sluggish.md)（export の `play()` 振動 + フレーム境界 float 丸めの2真因）

## Phase 3 — 実装原則

1. **最小 diff** — 依頼・バグに無関係なリファクタを混ぜない。
2. **単一の正** — preview と export で式を 2 本にしない。共有関数・共有パイプラインに寄せる。
3. **INV を守る** — `resolve()` は純関数（INV-1）。Renderer は `ResolvedScene` のみ（INV-3）。
4. **compositor を素朴に再実装しない** — canvas 再現はフレーム間ステートレス。live DOM の毎フレーム破壊操作はちらつきの温床。
5. **FS 整合** — zip/export/bundle は `await saveToFs()` 後に `getFs()` で読む（store 投影と FS 正本のズレ防止）。
6. **新型 export 正常化は他経路を壊さない** — 描画レイヤー新型や export キャプチャ修正は共有パイプライン（`rasterCapture` / `DomRenderer` / `exporter` / `compFrameCapture` / `videoElementSync`）に触れやすい。**型別・経路別オプトイン**（`c.type` 分岐・`exportVideoStep` / `inlineVideoFrames` 等）で閉じ、全レイヤー一律変更を避ける。新型用 verify だけ緑にせず、既存 export シナリオ（solid/text/image・blend・調整・displacement・bundle bake 件数等）の無回帰を完了条件に含める。preview 最適化と export 決定論はモード分岐を維持。

## Phase 4 — 検証ループ（完了判定の核心）

### 4a. 自動テスト

`npm run typecheck` / `npm test` / 必要なら `npm run build` を緑にする。

### 4b. Playwright 実機（正準ハーネス）

UI・レンダリング・ブラウザ挙動は **Playwright + Chromium が正準**。
手動ブラウザ・コードリーディングだけで「直った」としない。

- **対象**: UI 変更、DomRenderer / Preview / export、タイムライン操作、視覚バグ、preview↔export 一致確認 など
- **起動**: `npm run dev`（既定 5173、衝突時 5175+）→ Playwright で Chromium を開いて操作・測定
- **状態リセット**: `indexedDB.deleteDatabase("mafter-effect-fs")` + reload、`localStorage.clear()`（viewer 設定）
- **store 参照**: `window.__mafterEditorStore` または `(await import("/src/editor/store.ts")).useEditorStore.getState()`（dynamic import は別 Zustand インスタンスに注意）
- **flaky 時**: dev サーバを再起動（HMR 蓄積で store null 化・古いモジュール配信のノイズ除去）
- **視覚バグ**: [debug-visual-render-bug](../debug-visual-render-bug/SKILL.md) の measure ループを併用
- **後始末**: 使い捨て Playwright スクリプト・一時 `console.log` はコミットに残さない

視覚バグ向けの追加要点（インク測定・選択ハンドル除外・INV-1/2）は `debug-visual-render-bug` スキル参照。

### 4c. 視覚・レンダリング一貫性ゲート（INV-2 厳守）

**ピクセルに影響する追加・変更**（effect / expression / blend / 3D・カメラ / 調整レイヤー / transform /
filter / フォント / 合成順 など）を入れるときは、次を満たすまで「完了」にしない。
「preview で動いた」だけで終わらせない。

1. **全経路の一貫性（INV-2）** — 同一 frame で preview / browser export(mp4・png) / web bundle player が
   同じ scene 解決値になること。Expression と Preview/Export の描画が一致すること。
   「描画手段の忠実度差」は許すが「効果が落ちる・消える・ずれる」は不可。

2. **レンダリング context 依存の洗い出し** — `perspective` / `perspective-origin` / `preserve-3d` /
   stacking context / `isolation` / `mix-blend-mode` の背面 / `backdrop-filter` の背面 / `mask` 等。
   部分キャプチャで context を取りこぼさない。

3. **compositor を素朴に再実装しない** — canvas 再現はフレーム間ステートレス。
   live DOM の毎フレーム破壊操作（visibility トグル・overlay 差し替え・raster 使い回し）はちらつきの温床。

4. **時間的安定性（ちらつき）検査** — 「連続描画 frame N」==「単独描画 frame N」。
   差が出る＝状態リーク要因。

5. **検証は経路間で・目視併用** — 同一経路同士の diff=0 は無意味。
   preview 実画面 screenshot と export 出力を比較。pixel-diff 件数だけに頼らず効果シグネチャ
   （std / エッジ量 / 既知の不変量）＋生成画像の目視（blank が diff を下げる罠に注意）。

6. **推測で直さず局在化** — 経路を分解してどこで壊れるかを実機で特定してから最小修正
   （事例: [doc/issue/mp4-live-adjustment-layer-parity.md](../../../doc/issue/mp4-live-adjustment-parity.md)）。

### 4c-2. 新描画レイヤー export 正常化の無回帰ゲート（該当時必須）

`video` / `image` / 新型コンテンツの **export 専用経路**（foreignObject インライン化・メディア seek・フレーム待ち・`flush*`）を追加・修正するときは、次を満たすまで完了にしない。

1. **影響地図** — 変更が及ぶ共有モジュールと、触っていないはずの経路を列挙する:
   - browser export（mp4 / webm / PNG 連番）
   - `compFrameCapture`（ネスト precomp・調整レイヤー auto_raster）
   - Web bundle player
   - preview（INV-2・再生中の `video.play()` 等）
2. **スコープ閉じ** — 新型専用ロジックは `c.type` または exporter/capture の**明示フラグ**に閉じる。共有関数のデフォルト挙動を変えない（変えるなら全経路の回帰理由を progress に書く）。
3. **既存 export 回帰** — 新型の verify に加え、リポジトリ内の既存 export 関連 verify・unit（blend / rasterCapture / bundleExport / 調整・fast displacement 等、変更に関連するもの）を再実行し PASS を確認する。
4. **二重モード** — preview 用と export 用のメディア同期（例: `videoElementSync`）は、片方の最適化が他方のフレーム精度・書き出し速度を壊していないことを確認する。

worked example（2026-06-26）: 動画 export で `inlineVideoFrames` + `exportVideoStep` を video 型に閉じ、`rasterCapture` / `waitForVideoFrame` の共有改善は他型に波及しないよう分岐。完了条件に `verify-video-export.mjs` **と** 既存コンプ（solid/text/image・blend 等）の無回帰を含めた。

### 4d. タスク別 — 下位スキルを必ず読んで実行

| タスク | 追加で実行するスキル |
|--------|---------------------|
| 視覚・位置・parity・「見た目がおかしい」 | [debug-visual-render-bug](../debug-visual-render-bug/SKILL.md) **必須** |
| displacement / filter / 調整レイヤー / ドリフト | [implement-visual-effect](../implement-visual-effect/SKILL.md) |
| 新 built-in component / 型の配線漏れ | [add-layer-component-type](../add-layer-component-type/SKILL.md) |
| フィードバック収穫→要約→提案（一文・日常入口） | [run-feedback-loop](../run-feedback-loop/SKILL.md) **推奨** |
| ユーザーフィードバックの要約のみ | [summarize-user-feedback](../summarize-user-feedback/SKILL.md) |
| 要約から次タスク提案のみ（実装前） | [propose-from-user-feedback](../propose-from-user-feedback/SKILL.md) |

**バグ修正時**: まず本スキル（Phase 0–2）で地図化 → 視覚系なら `debug-visual-render-bug` の
measure-don't-theorize ループを **Phase 4 全体を通して**回す。

### 4e. Expression / runtime 変更時の player.js 再ビルド（必須・エージェントが自動実行）

HTML bundle export（§11.7）は [`public/player.js`](../../../public/player.js) を zip にそのまま埋め込む。
mp4 / webm / preview は `src/runtime` を Vite が直接 import するため **player.js は HTML bundle 専用**。

#### 再ビルド要否（エクスプレッション追加時）

| 変更 | `npm run build:player` |
|------|------------------------|
| ユーザー脚本 `scripts/<objectId>/*.js` のみ | 不要（manifest `textFiles`） |
| 既存 `ExprContext`（`wiggle` / `presetParams` / `time` 等）だけの新プリセット脚本 | 不要（export 時 zip 注入） |
| **ランタイム側** — 評価エンジン・ctx・helper・配線の追加/変更 | **必須** |

ランタイム側の例: `expressionEngine.ts` / `exprHelpers.ts` / `resolve.ts` / エンジンから import される expression ヘルパ / `src/player/**`。

#### エージェント手順（完了判定の一部 — 口頭リマインド不可）

`src/player` または上記ランタイム側を編集したセッションでは、Phase 4 の typecheck/test の後・完了宣言の前に:

1. **エージェント自身が** `npm run build:player` を実行する（失敗時は修正して再実行）。
2. `public/player.js` が更新され、[test/playerBuildFreshness.test.ts](../../../test/playerBuildFreshness.test.ts) が通る状態にする。
3. expression ランタイム変更なら HTML bundle 経路（該当 verify または bundle export）で新機能が効くことを確認する。

Codex hook（`rebuild-player-if-needed.mjs`）は Cursor では効かない。**Cursor 含む全エージェントが shell で実行する**こと。

## Phase 5 — 固定・記録・後始末

1. **純関数を unit test で固定** — ピクセル直テストが難しい箇所は下層の式・定数・region 生成を抽出。
2. **progress.md 末尾に追記** — 日付・担当・完了/残タスク・既知バグの更新。
3. **一時物を消す** — 使い捨て Playwright スクリプト・`console.log` はコミットに残さない
   （恒久 verify スクリプトを残す場合は意図を progress に明記）。

## 完了チェックリスト（コピーして使う）

```
Phase 0–1
- [ ] progress.md / spec 該当節を読んだ
- [ ] INV/§5 変更があればユーザー承認済み
- [ ] spec 未確定の挙動を推測実装していない

Phase 2
- [ ] preview / export / bundle のどれに効くか列挙した
- [ ] context 依存（backdrop/3D/blend 等）を洗った
- [ ] 新型・配線変更なら全ディスパッチ点を grep した
- [ ] バグなら「どの経路で最初に壊れるか」を仮説化した

Phase 3
- [ ] 最小 diff・共有パイプライン・INV 遵守

Phase 4
- [ ] typecheck / test（+ build）緑
- [ ] Playwright 実機で再現・修正を確認
- [ ] 経路間 parity（該当時）— 同一経路同士だけの比較で終えていない
- [ ] 新型 export 正常化（該当時）— 型別オプトイン・既存 export シナリオ無回帰（4c-2）
- [ ] **expression ランタイム / src/player / player が import する src/runtime を触った → エージェントが `npm run build:player` を自動実行済み**（ユーザー脚本・既存 ctx のみのプリセット脚本は除外。playerBuildFreshness 緑）
- [ ] 視覚系: debug-visual-render-bug を実行した
- [ ] エフェクト系: implement-visual-effect を実行した（該当時）
- [ ] 新型: add-layer-component-type チェックリスト完了（該当時）

Phase 5
- [ ] 純関数の回帰テスト追加（該当時）
- [ ] progress.md 更新
- [ ] 一時スクリプト・ログ削除
```

## アンチパターン

- spec / progress を読まずにコードを書き始める。
- preview だけ動いた時点で完了にする（export / bundle 未確認）。
- 新型 export だけ verify して既存 export（solid/text/image・blend・調整・bundle 等）の回帰を見ない。
- 共有 capture パイプラインを全レイヤー一律変更する（型別フラグで閉じない）。
- 各レンダリングパスを個別パッチする（式が 2 本になる）。
- テスト緑を視覚的正しさの証明にする。
- 経路分解せず compositor 全体を書き換える。
- 使い捨て verify スクリプトを大量にコミットしたままにする。
- バグ修正で下位スキル（特に debug-visual-render-bug）をスキップする。
- expression ランタイムを変えて `npm run build:player` をユーザー任せにする（エージェントが shell で実行する）。

## この repo の worked example（要約）

| 事例 | Phase 2 の局在化 | Phase 3–4 の要点 |
|------|-----------------|-----------------|
| MP4 Live 調整 parity | foreignObject は backdrop 非対応 → exporter 経路 | ステートレス compositor 化・経路間スクショ比較 |
| camera bundle 誤 bake | `BUILTIN_COMPONENT_TYPES` 漏れ → bundle のみ | 1 行追加 + bake 回帰テスト |
| nested fps 2 倍速 | stale `this.currentComp.fps` → resolve 注入で統一 | 実機 frame 対応表で 1 倍速確認 |
| reparent + KF | 1 KF だけ補正 → 全 KF frame で world 保持 | 純関数テスト + Playwright |
| video export 正常化 | foreignObject は `<video>` 不可 → 共有 capture 変更 | 型別 `inlineVideoFrames`/`exportVideoStep` + 既存 export 無回帰 |
| Fast displacement ドリフト | host rect 偽陽性 → ink centroid へ | implement-visual-effect の経路統一 |
| video export ちらつき・もっさり再発 | `exportVideoStep` の `play()`＝実時間進行が export の離散フレーム処理とズレ前後振動／`k/fps` ちょうど seek が float 丸めで前フレーム選択（毎2〜3フレーム重複） | `play()` 廃止し決定論 seek／seek 先を `target+0.5fps`（フレーム中央）に統一・scrub と共有。**静止画に近い既存検証アセットは動き検出に使えない**ため `ffmpeg testsrc2` 等で動く素材を別途用意して検証 |

詳細は各 issue 節・下位スキルの worked example を参照。
