# Codex 実装Plan — 静的HTML再生の適応フレームスキップ（音声優先）

> 対象: Web Bundle Export（§11.7）の実時間再生で、重いとき音声がガタつく問題。
> 方針: INV-8 を実装レベルで徹底する ＝ **音声クロックは絶対に止めない／重いときは描画呼び出しを間引き、現 frame に `resolve` でワープ**する。
> このドキュメントは Codex medium に **Ticket 単位** で投げるための作業票。Phase / WP をそのまま Codex に渡さない。

---

## Plan intake summary

- **Source document**: 本セッションの設計対話 + [doc/mafter-effect-spec.md](mafter-effect-spec.md) INV-8（L103）/ §11.7（L882-）
- **Goal**: 音声マスター時に video 遅延・重い render で音声を止めない。重いときは描画フレームを間引き、audio と frame 番号進行は毎 tick 継続。
- **Known Phases**: (P0) spec 追記 → (P1) 純関数 → (P2) 配線（音声/render/no-audio） → (P3) build:player → (P4) 検証
- **Known WPs**: WP-A spec / WP-B pure fn / WP-C audio-never-pause / WP-D render-gate wiring / WP-E no-audio gate / WP-F build+verify / WP-G human capture
- **Required gate files**: なし（decision-record / FINAL ゲートは無い）。ただし **INV-8 が既に本挙動を許容済み**であることが前提（§5型・INVARIANT・manifest 形式は変更しない）。
- **Required status files**: [progress.md](../progress.md)（最終 Ticket で更新）
- **Hard forbidden areas**:
  - **§5 データスキーマ（TypeScript 型）変更禁止**
  - **INVARIANT（INV-1..8）の追加・変更・緩和禁止**
  - **`project.json` 直列化形式・[bundleTypes.ts](../src/runtime/bundleTypes.ts) の `BundleManifest` 形状変更禁止**（UI 設定・manifest フラグは追加しない＝自動適応・UIなし）
  - **export 決定論経路変更禁止**: [exporter.ts](../src/runtime/exporter.ts) / [rasterCapture.ts](../src/runtime/rasterCapture.ts) / [compFrameCapture.ts](../src/runtime/compFrameCapture.ts) / mp4・PNG・headless 経路
  - **既存テスト期待値の変更禁止**
- **Allowed file policy**: 各 Ticket の Allowed files のみ。範囲外が必要になったら stop して報告。
- **Required commands**: `npm run typecheck` / `npm test -- <pattern>` / `npm run build:player`
- **Required generated artifacts**: `public/player.js`（`src/runtime`・`src/player` 変更のため WP-F で再ビルド必須。commit 対象）
- **Human verification required**: 実ブラウザでの**音声連続性（グリッチ無し）**と重負荷時の描画間引き挙動。Codex は自己完了宣言しない（WP-G で人間 / headed browser に委譲）。
- **Ambiguities**: 「render 占有率の目標値」は実装 Ticket 内の定数で仮置きし、WP-G 実測でチューニング可能にする（別 escalation 不要）。
- **First safe action**: Ticket 00（read-only gate/route 確認）。

---

## 確定済み設計判断（ユーザー確認済み・Codex は覆さない）

1. **映像デコード遅延時、音声は止めない（INV-8 徹底）**。`holdTimeline` の音声 pause を audio-master 時は無効化。映像は per-element seek/`pauseVideo` でドリフト吸収。
2. **自動適応・UI なし**。render 所要時間の EMA 予算から自動でフレーム間引き量を決める。export UI・manifest にトグルは追加しない。
3. スコープは **実時間再生の平滑性のみ**。INV-2（frame ごとの `resolve` 決定論）・mp4/PNG/headless 出力は不変。

---

## 変更対象ファイル一覧（全体像）

