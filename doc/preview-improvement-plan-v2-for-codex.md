# Preview Improvement Plan v2 — Codex 実装プラン（厳格版）

- 日付: 2026-07-08
- 親ドキュメント（設計根拠・仮説の全文）: [doc/preview-rendering-improvement-idea-v2.md](preview-rendering-improvement-idea-v2.md) — **実装前に必読**
- 実測レポート（失敗教訓の正本）: [doc/issue/fucked-up-preview/report.md](issue/fucked-up-preview/report.md)

## 0. 役割分担（このプランの前提）

| Phase | 担当 | 成果物 |
|-------|------|--------|
| **Phase 0**（計測・判別因子の確定） | **Claude Code + Sonnet 5 サブエージェント** | `doc/issue/preview-loop-wrap/decision-record.md`（§3 のスキーマ） |
| **Phase 1 以降**（実装） | **Codex（GPT-5.5-Codex medium）** | 本プランの WP（Work Package）単位のコミット |
| 受け入れ計測（実ピクセル） | Claude Code / ユーザー（実 Chrome headed が必要） | capture 結果を decision-record / codex-status に追記 |

**Codex は `decision-record.md` の `status: FINAL` を確認するまで、いかなる実装も開始してはならない。** 存在しない・DRAFT のままなら §9 のエスカレーション手順で停止する。

---

## 1. Codex 運用ルール（絶対制約 — 全 WP 共通）

### 1.1 禁止事項（違反したらその WP は失敗扱い）

1. **`VideoDecoder` 明示デコードの導入・復活**（実ピクセル計測で 85% フリーズにより棄却済み。`failed/packed-videodecoder-preview` ブランチ参照）。
2. **export / scrub 経路の変更**: [src/runtime/videoElementSync.ts](../src/runtime/videoElementSync.ts) の `exportStep` 分岐（`syncVideoElementExportStep`）と scrub 分岐（L309 以降）、[src/runtime/exporter.ts](../src/runtime/exporter.ts)、[src/runtime/rasterCapture.ts](../src/runtime/rasterCapture.ts)、[src/runtime/compFrameCapture.ts](../src/runtime/compFrameCapture.ts) は**一行も変更しない**（WP-A で明示指示がある場合のみ例外）。
3. **INV-1〜INV-6・spec §5（TypeScript 型スキーマ）・`project.json` 直列化の変更**。必要に見えたら §9 で停止（ユーザー確認事項）。
4. **既存テストの改変による green 化**: 既存 `test/*.test.ts` の期待値・閾値を変更して通すことは禁止。既存テストが赤になったら実装側を直すか §9 で停止。
5. **受け入れの自己宣言**: 実ピクセル計測（freezedetect / desync）は Codex の完了条件に**含まれない**（実 Chrome headed が必要なため）。Codex は「implemented — awaiting capture」までしか宣言できない（§8）。内部カウンタ・console ログで「スムーズになった」と判断することを禁止する（report.md の測定妥当性教訓）。
6. **プラン外ファイルの修正**: 各 WP の「変更対象ファイル」リスト外を触る必要が生じたら、修正せず §9 で停止。

### 1.2 必須手順（各 WP の完了前に毎回・順番どおり）

```
1. npm run typecheck        # エラー 0 必須
2. npm test                 # 全 green 必須（既存テスト改変禁止）
3. npm run build:player     # src/runtime/ または src/player/ を触った WP は必須。
                            # 本プランの WP-1/WP-2 は必ず該当する（previewPlaybackLoop.ts /
                            # playbackVideoSync.ts / videoElementSync.ts は bundle player が import する）。
                            # 生成された public/player.js もコミットに含める。
4. progress.md の先頭にセッション記録を追記（完了 WP / 未了 / 既知の課題）
5. doc/issue/preview-loop-wrap/codex-status.md を §8 の形式で更新
```

### 1.3 spec 更新（先に仕様、次に実装）

