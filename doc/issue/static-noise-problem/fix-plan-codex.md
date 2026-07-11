# Codex 実行用 分解: sample-safe bundle loop audio

> 戦略・設計意図の正本は [`fix-plan.md`](fix-plan.md)。本書はそれを **Codex medium が燃えずに実行できる Ticket 群**へ落とした作業票である。
> Codex には Phase / WP を投げない。Claude が WP を選び、以下の Ticket 単位で 1 枚ずつ渡す。
> 各 Ticket の `Prompt to Codex` を **そのままコピーして 1 Ticket ずつ**投げる。Codex には本書全体を読ませない（探索範囲が広がり usage を焼く）。

---

## Plan intake summary

- **Source document:** [`fix-plan.md`](fix-plan.md) / 調査は [`report.md`](report.md)
- **Goal:** bundle のループ継ぎ目（video 内蔵音声・standalone audio）のクリック音を、適応フレームスキップ有効時でも消す。サンプル精度の Web Audio フェードで seek をくるむ。
- **Known Phases:** ①純ロジック抽出 → ②Web Audio コントローラ新設 → ③ループ/レンダラ/プレイヤー配線 → ④検証。
- **Known WPs:** WP0 gate、WP1 spec、WP2 純関数、WP3 コントローラ、WP4 配線、WP5 検証。
- **Required gate files:** なし（`decision-record FINAL` ゲートは無い）。ただし共有経路（DomRenderer / previewPlaybackLoop）を触るため WP0 の route 確認を実装前に必須化する。
- **Required status files:** [`progress.md`](../../../progress.md)（WP5 で更新）。本 issue ディレクトリの `report.md` は更新不要（調査記録として凍結）。
- **Hard forbidden areas:**
  - `project.json` 直列化 / §5 スキーマ / INV-1〜6 の変更（このプランは型・不変条件を変えない）。
  - export 経路（`src/runtime/exporter.ts`・OfflineAudioContext mux）。
  - editor preview 経路（`src/editor/previewAudioClock.ts`・`PreviewPanel.tsx` の音声）。
  - 既存 export/preview の `video.volume` 挙動（**bundle かつコントローラ所有の video のみ**オプトインで停止。他は不変）。
- **Allowed file policy:** Ticket ごとに allowed/forbidden を明示。原則 1〜3 ファイル。
- **Required commands:** `npm run typecheck` / 対象 focused test / `npm test` / **`npm run build:player`** / `playerBuildFreshness`。`src/player` と `src/runtime` を触るため **player.js 再ビルドは必須**。
- **Required generated artifacts:** [`public/player.js`](../../../public/player.js) を WP5 で再ビルドしコミット。
- **Human verification required:** Chromium 実機で Comp 10 のループ継ぎ目を録音し「フェード gain が閾値以上の間に可聴 seek が無い / `play()` 拒否が無い / 映像連続」を確認（WP5-末尾）。**Codex はこの受け入れを自己宣言しない。**
- **Ambiguities（実装前に人間確認 = escalation Ticket 化）:**
  - **A1:** standalone audio（`BundleAudioClock` 所有の `<audio>`）と video 内蔵音声を **同一 AudioContext / 同一コントローラ**に載せるか。fix-plan は「同じタイミングモデル」を要求。→ WP0 で確認。
  - **A2:** `BundleAudioClock` は frame 進行クロックとして残し、コントローラは gain と loop envelope のみ所有するのか（要素の所有権が二重化する）。→ WP0 で確認。
- **First safe action:** WP0-00（read-only gate/route 確認、コード変更なし）。

---

## モデル役割分担（この issue 固有）

| 役割 | 担当 | 具体 |
|---|---|---|
| Phase/WP 分解・レビュー・人間確認切り出し | Claude (Opus) | 本書の維持、Ticket 差分レビュー、A1/A2 の判断 |
| 実装本体（Ticket 単位） | **Codex medium** | 純関数・コントローラ・配線 |
| grep / 位置調査 / test 構造要約 | Codex small / Explore subagent | read-only 偵察のみ |
| Chromium 実機ループ録音 受け入れ | 人間 | WP5 の可聴チェック |

---

## Ticket 一覧（依存順）

```
WP0-00  Gate & route recon（read-only・コード変更なし）           ← 最初にこれだけ
WP1-01  spec §11.7 に bundle media-audio graph の散文追記（docs のみ）
WP2-02  純関数: レイヤー時刻マッピング + unit test
WP2-03  純関数: ループ境界フェード状態機械 + unit test
WP3-04  MediaAudioController 新規 module + fake-AudioParam test
WP4-05  ループ境界コールバックを playback loop / audio clock に追加（renderGate 非依存）
WP4-06  DomRenderer: コントローラ所有 bundle video の直接 video.volume 自動化を停止（route flag・オプトイン）
WP4-07  BundlePlayer: コントローラ構築・unlock 配線・両音声経路の接続
WP5-08  bundle test 拡張 + 診断 before/after + 全コマンド + build:player
WP5-09  人間 capture handoff（Chromium Comp 10 ループ録音）  ← Codex 不可
```