| ファイル | 種別 | 触る Ticket |
|---|---|---|
| [doc/mafter-effect-spec.md](mafter-effect-spec.md) | spec §11.7 追記 | 01 |
| `src/runtime/adaptiveRenderBudget.ts` | **新規** 純関数 | 02 |
| `test/adaptiveRenderBudget.test.ts` | **新規** unit test | 02 |
| [src/player/BundleAudioClock.ts](../src/player/BundleAudioClock.ts) | audio-never-pause | 03 |
| [src/player/BundlePlayer.ts](../src/player/BundlePlayer.ts) | render-gate 配線 | 04 |
| [src/runtime/previewPlaybackLoop.ts](../src/runtime/previewPlaybackLoop.ts) | opt-in gate（no-audio） | 05 |
| `public/player.js` | 再ビルド生成物 | 06 |
| [progress.md](../progress.md) | 進捗記録 | 06 |

---

## Ticket 一覧

### Ticket 00 — Gate / route 確認（read-only）

- **Owner**: Codex small もしくは Claude
- **Model**: small
- **Size**: ~10分
- **Purpose**: 実装前提の確認だけ。実装しない。
- **Allowed files**: なし（read-only）
- **Forbidden files**: すべて（コード変更禁止）
- **Pre-read**: このドキュメント全体 / spec INV-8（L103）/ §11.7（L882-）
- **Implementation scope**: なし
- **Steps**:
  1. INV-8 が「audio master + frame drop」を許容していることを確認。
  2. `BundleManifest`（[bundleTypes.ts](../src/runtime/bundleTypes.ts)）に手を入れずに済む（UI/manifest 変更なし）ことを確認。
  3. [BundleAudioClock.ts](../src/player/BundleAudioClock.ts) の `tick` 内 `holdTimeline` 音声 pause ブロック（現状 L213-229 付近）の位置を特定。
  4. [BundlePlayer.ts](../src/player/BundlePlayer.ts) の `setFrameCallback` / `renderFrame`（現状 L154-157, L381-386 付近）の位置を特定。
- **Tests / commands**: なし
- **Generated artifacts**: なし
- **Stop conditions**: 上記のいずれかが前提と食い違ったら stop して報告。
- **Completion report**: 各対象の現在行番号 / 前提の整合可否 / 実装開始可否 / blocker。
- **Prompt to Codex**:
  ```
  Read-only reconnaissance for the adaptive frame-skip plan.

  Do not edit any files.

  Confirm and report line numbers:
  1. INV-8 in doc/mafter-effect-spec.md sanctions "audio master + frame drop".
  2. The holdTimeline audio-pause block inside BundleAudioClock.tick.
  3. setFrameCallback usage and renderFrame in BundlePlayer.ts.
  4. Whether BundleManifest (src/runtime/bundleTypes.ts) needs NO changes.

  Report:
  - Current line numbers for each
  - Whether the plan's assumptions still hold
  - Whether implementation may begin
  - Blockers

  Do not write code. Do not continue into implementation.
  ```

---

### Ticket 01 — spec §11.7 追記のみ

- **Owner**: Codex medium
- **Model**: medium
- **Size**: ~15分
- **Purpose**: 実装契約を spec に明文化（先に spec）。
- **Allowed files**: [doc/mafter-effect-spec.md](mafter-effect-spec.md)
- **Forbidden files**: それ以外すべて。**§5 型・INVARIANT テーブル・INV-8 本文は変更しない**（新規小節の追記のみ）。
- **Pre-read**: §11.7（L882-）/ INV-8（L103）
- **Implementation scope**: §11.7 に「実時間再生の適応 frame drop 契約」小節を1つ追記:
  - 音声マスター時は video 遅延で音声を止めない（`holdTimeline` の音声 pause 無効化）。映像は per-element seek / `pauseVideo` でドリフト吸収。
  - render は best-effort。render 所要時間の EMA 予算に基づき描画呼び出しを間引く（音声・frame 番号進行は毎 tick 継続）。
  - INV-2・mp4/PNG/headless の決定論には影響しない旨を明記。