各 WP の実装**前**に、[doc/mafter-effect-spec.md](mafter-effect-spec.md) の **§11.4（preview 再生同期）/ §16.2（packed alpha）へ散文を追記**する（WP ごとの指定は各節に記載）。散文のみ。**§5 型スキーマと INVARIANT には触れない。** 触れる必要があると判断した時点で §9 停止。

### 1.4 ブランチ・コミット規約

- WP ごとに `main` から `codex/preview-v2-<WP名>` ブランチを切る（例: `codex/preview-v2-wp1-loop-doublebuffer`）。
- コミットメッセージ: `preview v2 <WP名>: <要約>`。WP 内で spec 追記 → 実装 → テストの順にコミットを分ける。
- `main` への merge はユーザー / Claude のレビュー後（Codex は merge しない）。

---

## 2. 必読ファイル（実装開始前に全部読む・読了を codex-status に記録）

| ファイル | 読む目的 |
|---|---|
| [doc/preview-rendering-improvement-idea-v2.md](preview-rendering-improvement-idea-v2.md) | 仮説 H1〜H5・Idea 1〜6 の設計根拠 |
| [doc/issue/preview-loop-wrap/decision-record.md](issue/preview-loop-wrap/decision-record.md) | **どの WP をどの順で実施するかの唯一の正**（§3） |
| [src/runtime/previewPlaybackLoop.ts](../src/runtime/previewPlaybackLoop.ts) | タイムラインクロック（rAF）と loop wrap の現行実装 |
| [src/runtime/playbackVideoSync.ts](../src/runtime/playbackVideoSync.ts) | 双方向ゲート（hold/pause）の状態機械。WP-2 の主戦場 |
| [src/runtime/videoElementSync.ts](../src/runtime/videoElementSync.ts) | playbackMode / scrub / exportStep の 3 分岐。**playbackMode 分岐以外は不可侵** |
| [src/runtime/videoElementPool.ts](../src/runtime/videoElementPool.ts) + [src/runtime/videoLookaheadWarmup.ts](../src/runtime/videoLookaheadWarmup.ts) | WP-1 が再利用する既存 warm-up/プール機構 |
| [src/runtime/DomRenderer.ts](../src/runtime/DomRenderer.ts) の video 分岐（`case "video"` 周辺、L2174〜2330 目安） | 要素取得・カット境界・packed 合成の配線 |
| [src/editor/panels/PreviewPanel.tsx](../src/editor/panels/PreviewPanel.tsx) L604〜730 | 再生ループ起動・`applyPlaybackSync`・PreviewAudioClock 分岐 |
| [src/player/BundlePlayer.ts](../src/player/BundlePlayer.ts) | previewPlaybackLoop / playbackVideoSync の共有先（回帰対象） |
| test/playbackVideoSync.test.ts, test/videoElementSync.test.ts, test/videoLookaheadWarmup.test.ts, test/videoElementPool.test.ts | 既存テストの流儀（これに合わせて追加する） |

---

## 3. decision-record.md のスキーマ（Phase 0 成果物・Codex の入力）

Phase 0（Claude + Sonnet 5 サブエージェント）が Comp33 fixture で per-wrap 分類計測を行い、以下を確定させる:

```markdown
# preview-loop-wrap decision record
- status: FINAL            # FINAL 以外なら Codex は着手禁止
- date: YYYY-MM-DD
- fixture: <mini-project zip のパス>
## baseline（修正前の実測値）
- freeze_pct_30s: <number>%
- desync_p95_frames: <number>
- wrap_freeze_ms_median: <number>
- wrap_freeze_ms_max: <number>
## discriminator（S3 スムーズループの判別因子・実測で確定）
- discriminator: cache-overlay | buffered | gate-state | keyframe-distance | mixed | unknown
- evidence: <per-wrap 分類表の要約と生データへのリンク>
## route（Codex が実施する WP と順序）
- order: [<WP-ID>, <WP-ID>, ...]
- notes: <WP ごとの追加制約があれば>
```