**進める順:** WP0-00 のレビューで A1/A2 を確定 → WP1-01 → WP2 → WP3 → WP4 → WP5。1 Ticket 完了ごとに Claude が差分レビューしてから次へ。**Codex は自分から次 Ticket へ進まない。**

---

## WP0-00 — Gate & route recon（read-only）

- **Owner:** Codex small / Explore subagent
- **Model:** small
- **Size:** 10–15 分
- **Purpose:** 実装前に、触る共有経路と回帰リスク・A1/A2 を確定するための事実収集。**コード変更なし。**
- **Pre-read:** `fix-plan.md` / `report.md` / `src/player/BundlePlayer.ts` / `src/player/BundleAudioClock.ts` / `src/runtime/previewPlaybackLoop.ts` / `src/runtime/DomRenderer.ts`（`video.volume` 周辺のみ）
- **Explicit non-goals:** 実装・test 変更・spec 変更・例外判断。

### Prompt to Codex

```
Read-only reconnaissance. Do NOT edit any file.

Investigate the bundle loop-audio fix scope only. Report facts, not opinions.

Answer exactly:
1. In src/runtime/DomRenderer.ts, the line that writes video.volume from resolved
   gain (around line 2291): what conditions/options gate whether it runs? Is there
   an existing per-type or per-route flag (e.g. muteVideoPlayback / previewVideoPlayback)
   we could extend to suppress it for bundle-controller-owned videos?
2. In src/player/BundlePlayer.ts, confirm which loop path Comp 10 uses when there is
   NO standalone audio layer (runPreviewPlaybackLoop vs BundleAudioClock), and where
   the loop wrap happens for each.
3. In src/player/BundleAudioClock.ts, list which HTML media elements it creates/owns
   and how it drives frame progression. Does it own <audio> elements directly?
4. Enumerate every non-bundle path that reads the same shared code we might touch
   (exporter.ts, previewAudioClock.ts, PreviewPanel.tsx, compFrameCapture) so we know
   what must NOT change.
5. For ambiguity A1/A2 (see fix-plan-codex.md intake): state what the CURRENT code
   implies about whether standalone audio and video-embedded audio can share one
   AudioContext, and whether BundleAudioClock would remain the frame clock while a new
   controller owns only gain. Report evidence lines; do not decide.

Output:
- Answers 1–5 with file:line references
- Shared files at regression risk
- Suggested implementation boundary (where the new controller attaches)
- Blockers / open questions for A1, A2

Do not write code. Do not modify tests. Do not decide exceptions.
```

**Claude レビュー後:** A1/A2 を確定し、WP3/WP4 の allowed files を必要なら微修正する。

---

## WP1-01 — spec §11.7 散文追記（docs のみ）

- **Owner:** Codex medium（軽量）
- **Model:** medium
- **Size:** 10–15 分
- **Purpose:** 「先に spec → 次に実装」を守る。bundle 音声を単一 Web Audio graph に通す設計を §11.7（bundle）/ §11.5.2（declick）の散文として記録する。**§5 型・INV には触れない。**
- **Allowed files:** `doc/mafter-effect-spec.md`
- **Forbidden files:** それ以外すべて（コード・test・progress）。
- **Implementation scope:** fix-plan.md の "Design decision" の graph 図と「media 要素は decoder/clock のまま、graph は audible gain と loop/cut envelope のみ所有」「autoplay unlock ジェスチャで AudioContext resume」を散文で追記。
- **Explicit non-goals:** 型定義・INVARIANT・`project.json` 形式の変更（あれば stop して確認）。
- **Tests / commands:** なし（docs のみ）。
- **Stop conditions:** §5 の TypeScript 型や INV 表に手を入れる必要が出たら停止して報告。

### Prompt to Codex