- **Explicit non-goals**: INVARIANT の新設・変更、§5 型変更、コード変更。
- **Steps**: §11.7 の既存記述の直後に小節追記。既存文の意味を変えない。
- **Tests / commands**: なし（散文のみ）
- **Generated artifacts**: なし
- **Stop conditions**: INV や §5 型に触れる必要が出たら stop（このプランはそれを禁止）。
- **Completion report**: 追記した節見出し / 変更行範囲 / INV・§5 未変更の確認。
- **Prompt to Codex**:
  ```
  Implement only Ticket 01.

  Allowed files:
  - doc/mafter-effect-spec.md

  Forbidden:
  - Do not modify §5 TypeScript schemas
  - Do not modify the INVARIANT table or INV-8 wording
  - Do not touch any source code

  Goal:
  Add ONE new subsection under §11.7 describing the adaptive real-time
  frame-drop contract:
  - Audio master is never paused for video lag (holdTimeline audio-pause
    disabled when audio is master); video absorbs drift via per-element
    seek / pauseVideo.
  - Rendering is best-effort and may be skipped based on an EMA render-cost
    budget; audio and frame-number progression continue every tick.
  - Explicitly note this does NOT affect INV-2 or mp4/PNG/headless determinism.

  Non-goals:
  - No new/changed invariants
  - No schema changes
  - No code changes

  Run: none (prose only)

  Stop if: you need to touch INV or §5 schema.

  Report: subsection heading, changed line range, confirmation INV/§5 untouched.

  Do not continue to the next ticket.
  ```

---

### Ticket 02 — 純関数 `adaptiveRenderBudget` + unit test

- **Owner**: Codex medium
- **Model**: medium
- **Size**: ~25分
- **Purpose**: render 間引き判定を純関数で隔離（[playbackVideoSync.ts](../src/runtime/playbackVideoSync.ts) と同じパターン）。
- **Allowed files**:
  - `src/runtime/adaptiveRenderBudget.ts`（新規）
  - `test/adaptiveRenderBudget.test.ts`（新規）
- **Forbidden files**: 既存 runtime / player / UI / export すべて。既存テスト改変禁止。
- **Pre-read**: [playbackVideoSync.ts](../src/runtime/playbackVideoSync.ts)（純関数 + state 遷移 + test の書き味を踏襲）
- **Implementation scope**（DOM / タイマー非依存の純関数のみ）:
  - `interface RenderBudgetState { renderCostEmaMs: number; lastRenderMs: number | null; }`
  - `initialRenderBudgetState(): RenderBudgetState`
  - `recordRenderCost(state, costMs): RenderBudgetState` — EMA 更新（係数は定数）。
  - `computeRenderGate(state, nowMs, msPerFrame): { render: boolean; nextState: RenderBudgetState }`
    - 軽負荷（EMA < msPerFrame）: 毎フレーム render（最小間隔 = msPerFrame）。
    - 重負荷: 最小 render 間隔 = `renderCostEmaMs / targetOccupancy`（`targetOccupancy` は定数、例 0.6）。`nowMs - lastRenderMs` がそれ未満なら `render: false`。
    - `lastRenderMs === null`（初回）は必ず `render: true`。
    - `render: true` のとき `nextState.lastRenderMs = nowMs`。
- **Explicit non-goals**: DOM 参照、rAF、audio、既存モジュールへの配線は一切しない。
- **Steps**: 型 → 初期化 → EMA → gate → test。
- **Tests / commands**:
  - `npm test -- adaptiveRenderBudget`
  - 型エラー時 `npm run typecheck`
- **Test cases（最低限）**:
  - 軽負荷（cost=5ms, fps=60）で連続 tick が毎フレーム `render: true`。
  - 重負荷（cost=50ms, targetOccupancy=0.6）で render 間隔が ~83ms に間引かれる。
  - 負荷回復で間隔が msPerFrame まで戻る。
  - 初回 tick は必ず render。