**Codex は `order` に列挙された WP を、列挙順に 1 つずつ実施する。** 列挙されていない WP は実施しない。`discriminator` を Codex が再解釈・上書きすることは禁止。

### 決定ゲート表（Phase 0 が route を決めるときの規則・参考掲示）

| discriminator | 第一選択 | 理由 |
|---|---|---|
| cache-overlay | WP-A | bake 完了時は既にスムーズと実証済み → 常時成立させるのが最安 |
| buffered | WP-1 | buffered 依存は制御不能。ダブルバッファで決定論化 |
| gate-state | WP-2 → WP-1 | ゲート発振が主因。サーボ化を先に |
| keyframe-distance | WP-3 → WP-1 | GOP 短縮で seek 自体を軽くしてから |
| mixed / unknown | WP-1 → WP-2 | 判別不能時は構造的解（ダブルバッファ + サーボ） |

---

## 4. WP-1 — ループ折り返しダブルバッファ（Idea 1 / 対応: S2）

**目標**: loop ON 再生の折り返しで、表示中クリップ用の 2 本目の `<video>` を事前 warm-up しておき、wrap フレームで要素を交代させる。wrap 時の裸 seek（キーフレーム探索フリーズ）を排除する。

**spec 追記（実装前）**: §11.4 に「ループ再生の折り返しは、loopEnd 手前 1 秒（`fps` フレーム）以内に入った時点で loopStart のソース時刻へ warm-up した交代要素を準備し、wrap フレームでカット境界と同型の要素交代を行う」を散文で追記。

**変更対象ファイル（これ以外は触らない）**:

| ファイル | 変更内容 |
|---|---|
| [src/runtime/videoLookaheadWarmup.ts](../src/runtime/videoLookaheadWarmup.ts) | 純関数拡張: `VideoLookaheadOptions` に `loop?: { enabled: boolean; loopStart: Frame; loopEnd: Frame }` を追加。loop 有効かつ `loopEnd - currentFrame <= lookahead` のとき、**loopStart 時点で active な video クリップ**（`inPoint <= loopStart < outPoint`）を `targetSec = (trimStart + (loopStart - inPoint)) / fps` で warm-up 対象に追加する。既存の「`currentFrame >= inPoint` は除外」規則はループ対象には適用しない（ここが今回の穴）。同一 asset 除外（`activeAssetIds`）もループ対象には適用しない（表示中クリップ自身が対象のため）。 |
| [src/runtime/DomRenderer.ts](../src/runtime/DomRenderer.ts) | (a) `setPreviewRenderOptions` に loop 情報（enabled/loopStart/loopEnd）を受ける項目を追加し、lookahead warmup 呼び出し（`computeVideoLookaheadWarmupTargets` の call site を grep で特定）へ渡す。(b) video 分岐: 再生中（`previewVideoPlayback`）にフレームが**後退**し（前回描画フレーム > 今回フレーム）かつ今回フレームが loopStart と一致する場合、カット境界（プール再取得 + `forceSeek`）と同じ経路で warm-up 済み要素へ交代する。プールに warm-up 済み要素（同 asset・`|currentTime − loopStart時刻| <= videoSeekThresholdSec(fps)`・`readyState >= HAVE_CURRENT_DATA`）が無い場合は現行どおり同一要素 seek にフォールバック（挙動退行なし）。 |
| [src/editor/panels/PreviewPanel.tsx](../src/editor/panels/PreviewPanel.tsx) | 再生開始時に `setPreviewRenderOptions` へ loop 情報（`playbackConfigRef.current` の loopStart/loopEnd/loop）を渡す。 |
| [src/player/BundlePlayer.ts](../src/player/BundlePlayer.ts) | preview と同じ loop 情報を renderer に渡す（§11.7 と §11.4 の再生パス一致を維持）。 |
| test/videoLookaheadWarmup.test.ts | 追加テスト（下記）。既存ケースは無改変。 |