```
Implement only Ticket WP1-01. Docs only.

Allowed files:
- doc/mafter-effect-spec.md

Forbidden:
- Do not edit any source, test, or progress file.
- Do not add/change any §5 TypeScript type or any INVARIANT (INV-1..6).
- Do not change project.json serialization prose.

Goal:
In the existing §11.7 (web bundle) / §11.5.2 (declick) prose, add a short subsection
describing that bundle audible footage/audio is routed through a single Web Audio graph:
  HTMLMediaElement -> MediaElementAudioSourceNode -> fadeGain (sample-accurate loop/cut)
  -> userGain (animated, control-rate) -> AudioContext.destination
State that media elements remain the decoders/clock, the graph owns only audible gain and
loop/cut transitions, and the AudioContext is created/resumed from the autoplay-unlock
gesture. This is bundle-only and does not change export or editor preview.

Non-goals:
- No schema type change, no new INVARIANT, no project.json format change.

Stop if:
- The change would require touching a §5 type or an INVARIANT.

Report:
- Changed section(s) and a 3-line summary of the added prose.

Do not continue to the next ticket.
```

---

## WP2-02 — 純関数: レイヤー時刻マッピング + unit test

- **Owner:** Codex medium
- **Model:** medium
- **Size:** 20–30 分
- **Purpose:** composition frame → 各音声レイヤーの media `currentTime` と active/inactive を、`inPoint` / `outPoint` / `trimStart` から算出する純関数を切り出す（`report.md` 副次発見の修正の土台）。DOM 非依存・unit test 可能。
- **Allowed files:**
  - `src/player/mediaAudioLayerTime.ts`（新規）
  - `test/mediaAudioLayerTime.test.ts`（新規）
- **Forbidden files:** `BundleAudioClock.ts` / `BundlePlayer.ts` / `DomRenderer.ts` / `previewPlaybackLoop.ts` / `exporter.ts` / 既存 test の期待値。
- **Pre-read:** `src/player/BundleAudioClock.ts`（`play` / `applyGains` の現行時刻計算）、`src/runtime/footageAutoFade.ts`（Frame 型・trimStart の扱い）。
- **Implementation scope:**
  - `computeLayerMediaTime({ frame, inPoint, outPoint, trimStart, fps })` → `{ active: boolean; mediaTimeSec: number }`。`frame < inPoint || frame >= outPoint` は `active:false`。active 時 `mediaTimeSec = (frame - inPoint + trimStart) / fps`（負は 0 クランプ）。
  - INV-5（整数 Frame が正準・秒は派生）を守る：入力は Frame、出力秒は導出のみ。
- **Explicit non-goals:** gain 適用・フェード・要素操作・配線。純関数と test だけ。
- **Tests / commands:**
  - `npm test -- mediaAudioLayerTime`
  - 型崩れ時のみ `npm run typecheck`
- **Stop conditions:** 既存 module の型を変える必要が出たら停止。

### Prompt to Codex

```
Implement only Ticket WP2-02.

Allowed files:
- src/player/mediaAudioLayerTime.ts   (new)
- test/mediaAudioLayerTime.test.ts    (new)

Forbidden:
- Do not edit BundleAudioClock.ts, BundlePlayer.ts, DomRenderer.ts,
  previewPlaybackLoop.ts, exporter.ts.
- Do not change any existing test expectations.

Goal:
Add a pure, DOM-free function that maps composition frame to a media element time for
one audio layer:
  computeLayerMediaTime(args: { frame: number; inPoint: number; outPoint: number;
    trimStart: number; fps: number }): { active: boolean; mediaTimeSec: number }
- active is false when frame < inPoint or frame >= outPoint.
- when active, mediaTimeSec = max(0, (frame - inPoint + trimStart) / fps).
Frame is the canonical integer unit (INV-5); seconds are derived only.

Non-goals:
- No gain, no fade, no HTMLMediaElement, no wiring.

Run:
- npm test -- mediaAudioLayerTime
- npm run typecheck only if type errors appear.

Stop if:
- You need to edit any file outside the allowed list.

Report:
- Changed files, tests run, typecheck result, remaining work, blockers.

Do not continue to the next ticket.
```

---

## WP2-03 — 純関数: ループ境界フェード状態機械 + unit test

- **Owner:** Codex medium
- **Model:** medium
- **Size:** 20–30 分
- **Purpose:** ループ継ぎ目の「フェードアウト → 無音維持 → seek → フェードイン」の遷移と、pending handoff の二重発火防止・無音閾値判定を純関数（状態機械）として切り出す。時間依存を引数化し unit test 可能にする。
- **Allowed files:**
  - `src/player/loopSeamFade.ts`（新規）
  - `test/loopSeamFade.test.ts`（新規）