- **Generated artifacts**: なし
- **Stop conditions**: 既存呼び出し側の API 変更が必要になったら stop（このチケットは純関数のみ）。
- **Completion report**: 追加 export 一覧 / test 実行結果 / typecheck 結果 / 残作業。
- **Prompt to Codex**:
  ```
  Implement only Ticket 02.

  Allowed files:
  - src/runtime/adaptiveRenderBudget.ts (new)
  - test/adaptiveRenderBudget.test.ts (new)

  Forbidden:
  - Do not edit any existing runtime/player/UI/export files
  - Do not change existing test expectations
  - No DOM, no rAF, no audio, no wiring — pure functions only

  Goal (mirror the pure-function + state pattern of playbackVideoSync.ts):
  - RenderBudgetState { renderCostEmaMs, lastRenderMs }
  - initialRenderBudgetState()
  - recordRenderCost(state, costMs) -> state  (EMA, constant coefficient)
  - computeRenderGate(state, nowMs, msPerFrame) -> { render, nextState }
    * light load (EMA < msPerFrame): render every frame (min interval = msPerFrame)
    * heavy load: min render interval = renderCostEmaMs / targetOccupancy
      (constant targetOccupancy, e.g. 0.6); render:false if interval not elapsed
    * lastRenderMs === null -> render:true
    * on render:true set nextState.lastRenderMs = nowMs

  Tests (test/adaptiveRenderBudget.test.ts):
  - light load renders every frame
  - heavy load thins render interval (~cost/occupancy)
  - recovery returns interval to msPerFrame
  - first tick always renders

  Run:
  - npm test -- adaptiveRenderBudget
  - npm run typecheck if type errors appear

  Stop if: existing callers require an API change.

  Report: exports added, tests run, typecheck result, remaining work, blockers.

  Do not continue to the next ticket.
  ```

---

### Ticket 03 — BundleAudioClock: audio-never-pause（INV-8 徹底）

- **Owner**: Codex medium
- **Model**: medium
- **Size**: ~20分
- **Purpose**: audio-master 時に `holdTimeline` で音声を止めない。
- **Allowed files**: [src/player/BundleAudioClock.ts](../src/player/BundleAudioClock.ts)
- **Forbidden files**: [BundlePlayer.ts](../src/player/BundlePlayer.ts) / [playbackVideoSync.ts](../src/runtime/playbackVideoSync.ts) / renderer / exporter。既存テスト改変禁止。
- **Pre-read**: [BundleAudioClock.ts](../src/player/BundleAudioClock.ts) `tick`（L197-277）/ [playbackVideoSync.ts](../src/runtime/playbackVideoSync.ts)
- **Implementation scope**:
  - コンストラクタ or `BundleAudioClockSyncOptions` に `audioMaster: boolean`（既定 true）を追加。**型シグネチャの破壊的変更はしない**（optional にする）。
  - `audioMaster` のとき `tick` 内の `holdTimeline` 分岐で**音声要素を pause せず、`onFrame` も止めない**（frozenFrame 経路をスキップ）。`pauseVideo`（映像先行時の video pause）は従来どおり `onPlaybackSyncState` 経由で残す。
  - `computePlaybackRateForSync` / `sampleClockSamples` 呼び出しは維持（video servo は残す）。
  - hold 解除の再アンカー（`reanchorStartWallMsAfterHold`）は audio-never-pause では不要経路になるが、既存の純関数・その unit test は**消さない**（後方互換）。
- **Explicit non-goals**: render gate（Ticket 04）、no-audio 経路（Ticket 05）は触らない。
- **Steps**: フラグ追加 → hold 分岐を audioMaster で条件化 → pauseVideo 経路維持 → 影響ある既存 test を確認（期待値は変えない・落ちたら報告）。
- **Tests / commands**:
  - `npm test -- BundleAudioClock`（存在すれば）
  - `npm run typecheck`
- **Generated artifacts**: なし（player.js 再ビルドは Ticket 06 に集約）
- **Stop conditions**:
  - `playbackVideoSync.ts` の純関数変更が必要になったら stop。
  - 既存 BundleAudioClock テストが期待値変更なしでは通らない場合は stop して報告（勝手に期待値を書き換えない）。
- **Completion report**: 変更点 / audioMaster 既定値 / pauseVideo 維持の確認 / test・typecheck 結果 / blocker。
- **Prompt to Codex**:
  ```
  Implement only Ticket 03.

  Allowed files:
  - src/player/BundleAudioClock.ts

  Forbidden:
  - Do not edit BundlePlayer.ts, playbackVideoSync.ts, renderer, exporter
  - Do not change existing test expectations
  - Do not delete existing pure helpers (reanchorStartWallMsAfterHold etc.)

  Goal:
  Add an optional `audioMaster` flag (default true). When audioMaster is true,
  the tick() holdTimeline branch must NOT pause audio elements and must NOT
  freeze onFrame (skip the frozenFrame path). Keep pauseVideo (video-lead)
  behavior via onPlaybackSyncState, and keep the video playbackRate servo.

  Non-goals:
  - No render gating (Ticket 04)
  - No no-audio path changes (Ticket 05)
  - No API break: audioMaster must be optional

  Run:
  - npm test -- BundleAudioClock (if such tests exist)
  - npm run typecheck

  Stop if:
  - playbackVideoSync.ts pure functions need changes
  - existing BundleAudioClock tests can't pass without changing expectations

  Report: changes, default value, pauseVideo-preserved confirmation, test/typecheck results, blockers.

  Do not continue to the next ticket.
  ```