**音声規則**: 交代時、旧要素は `muted=true` → `pause()`、新要素は playbackMode の既存規則（unmute + play）に従う。unmute 順序は「旧 mute → swap → 新 unmute」。

**packed alpha**: 交代は `compositePackedAlpha` への入力 video が変わるだけで表示面（canvas）は同一。特別処理不要だが、交代時に `ensurePackedAlphaCompanion` の親子関係が壊れないこと（companion canvas は要素の parent に付く）を確認する。

**追加テスト（純関数・必須）**:
1. loop 有効・`loopEnd - currentFrame <= lookahead` → loopStart で active なクリップが `targetSec = (trimStart + (loopStart - inPoint)) / fps` で返る。
2. loop 有効だが窓外（`loopEnd - currentFrame > lookahead`）→ 返らない。
3. loop 無効 → 従来結果と完全一致（回帰）。
4. loopStart 時点で disabled / 範囲外のクリップ → 返らない。
5. 通常カット先読みとループ先読みが同時成立するケース → 両方返る（重複 objectId は 1 つに）。

**DoD**: §1.2 全項目 + 上記テスト green + `npm run build:player` 済み + codex-status 更新（`implemented — awaiting capture`）。

---

## 5. WP-2 — presented-frame 計測 + playbackRate サーボ（Idea 2+3 / 対応: S1）

**目標**: 同期誤差の計測を `video.currentTime` から **rVFC の presented `mediaTime`** に変え、pause/hold の二値ゲートを `playbackRate` の連続微調整（±4% 上限）に置き換える。hold/pause は大誤差 failsafe に格下げする。

**spec 追記（実装前）**: §11.4 の双方向同期の段落を「presented frame 基準の誤差計測 + playbackRate サーボ（±4%）。誤差が failsafe 閾値（5 フレーム）を超えた場合のみ従来の holdTimeline / pauseVideo」に改稿（散文のみ）。

**変更対象ファイル**:

| ファイル | 変更内容 |
|---|---|
| **新規** src/runtime/videoPresentedClock.ts | rVFC トラッカー。API: `attachPresentedClock(video): void` / `detachPresentedClock(video): void` / `getPresentedMediaTimeSec(video): number | null`（rVFC 非対応・未 present は null）。実装: `requestVideoFrameCallback` を自己再登録し、最後の `meta.mediaTime` を WeakMap に保持。**タイマー・rAF は使わない**（rVFC のみ）。 |
| [src/runtime/playbackVideoSync.ts](../src/runtime/playbackVideoSync.ts) | (a) `VideoClockSample` に `presentedSec?: number` を追加（optional・後方互換）。誤差計算（`maxVideoLagSec` / `maxVideoLeadSec`）は `presentedSec ?? currentTimeSec` を使う。(b) **新規純関数** `computePlaybackRateForSync(errorSec: number, fps: number): number` — 仕様: `error = targetSec − (presentedSec ?? currentTimeSec)`（正 = 映像遅れ）。デッドバンド `|error| <= 0.25/fps` → 1.0。それ以外は `1 + clamp(error * 2.0, -0.04, +0.04)`（P ゲイン 2.0 /秒、上限 ±4%）。(c) `holdThresholdsForFps`: `enterSec` を `1/f` から `5/f`（5 フレーム）に変更 = failsafe 化。`exitSec` / `maxHoldSec` は不変。 |
| [src/runtime/videoElementSync.ts](../src/runtime/videoElementSync.ts) | **playbackMode 分岐のみ**: 呼び出し側から渡される rate を `video.playbackRate` に適用（`Math.abs(video.playbackRate - rate) > 0.001` のときのみ代入）。**playbackMode を抜けるすべての箇所（scrub 分岐冒頭・pause 時・exportStep）で `playbackRate = 1` に戻す**リセットを必ず入れる。exportStep 分岐のロジック自体は不変（リセット代入 1 行のみ追加可）。 |
| [src/runtime/DomRenderer.ts](../src/runtime/DomRenderer.ts) | (a) `sampleMountedVideoClocks()` に `presentedSec`（`getPresentedMediaTimeSec`）を含める。(b) video 要素の mount/unmount で attach/detachPresentedClock。(c) `setPlaybackPauseForSync` と同型の `setPlaybackRateForSync(rate: number)` を追加し video 分岐で適用。 |
| [src/editor/panels/PreviewPanel.tsx](../src/editor/panels/PreviewPanel.tsx) | `applyPlaybackSync` 内で `computePlaybackRateForSync` を呼び `renderer.setPlaybackRateForSync(rate)` を毎 tick 適用。 |
| [src/player/BundlePlayer.ts](../src/player/BundlePlayer.ts) + [src/player/BundleAudioClock.ts](../src/player/BundleAudioClock.ts)（該当すれば） | preview 側と同じ配線（§11.4/§11.7 一致）。 |
| test/playbackVideoSync.test.ts | 追加テスト（下記）。**既存ケースのうち enterSec=1f 前提のものが赤になる場合は §9 停止**（閾値変更の影響확認はユーザー判断）— ただし既存テストが `holdThresholdsForFps(30).enterSec === 1/30` を直接主張している場合に限り、そのテストの期待値更新は「decision-record の order に WP-2 が含まれること」を根拠に許可する（§1.1-4 の唯一の例外）。 |