- **Forbidden files:** コントローラ本体（未作成）・player・renderer・loop 本体・既存 test 期待値。
- **Pre-read:** `fix-plan.md` step 2/4、`report.md` の 120ms autoFade 評価表（フェード形状の参考）。
- **Implementation scope:**
  - 状態列挙（例: `idle` → `fadingOut` → `held` → `fadingIn` → `idle`）と `advanceLoopSeam(state, input)` 純関数。入力は現在時刻・フェード長・無音閾値・「seek 準備完了か」。
  - `fadeGainTarget` と「seek を発行してよいか（gain が閾値以下か）」を返す。
  - **pending handoff 中の重複ループ handoff を拒否**する状態を持つ（二重 seek 防止）。
  - `Math.random` / `Date.now` 禁止（INV-1 準拠、時間は引数）。
- **Explicit non-goals:** 実 AudioParam・要素 seek・rAF。数値と状態のみ。
- **Tests / commands:**
  - `npm test -- loopSeamFade`（fade-to-zero が seek より前にスケジュールされること、重複 handoff が拒否されることを assert）
  - 型崩れ時のみ `npm run typecheck`
- **Stop conditions:** 遷移仕様が fix-plan から一意に決められない場合は停止し、候補案を報告（推測で埋めない）。

### Prompt to Codex

```
Implement only Ticket WP2-03.

Allowed files:
- src/player/loopSeamFade.ts   (new)
- test/loopSeamFade.test.ts    (new)

Forbidden:
- Do not edit any other source or test file.
- Do not change existing test expectations.

Goal:
Add a pure, time-injected state machine for the loop-seam envelope:
  fade-out -> hold silence -> seek -> fade-in.
Expose a reducer like advanceLoopSeam(state, input) where input carries the current
time, fade duration, silence threshold, and a "seek target ready" flag; it returns the
next state plus { fadeGainTarget, maySeekNow }. maySeekNow must be true only when the
scheduled fade gain is at/below the silence threshold. The state must reject a duplicate
loop handoff while one is already pending (no double seek).
No Math.random / Date.now (INV-1); time is an argument.

Non-goals:
- No real AudioParam, no element.seek, no rAF, no wiring.

Run:
- npm test -- loopSeamFade
  (assert: fade-to-zero is scheduled before any seek; duplicate handoff rejected)
- npm run typecheck only if type errors appear.

Stop if:
- The transition spec is not uniquely determined by fix-plan.md — report candidate
  designs instead of guessing.

Report:
- Changed files, tests run, typecheck result, remaining work, blockers.

Do not continue to the next ticket.
```

---

## WP3-04 — MediaAudioController 新規 module + fake-AudioParam test

- **Owner:** Codex medium
- **Model:** medium
- **Size:** 25–30 分
- **Purpose:** fix-plan step 1 のコントローラ本体。1 個の `AudioContext` と要素ごと 1 個の `MediaElementAudioSourceNode` を所有し、fadeGain / userGain を張る。WP2 の 2 純関数を利用。
- **Allowed files:**
  - `src/player/mediaAudioController.ts`（新規）
  - `test/mediaAudioController.test.ts`（新規）
- **Forbidden files:** `BundlePlayer.ts` / `DomRenderer.ts` / `previewPlaybackLoop.ts` / `BundleAudioClock.ts` / `exporter.ts` / 既存 test 期待値。**この Ticket では配線しない（module 単体で完結）。**
- **Pre-read:** WP2-02 / WP2-03 の公開 API、`BundlePlayer.installAutoplayUnlock`（unlock ジェスチャの形）。
- **Implementation scope:**
  - `prepare` / `unlock` / `setFrame` / `setPlayback` / `pause` / `dispose` を公開（fix-plan step 1）。
  - **同一 element/context に 2 個目の `MediaElementAudioSourceNode` を作らない**（作成済みを Map で管理し、重複要求は既存を返すか例外）。
  - loop seam は WP2-03 の状態機械で駆動し、seek 前に fadeGain を 0 へスケジュール。
  - `unlock` は AudioContext.resume と要素 unmute を担う（autoplay policy）。
  - `AudioContext` を DI 可能にして test で fake を注入（`webkitAudioContext` 差異は本 Ticket では扱わない）。
- **Explicit non-goals:** BundlePlayer / renderer への接続、video.volume 停止、standalone audio の frame 進行。
- **Tests / commands:**
  - `npm test -- mediaAudioController`：fake `AudioContext`/`AudioParam` で ①全 seek の前に fade-to-zero がスケジュールされる ②同一要素への 2 個目 source node 作成が拒否される、を assert。
  - `npm run typecheck`
- **Stop conditions:** 実 DOM/実 AudioContext が test で不可避になったら停止（fake 注入で閉じられない設計は要相談）。

### Prompt to Codex