---

### Ticket 04 — BundlePlayer: render-gate 配線（音声経路）

- **Owner**: Codex medium
- **Model**: medium
- **Size**: ~25分
- **Purpose**: audio clock の frame callback で render を間引く。frame 番号進行・audio gain は毎 tick 継続。
- **Allowed files**: [src/player/BundlePlayer.ts](../src/player/BundlePlayer.ts)
- **Forbidden files**: BundleAudioClock.ts / adaptiveRenderBudget.ts（import して使うのみ・中身は変えない）/ renderer / exporter。既存テスト改変禁止。
- **Pre-read**: [BundlePlayer.ts](../src/player/BundlePlayer.ts) の音声経路（L138-171）/ `renderFrame`（L381-386）/ Ticket 02 で追加した `adaptiveRenderBudget` の API
- **Implementation scope**:
  - `BundleAudioClock` 生成時に `audioMaster: true`（Ticket 03 のフラグ）を渡す。
  - `setFrameCallback` の中で `RenderBudgetState` を保持し、`computeRenderGate` が `render: true` のときだけ `this.renderFrame(f)` を呼ぶ。`render: false` の tick は render を呼ばず `currentFrame` の更新のみ。
  - `renderFrame` を `performance.now()` で実測し `recordRenderCost` で EMA 更新。
  - `pause()` / ended コールバックで**最終 frame を必ず1回 render**（間引き中フレームでの静止防止）。
  - no-audio 経路（`play()` / `runPreviewPlaybackLoop`）は Ticket 05 で扱うのでここでは触らない。
- **Explicit non-goals**: adaptiveRenderBudget や BundleAudioClock の内部変更、no-audio 経路。
- **Steps**: audioMaster 付与 → gate 状態フィールド追加 → callback で gate → renderFrame 計測 → pause/ended の最終 render。
- **Tests / commands**:
  - `npm run typecheck`
  - `npm test`（bundle / player 関連が緑・**既存期待値は変更しない**）
- **Generated artifacts**: なし（Ticket 06 で build:player）
- **Stop conditions**: BundleAudioClock / adaptiveRenderBudget の API 変更が必要になったら stop。
- **Completion report**: 配線点 / gate の分岐 / renderFrame 計測箇所 / 最終 render 保証 / typecheck・test 結果 / blocker。
- **Prompt to Codex**:
  ```
  Implement only Ticket 04.

  Allowed files:
  - src/player/BundlePlayer.ts

  Forbidden:
  - Do not edit BundleAudioClock.ts or adaptiveRenderBudget.ts (import only)
  - Do not edit renderer or exporter
  - Do not change existing test expectations
  - Do not touch the no-audio play() / runPreviewPlaybackLoop path (Ticket 05)

  Goal (audio path only):
  - Pass audioMaster:true when constructing BundleAudioClock.
  - Hold a RenderBudgetState; in the frame callback call this.renderFrame(f)
    only when computeRenderGate returns render:true; otherwise update
    currentFrame without rendering.
  - Measure renderFrame cost via performance.now() and feed recordRenderCost.
  - On pause() and the ended callback, force ONE final render of the latest
    frame (avoid freezing on a skipped frame).

  Run:
  - npm run typecheck
  - npm test (bundle/player related must stay green; do not edit expectations)

  Stop if: BundleAudioClock or adaptiveRenderBudget API must change.

  Report: wiring points, gate branch, render-cost measurement, final-render guarantee, typecheck/test results, blockers.

  Do not continue to the next ticket.
  ```

---

### Ticket 05 — previewPlaybackLoop: opt-in render gate（no-audio 経路）