**追加テスト（純関数・必須）**:
1. `computePlaybackRateForSync`: デッドバンド内（|error| ≤ 0.25/30）→ 1.0。
2. 映像遅れ（error=+0.05s）→ rate > 1（速める）。映像先行 → rate < 1。**符号を間違えないこと**。
3. クランプ: error=±10s でも 0.96 ≤ rate ≤ 1.04。
4. `VideoClockSample.presentedSec` あり → lag/lead が presentedSec 基準で計算される。なし → currentTimeSec フォールバック。
5. failsafe: error 5 フレーム超で従来どおり holdTimeline/pauseVideo に遷移、exit/maxHold の既存挙動維持。

**明示的な注意**:
- `preservesPitch` は既定 true のため音声ピッチ処理の追加実装は不要。**追加しないこと。**
- rate 適用は `previewVideoPlayback === true` の経路のみ。export・scrub・停止中に playbackRate ≠ 1 が残留したら失敗（リセットのテスト不能箇所は codex-status に残留リスクとして記載）。

**DoD**: §1.2 全項目 + 上記テスト green + `npm run build:player` 済み + codex-status 更新。

---

## 6. WP-A — video コンプの RAM preview キャッシュ常時成立（Idea H5-1 / 対応: S2、discriminator=cache-overlay のときのみ）

**目標**: 「bake 完了時はループが完全にスムーズ」という Phase 0 実証を、video を含むコンプで常時成立させる。

**前提条件（decision-record に明記されていること）**: discriminator=cache-overlay、かつ Phase 0 で「video レイヤーを含むワークエリア bake がピクセル的に正しい」ことが確認済みであること。**bake が video フレームを正しく焼けていない場合、本 WP は実施不可**（§9 停止）。

**変更対象ファイル**:

| ファイル | 変更内容 |
|---|---|
| [src/editor/previewCompAnalysis.ts](../src/editor/previewCompAnalysis.ts) | `compNeedsAutoPreviewCache(comp)` に「enabled な video component を持つオブジェクトが 1 つ以上ある」条件を追加（`comp.objects[].components[]` の `type === "video"` を走査）。 |
| test/（新規）previewCompAnalysis.video.test.ts | video あり → true / video なし・effect なし → false / 既存 effect 条件の回帰。 |

**注意**: `shouldPreferCacheOverlay` / bake 実行系（ramPreview.ts / precompRasterService.ts）のロジックは**変更しない**。発火条件の 1 条件追加のみで閉じる。bake の video 決定論 seek が遅い・メモリを食う等の問題は Codex が対処せず codex-status に観測として記載する。