```
Implement only Ticket WP3-04.

Allowed files:
- src/player/mediaAudioController.ts   (new)
- test/mediaAudioController.test.ts    (new)

Forbidden:
- Do not edit BundlePlayer.ts, DomRenderer.ts, previewPlaybackLoop.ts,
  BundleAudioClock.ts, exporter.ts.
- Do not wire the controller into any caller in this ticket.
- Do not change existing test expectations.

Goal:
Implement a bundle-only media-audio controller class that owns exactly one AudioContext
and exactly one MediaElementAudioSourceNode per media element. Public API:
prepare, unlock, setFrame, setPlayback, pause, dispose.
Graph per element:
  element -> MediaElementAudioSourceNode -> fadeGain -> userGain -> destination
- Never create a second MediaElementAudioSourceNode for the same element (track in a Map;
  reject/return existing on duplicate).
- Drive loop-seam transitions with the WP2-03 state machine; schedule fadeGain to zero
  BEFORE a seek.
- unlock() resumes the AudioContext and unmutes elements (autoplay policy).
- Make the AudioContext injectable so tests can pass a fake.
Reuse computeLayerMediaTime (WP2-02) and advanceLoopSeam (WP2-03).

Non-goals:
- No wiring into BundlePlayer/renderer, no video.volume suppression, no frame clock.

Run:
- npm test -- mediaAudioController
  (fake AudioContext/AudioParam: assert fade-to-zero scheduled before every seek;
   assert duplicate source-node creation for one element is rejected)
- npm run typecheck

Stop if:
- The design cannot be unit-tested with an injected fake AudioContext.
- You need to edit any file outside the allowed list.

Report:
- Changed files, tests run, typecheck result, remaining work, blockers.

Do not continue to the next ticket.
```

---

## WP4-05 — ループ境界コールバックを playback loop / audio clock に追加

- **Owner:** Codex medium
- **Model:** medium
- **Size:** 20–30 分
- **Purpose:** fix-plan step 4。`renderFrame` とは別に **ループ境界コールバック**を追加し、`renderGate` が視覚描画を抑制していても必ず発火させる。最終視覚 render を音声フェード保証に使わない。
- **Allowed files:**
  - `src/runtime/previewPlaybackLoop.ts`
  - `src/player/BundleAudioClock.ts`
  - `test/previewPlaybackLoop.test.ts`（無ければ新規）
- **Forbidden files:** `BundlePlayer.ts`（配線は WP4-07）・`DomRenderer.ts`・`exporter.ts`・`PreviewPanel.tsx`・`previewAudioClock.ts`。
- **Pre-read:** `previewPlaybackLoop.ts`（wrap 分岐 51–67 / renderGate 70–77）、`BundleAudioClock.tick`（loop wrap 255–274）。
- **Implementation scope:**
  - `PreviewPlaybackLoopOptions` に `onLoopBoundary?: (fromFrame: number, toFrame: number) => void` を **optional 追加**（既存呼び出しは無害）。loop wrap 検出時に、renderGate の shouldRender に関わらず呼ぶ。
  - `BundleAudioClock` の loop wrap 分岐にも同型フックを追加（standalone audio 経路の継ぎ目用）。
  - **editor Preview の既存挙動を変えない**（callback 未指定なら完全に従来通り＝この loop は editor と共有のため INV-2 / 既存 preview を壊さない）。
- **Explicit non-goals:** コントローラの生成・接続（WP4-07）、video.volume 停止（WP4-06）。
- **Tests / commands:**
  - `npm test -- previewPlaybackLoop`：renderGate が render を抑制するフレームでも loop 境界で `onLoopBoundary` が発火することを assert（fake timer / render gate）。
  - `npm run typecheck`
- **Stop conditions:** `runPreviewFrameClock`（Best 経路）や editor 呼び出しに API 変更が波及しそうなら停止（optional で閉じる想定）。

### Prompt to Codex

```
Implement only Ticket WP4-05.

Allowed files:
- src/runtime/previewPlaybackLoop.ts
- src/player/BundleAudioClock.ts
- test/previewPlaybackLoop.test.ts   (create if missing)

Forbidden:
- Do not edit BundlePlayer.ts, DomRenderer.ts, exporter.ts, PreviewPanel.tsx,
  previewAudioClock.ts.
- Do not change existing test expectations.
- Do not change editor preview behavior for existing callers.

Goal:
Add an explicit loop-boundary callback that fires even when the render gate suppresses
visual rendering (fix-plan step 4). Do NOT rely on a final visual render as the audio-fade
guarantee.
- Add optional onLoopBoundary?(fromFrame, toFrame) to PreviewPlaybackLoopOptions; invoke it
  on loop wrap regardless of renderGate.shouldRender. When the option is absent, behavior is
  byte-for-byte the same as today (editor preview shares this loop — do not regress it).
- Add the same-shaped hook at the BundleAudioClock loop-wrap branch for the standalone-audio
  path.

Non-goals:
- No controller construction/wiring (that is WP4-07).
- No video.volume changes (that is WP4-06).

Run:
- npm test -- previewPlaybackLoop
  (assert onLoopBoundary fires at the loop seam even on a frame the render gate suppresses)
- npm run typecheck

Stop if:
- runPreviewFrameClock or any editor caller would need an API change.
- You need to edit any file outside the allowed list.

Report:
- Changed files, tests run, typecheck result, remaining work, blockers.

Do not continue to the next ticket.
```