- **Owner**: Codex medium
- **Model**: medium
- **Size**: ~20分
- **Purpose**: 音声なし bundle 再生でも同じ間引きを適用。**editor Preview は既定 OFF で無回帰**。
- **Allowed files**:
  - [src/runtime/previewPlaybackLoop.ts](../src/runtime/previewPlaybackLoop.ts)
  - [src/player/BundlePlayer.ts](../src/player/BundlePlayer.ts)（no-audio 経路のオプション渡しのみ）
- **Forbidden files**: editor 側 PreviewPanel（配線しない）/ adaptiveRenderBudget.ts（import のみ）/ exporter / renderer。既存テスト改変禁止。
- **Pre-read**: [previewPlaybackLoop.ts](../src/runtime/previewPlaybackLoop.ts)（editor Preview パネルと共有・L1-3 のコメント）/ BundlePlayer `play()`（L257-301）
- **Implementation scope**:
  - `PreviewPlaybackLoopOptions` に **optional** `renderGate?`（未指定なら現状完全互換 = 毎フレーム render）を追加。
  - `runPreviewPlaybackLoop` の render 呼び出し前に、`renderGate` があればそれで間引き判定（advance>0 で frame は進めるが render をスキップ可能）。frame 番号・onFrameChange は従来どおり。終了フレームは必ず render。
  - BundlePlayer の no-audio `play()` から `renderGate`（adaptiveRenderBudget ベース）を渡す。**editor Preview パネルは `renderGate` を渡さない**＝挙動不変。
- **Explicit non-goals**: editor Preview の挙動変更、adaptiveRenderBudget 内部変更。
- **Steps**: optional オプション追加 → gate 分岐 → BundlePlayer no-audio 経路で opt-in。
- **Tests / commands**:
  - `npm run typecheck`
  - `npm test -- previewPlaybackLoop`（存在すれば・**既存期待値は変えない**）
- **Generated artifacts**: なし（Ticket 06）
- **Stop conditions**: editor PreviewPanel の変更が必要になったら stop（無回帰が壊れる兆候）。
- **Completion report**: 追加 optional の互換性 / editor 未配線の確認 / 終了フレーム render 保証 / test・typecheck 結果 / blocker。
- **Prompt to Codex**:
  ```
  Implement only Ticket 05.

  Allowed files:
  - src/runtime/previewPlaybackLoop.ts
  - src/player/BundlePlayer.ts (no-audio play() option pass-through only)

  Forbidden:
  - Do not wire the editor PreviewPanel (must stay default OFF / unchanged)
  - Do not edit adaptiveRenderBudget.ts (import only), exporter, renderer
  - Do not change existing test expectations

  Goal:
  - Add an OPTIONAL renderGate to PreviewPlaybackLoopOptions (absent =
    fully backward-compatible = render every frame).
  - In runPreviewPlaybackLoop, when renderGate is present, allow skipping the
    render call while still advancing frame number / onFrameChange. Always
    render the final frame.
  - From BundlePlayer's no-audio play(), pass a renderGate built on
    adaptiveRenderBudget. The editor PreviewPanel must NOT pass renderGate.

  Run:
  - npm run typecheck
  - npm test -- previewPlaybackLoop (if present; do not edit expectations)

  Stop if: editor PreviewPanel needs changes.

  Report: optional-option compat, editor-untouched confirmation, final-frame render guarantee, test/typecheck results, blockers.

  Do not continue to the next ticket.
  ```

---

### Ticket 06 — full verification + build:player + progress 更新

- **Owner**: Codex medium
- **Model**: medium
- **Size**: ~20分
- **Purpose**: 生成物再ビルドと無回帰確認、進捗記録。
- **Allowed files**:
  - `public/player.js`（`npm run build:player` の生成物のみ・手編集しない）
  - [progress.md](../progress.md)
- **Forbidden files**: それ以外のソース（この Ticket では実装しない）。既存テスト改変禁止。
- **Pre-read**: [CLAUDE.md](../CLAUDE.md) の「bundle player 再ビルド」節 / [test/playerBuildFreshness.test.ts](../test/playerBuildFreshness.test.ts)
- **Implementation scope**:
  - `npm run build:player` を実行し `public/player.js` を更新（`src/runtime`・`src/player` を変更済みのため必須）。
  - 無回帰コマンドを実行:
    - `npm run typecheck`
    - `npm test`（特に adaptiveRenderBudget / bundle / raster / **playerBuildFreshness**）
    - 既存 `verify-*-export*.mjs` のうち該当するもの（bundle / export）を実行。
  - [progress.md](../progress.md) に本タスクの完了範囲・残（人間 capture）を追記。