**DoD**: §1.2 全項目（本 WP は src/editor のみのため build:player 不要だが、実行して差分ゼロ確認を推奨）+ テスト green + codex-status 更新。

---

## 7. WP-3 — packed / proxy 再エンコードの GOP 短縮（Idea 5 / 対応: S2 補強）

**目標**: 自前 `VideoEncoder` で生成する preview 用資産（packed alpha / proxy）のキーフレーム間隔を最大 1 秒（`fps` フレーム）に固定し、seek の前方デコード距離を短縮する。

**変更対象ファイル**: `VideoEncoder` の encode 呼び出し site を `Grep: "new VideoEncoder"` で列挙し、**preview 資産生成（packed 変換・proxy 生成）に該当するもののみ**変更する。export 本経路（[src/runtime/exporter.ts](../src/runtime/exporter.ts) 系）の encoder 設定は**触らない**。

**実装**: フレームループで `frameIndex % keyIntervalFrames === 0` のとき `encoder.encode(frame, { keyFrame: true })`。`keyIntervalFrames = Math.max(1, Math.round(fps))`。マジックナンバー禁止、定数を videoPackedAlpha.ts か該当モジュールに export して単体テスト可能にする。

**追加テスト**: keyInterval 計算の純関数テスト（fps=30→30、fps=24→24、fps=0.5→1）。エンコード実体の GOP 検証は node では不可のため、codex-status に「capture 検証で mp4box/ffprobe による keyframe 間隔確認が必要」と記載。

**DoD**: §1.2 全項目 + build:player（src/runtime を触るため必須）+ codex-status 更新。

---

## 8. codex-status.md（進行の単一の正・毎 WP 更新）

パス: `doc/issue/preview-loop-wrap/codex-status.md`。形式:

```markdown
# codex status — preview improvement v2
## WP-<ID> <名前>
- state: not-started | in-progress | implemented-awaiting-capture | verified | blocked
- branch: codex/preview-v2-...
- commits: <hash 列挙>
- typecheck/test/build:player: PASS/FAIL それぞれ明記
- spec 追記: <spec の節と要約>
- 残留リスク・観測: <あれば>
- blocked の場合: §9 の質問ファイルへのリンク
```

`verified` へ遷移できるのは **Claude / ユーザーの実ピクセル capture 結果が受け入れ目標（親ドキュメント §6）を満たしたときだけ**。Codex は `implemented-awaiting-capture` で手を止め、次の WP へ進む（decision-record の order どおり）。

---

## 9. エスカレーション（停止プロトコル）

以下のいずれかに該当したら、**コードを書かずに** `doc/issue/preview-loop-wrap/codex-questions.md` へ「状況・選択肢・推奨案」を書いて該当 WP を `blocked` にし、次の WP があればそちらへ進む（依存があれば全停止）:

1. decision-record が無い / `status: FINAL` でない。
2. §5 スキーマ・INVARIANT・直列化の変更が必要に見える。
3. 変更対象ファイルリスト外の修正が必要に見える。
4. 既存テストが赤になり、実装側の修正で解決できない（§5.1 の唯一の例外を除く）。
5. 本プランと親ドキュメント・spec・実コードの間に矛盾を発見した。
6. WP-A 前提（bake の video ピクセル正しさ）が decision-record に無い。

**「たぶんこうだろう」で埋めない。** 曖昧さの解決はすべて decision-record / questions ファイル経由で行う。

---

## 10. 全体完了の定義

- decision-record の `order` の全 WP が `implemented-awaiting-capture` 以上。
- `npm run typecheck` / `npm test` green、`public/player.js` 最新。
- 受け入れ（親ドキュメント §6: 30s フリーズ率 ≤10% / desync p95 ≤1.5f / wrap フリーズ ≤150ms/回）は capture 担当（Claude / ユーザー）が判定し、満たせば `verified`。
- 未達の WP は capture 結果（数値・mp4）を添えて decision-record に追記され、次の route 判断（Phase 0 担当）に戻す。Codex が独自に追加修正を発案しない。