---

## WP4-06 — DomRenderer: コントローラ所有 bundle video の直接 volume 自動化を停止（route flag）

- **Owner:** Codex medium
- **Model:** medium
- **Size:** 20–30 分
- **Purpose:** fix-plan step 2。コントローラが video 内蔵音声の可聴 gain を所有するため、**bundle かつコントローラ所有の video に限り** `DomRenderer` の直接 `video.volume=` 自動化（[`DomRenderer.ts:2291`](../../../src/runtime/DomRenderer.ts#L2291)）を停止する。preview・export は不変。
- **Allowed files:**
  - `src/runtime/DomRenderer.ts`
  - （必要時）`src/runtime/domRendererTypes` 等、render options 型が定義されるファイル 1 つ
- **Forbidden files:** `exporter.ts` / `resolve.ts`（gain 解決自体は残す）/ `previewAudioClock.ts` / `PreviewPanel.tsx` / 既存 test 期待値。
- **Pre-read:** WP0-00 の回答 1（既存 `muteVideoPlayback` / `previewVideoPlayback` フラグ）、`DomRenderer.ts` の `setPreviewRenderOptions` 定義と 2287–2291。
- **Implementation scope:**
  - `PreviewRenderOptions` に **bundle 専用のオプトイン flag**（例 `externalAudioGain?: boolean`）を追加。true のときだけ 2291 の `video.volume` 書き込みを **skip**（要素は muted 制御のまま、可聴 gain はコントローラが担当）。
  - **CLAUDE.md「新描画レイヤー export 正常化」準拠**: 全レイヤー一律ではなく flag オプトインで閉じる。flag 未設定時は現行と完全一致（export / preview 無回帰）。
- **Explicit non-goals:** コントローラ生成・BundlePlayer 配線（WP4-07）。`resolve` の gain 計算やフェード乗算は削らない（他経路が使用）。
- **Tests / commands:**
  - `npm run typecheck`
  - 既存 export/raster 系回帰: `npm test -- DomRenderer`（あれば）+ 既存 `verify-*-export*.mjs` のうち video を含むもの 1 本を無回帰確認（Claude が指定）。
- **Stop conditions:** flag を足さず全 video の volume 挙動を変える以外に道が無い場合は停止（それは export 回帰になる）。

### Prompt to Codex

```
Implement only Ticket WP4-06.

Allowed files:
- src/runtime/DomRenderer.ts
- (only if the options type lives elsewhere) the single file that defines
  PreviewRenderOptions.

Forbidden:
- Do not edit exporter.ts, resolve.ts, previewAudioClock.ts, PreviewPanel.tsx.
- Do not change existing test expectations.
- Do not apply a blanket behavior change to all videos or all frames.

Goal:
Add a bundle-only, opt-in render option (e.g. externalAudioGain?: boolean). When it is
true, skip the direct `video.volume = ...` write at DomRenderer.ts ~line 2291 for
controller-owned bundle videos (the element stays under muted control; audible gain is
owned by the media-audio controller). When the flag is absent/false, behavior is identical
to today — export (mp4/webm/PNG) and editor preview must not regress. Follow CLAUDE.md
"新描画レイヤー export 正常化": type/route opt-in, no shared-path blanket change.

Non-goals:
- No controller construction, no BundlePlayer wiring (WP4-07).
- Do not remove gain resolution or auto-fade multiplication in resolve.ts (other paths use it).

Run:
- npm run typecheck
- npm test -- DomRenderer   (if such a test exists)

Stop if:
- The only way forward changes video.volume behavior for non-bundle / non-opt-in paths.
- You need to edit a file outside the allowed list.

Report:
- Changed files, tests run, typecheck result, remaining work, blockers.

Do not continue to the next ticket.
```

---

## WP4-07 — BundlePlayer: コントローラ構築・unlock 配線・両音声経路の接続

- **Owner:** Codex medium
- **Model:** medium
- **Size:** 25–30 分（本 WP で最も重い統合）
- **Purpose:** fix-plan step 2/3/5。`MediaAudioController` を生成し、autoplay-unlock ジェスチャで resume/unmute、video 内蔵音声と standalone audio を同じタイミングモデルに載せ、loop 境界コールバック（WP4-05）を配線。非 bundle 経路は不変。
- **Allowed files:**
  - `src/player/BundlePlayer.ts`
  - （A2 の結論次第）`src/player/BundleAudioClock.ts`
- **Forbidden files:** `DomRenderer.ts`（WP4-06 で完了）/ `previewPlaybackLoop.ts`（WP4-05 で完了）/ `exporter.ts` / editor 全般 / 既存 test 期待値。
- **Pre-read:** WP0-00 回答（特に A1/A2）、`BundlePlayer.start` / `installAutoplayUnlock` / `play` / `pause` / `dispose`、コントローラ公開 API。
- **Implementation scope:**
  - `installAutoplayUnlock` の handler 内で controller.unlock()（AudioContext.resume + unmute）を呼ぶ。
  - hasAudio 経路（`BundleAudioClock`）と no-audio 経路（`runPreviewPlaybackLoop`）の両方で、コントローラに `setFrame` / `setPlayback` を渡し、loop 境界で fade→seek→fade を発火。
  - WP4-06 の `externalAudioGain` flag を bundle video に対して有効化。
  - `pause` / `dispose` で controller も停止・破棄（`MediaElementAudioSourceNode` 再利用/破棄をコントローラへ通知）。
  - **muted-autoplay の現行挙動を維持**（fix-plan risks）。
- **Explicit non-goals:** export / editor preview のリファクタ（fix-plan risks 明記）。renderer/loop の再設計。
- **Tests / commands:**
  - `npm run typecheck`
  - `npm test`（bundle / audio 関連の既存 test が緑のまま）
  - build:player は WP5-08 でまとめて実行（この Ticket 単体では typecheck + test まで）。
- **Stop conditions:** A2（要素所有権の二重化）が未確定なら停止して確認。DomRenderer / previewPlaybackLoop を再度触る必要が出たら停止（前 Ticket の範囲）。

### Prompt to Codex

```
Implement only Ticket WP4-07.

Allowed files:
- src/player/BundlePlayer.ts
- src/player/BundleAudioClock.ts   (only if WP0 conclusion A2 requires it)

Forbidden:
- Do not edit DomRenderer.ts, previewPlaybackLoop.ts, exporter.ts, or any editor file.
- Do not change existing test expectations.
- Do not refactor export or editor preview (fix-plan risk note).

Goal (fix-plan steps 2/3/5):
Construct the MediaAudioController and route bundle audible audio through it.
- In installAutoplayUnlock's handler, call controller.unlock() (resume AudioContext,
  unmute) inside the user-gesture call stack; keep existing muted-autoplay behavior.
- For BOTH the hasAudio path (BundleAudioClock) and the no-audio path
  (runPreviewPlaybackLoop), feed the controller setFrame/setPlayback and fire the
  loop-boundary callback (WP4-05) so fade-out -> seek -> fade-in runs even when the render
  gate suppresses visuals.
- Enable the WP4-06 externalAudioGain opt-in for controller-owned bundle videos.
- On pause/dispose, stop/dispose the controller and notify it of element reuse/disposal
  (MediaElementAudioSourceNode is one-shot per element).

Non-goals:
- No export/editor changes. No renderer/loop redesign.

Run:
- npm run typecheck
- npm test   (existing bundle/audio tests stay green)

Stop if:
- WP0 ambiguity A2 (element ownership) is unresolved.
- You need to re-edit DomRenderer.ts or previewPlaybackLoop.ts.
- You need to edit a file outside the allowed list.

Report:
- Changed files, tests run, typecheck result, remaining work, blockers.

Do not continue to the next ticket.
```

---

## WP5-08 — bundle test 拡張 + 診断 before/after + 全コマンド + build:player

- **Owner:** Codex medium
- **Model:** medium
- **Size:** 25–30 分
- **Purpose:** fix-plan "Tests and verification" の 1–5。回帰ゲートを固定し、ランタイム変更を反映した `public/player.js` を再ビルドする。
- **Allowed files:**
  - `test/`（bundle/audio 関連の新規 test 追加）
  - `public/player.js`（`npm run build:player` の生成物・コミット対象）
  - `progress.md`
- **Forbidden files:** `src/` の挙動変更（この Ticket は test/build/status のみ。実装バグを見つけたら停止して報告し、該当 WP に戻す）/ 既存 test 期待値の書き換え。
- **Pre-read:** `test/bundleAudioClock.test.ts`、`doc/issue/static-noise-problem/verify-loop-audio-seam.mjs`（診断の実行法）。
- **Implementation scope:**
  - bundle test を拡張：video-only comp、`inPoint`≠0 かつ `trimStart`≠0 の audio-layer comp。
  - 診断 `node doc/issue/static-noise-problem/verify-loop-audio-seam.mjs` を修正 before/after で実行し結果を progress に記録（fix-plan 4：修正後もソースは意図的に unsafe seam のままなので、**コード経路の assertion が通ること**を確認。診断スクリプト自体の閾値は変えない）。
  - **`npm run build:player` を必ず実行**し `public/player.js` 更新を確認、`playerBuildFreshness` を通す。
  - `npm run typecheck` / focused audio・bundle test / `npm test`。
  - `progress.md` に完了 WP・残（WP5-09 人間 capture 待ち）を記録。
- **Explicit non-goals:** `src/` の挙動変更、Chromium 実機受け入れの自己宣言。
- **Tests / commands:** 上記すべて。
- **Stop conditions:** test が実装バグを示したら停止し、修正を該当 WP Ticket に差し戻す（この Ticket で src を直さない）。

### Prompt to Codex

```
Implement only Ticket WP5-08. Tests, build artifact, and status only.

Allowed files:
- test/**   (new bundle/audio tests only)
- public/player.js   (regenerated by npm run build:player; commit it)
- progress.md

Forbidden:
- Do not change src/ behavior in this ticket. If a test reveals an implementation bug,
  STOP and report which WP to reopen.
- Do not rewrite existing test expectations.
- Do not edit the diagnostic's thresholds.

Goal (fix-plan tests/verification):
- Extend bundle tests: a video-only comp, and an audio-layer comp with non-zero inPoint
  and trimStart.
- Run node doc/issue/static-noise-problem/verify-loop-audio-seam.mjs before and after;
  record results in progress.md. The source seam stays intentionally unsafe; assert the
  code-path claim, not a changed threshold.
- Run npm run build:player and confirm public/player.js updated; ensure playerBuildFreshness
  passes (src/player and src/runtime changed, so player.js MUST be rebuilt).
- Run npm run typecheck, focused audio/bundle tests, and npm test.
- Update progress.md: completed WPs and remaining WP5-09 (human capture pending).

Non-goals:
- No src/ behavior change. Do not self-declare the Chromium acceptance.

Run:
- npm run typecheck
- npm test
- npm run build:player
- npm test -- playerBuildFreshness

Stop if:
- Any test indicates an implementation defect (report the WP to reopen).

Report:
- Changed files, tests run, build:player result, playerBuildFreshness result,
  diagnostic before/after, remaining work, blockers.

Do not continue to the next ticket.
```

---

## WP5-09 — 人間 capture handoff（Chromium Comp 10 ループ録音）

- **Owner:** 人間（headed Chromium）。**Codex 不可・自己宣言禁止。**
- **Purpose:** fix-plan verification 6。実機で受け入れ判定する。
- **手順:**
  1. `npm run build:player` 済みの bundle で Comp 10 を再生。
  2. ループ継ぎ目を複数回録音。
  3. 受け入れ基準（fix-plan）:
     - フェード gain が無音閾値より上の間に **可聴 seek が無い**。
     - 未処理の `play()` 拒否が無い。
     - 映像は連続再生。
  4. 結果を `progress.md` に記録。NG なら該当 WP（WP2-03 フェード形状 / WP4-05 境界発火 / WP4-07 配線）へ差し戻す。

---

## Claude 用レビュー・チェックリスト（各 Ticket 完了ごと）

```
- [ ] allowed files だけを触ったか（特に DomRenderer / previewPlaybackLoop の越境が無いか）
- [ ] forbidden（exporter / previewAudioClock / PreviewPanel / schema / INV）に触れていないか
- [ ] flag/route オプトインで閉じ、非 bundle の video.volume 挙動が不変か（WP4-06/07）
- [ ] 既存 test 期待値を勝手に変えていないか
- [ ] onLoopBoundary が未指定時に editor preview を完全一致で保っているか（WP4-05）
- [ ] src/player・src/runtime を触った WP の後に build:player 済みか（WP5-08）
- [ ] Chromium 受け入れを Codex が自己宣言していないか（WP5-09 は人間）
- [ ] A1/A2 を推測で埋めていないか
- [ ] Codex が次 Ticket へ勝手に進んでいないか
```

---

## Subagent（read-only 偵察）の型

WP0-00 以外でも位置調査が要るときはこの型で small に投げる（判断・実装はさせない）:

```
Read-only. Do NOT edit files. Investigate only <narrow question>.
Output: file:line list, relevant functions, existing test patterns, risks,
suggested boundary. Do not write code. Do not decide exceptions. Do not modify tests.
```