- **Explicit non-goals**: 新規実装・ロジック変更。テスト期待値変更。
- **Steps**: build:player → typecheck → test → verify スクリプト → progress 追記。
- **Tests / commands**: 上記すべて。
- **Generated artifacts**: `public/player.js`（**commit 対象**）。
- **Stop conditions**:
  - `playerBuildFreshness` が落ちる / build:player が失敗 → 修正が必要なら stop して報告（原因ファイルが allowed 外なら勝手に直さない）。
  - 既存 export verify が回帰したら stop（実装 Ticket 02-05 のどれに起因かを報告）。
- **Completion report**: build:player 結果 / 各コマンド結果（PASS/FAIL）/ progress 追記箇所 / 回帰有無 / blocker。
- **Prompt to Codex**:
  ```
  Implement only Ticket 06.

  Allowed files:
  - public/player.js (regenerated by npm run build:player; do not hand-edit)
  - progress.md

  Forbidden:
  - Do not edit any other source files (no new logic here)
  - Do not change existing test expectations

  Goal:
  - Run `npm run build:player` to refresh public/player.js (src/runtime and
    src/player changed -> rebuild is mandatory).
  - Regression gate:
    * npm run typecheck
    * npm test (esp. adaptiveRenderBudget, bundle, raster, playerBuildFreshness)
    * relevant existing verify-*-export*.mjs (bundle/export)
  - Append this task's completed scope + remaining human-capture item to progress.md.

  Stop if:
  - playerBuildFreshness fails or build:player fails and the fix is outside allowed files
  - any existing export verify regresses (report which of Tickets 02-05 likely caused it)

  Report: build:player result, each command PASS/FAIL, progress.md edit location, regression status, blockers.

  Do not continue to the next ticket.
  ```

---

### Ticket 07 — 人間 capture handoff（Codex は自己完了宣言しない）

- **Owner**: 人間 / headed browser（Claude が Playwright verify harness で駆動）
- **Model**: — （Codex 対象外）
- **Purpose**: 実ブラウザでの受け入れ確認。**Codex はこの受け入れを完了扱いにしない。**
- **検証項目**:
  1. 重い raster effect ＋音声のコンプを HTML bundle 書き出し → 実ブラウザ再生。
  2. **音声にグリッチ / 途切れが無い**（Before は holdTimeline で途切れていた）。
  3. 重負荷時に描画フレームが間引かれる（フレーム番号は wall-clock 追従・現 frame に resolve ワープ）。
  4. 負荷が軽いコンプでは間引きが起きず従来どおり。
  5. editor Preview パネルの再生挙動が不変（無回帰）。
- **チューニング**: 音声がまだ途切れる場合、`targetOccupancy` 定数を下げる（Ticket 02 のファイル）。この調整は実測後に別 Ticket 化。
- **記録**: 結果を [progress.md](../progress.md) に追記。

---

## 依存順序（route）

```
00 (gate) → 01 (spec) → 02 (pure fn) → 03 (audio-never-pause)
        → 04 (render-gate wiring) → 05 (no-audio gate) → 06 (build+verify) → 07 (human capture)
```

- 02 は 03/04/05 の前提（純関数を先に固める）。
- 03 と 04/05 は「音声を止めない」＋「render 間引き」の直交する2軸。04 は 03 のフラグに依存。
- 06 は 01-05 完了後にまとめて build:player + 無回帰。
- 07 は 06 の後、人間受け入れ。

## Codex に渡さない前提（Claude 側で保持）

- 「なぜ音がガタつくか」の根本原因分析（holdTimeline の音声 pause / main-thread 占有）は Claude の世界観。Codex には各 Ticket の作業票のみ渡す。
- `targetOccupancy` の最終値・体感チューニングは人間実測（Ticket 07）に委ねる。
