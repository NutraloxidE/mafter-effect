# after-v3 Phase A — Codex 実装票（editor preview を audio-master 化）

> このドキュメントは [after-v3-implement-report.md](after-v3-implement-report.md) §3「Phase A」を
> Codex medium が **1 回の投入で燃えずに完了できる Ticket 群**へ落とし込んだもの。設計理由・仮説・
> 期待効果・リスクは report 本体にあり、ここには **作業票（allowed / forbidden / steps / commands /
> stop / report）だけ**を書く。
>
> 対象は **editor preview の standalone `audio` レイヤー**のみ（`PreviewAudioClock`）。video 内蔵音声の
> 完全 audio-master 化（report §4 Phase B）は別チケット・**本票の対象外**。
>
> **実ブラウザでの「音が止まらない／連続している」受け入れ計測は Codex の完了条件に含めない**
> （人間 / Claude Code 側に残す。Codex に自己合格宣言させない）。

---

## Plan intake summary

- Source document: `doc/issue/static-noise-problem/after-v3-implement-report.md`（状態: 設計評価のみ・未実装、§6 で Phase A を次の実装候補として推奨）
- Goal: `PreviewAudioClock` が `holdTimeline`（映像遅れ）を検出しても `AudioContext` の suspend/resume・frame 進行の凍結を行わないようにする。音声を正準の transport clock にし、映像 decode が追いつかなければコマ落ち／古いフレーム表示を許容する。
- Known Phases: Phase A のみ（Phase B＝video 内蔵音声の audio-master 化は別チケット、report §4）
- Known WPs: 2 個（PA-01 spec prose、PA-02 実装）
- Required gate files: なし（decision-record 等のゲートは本 issue には無い。report 自体が根拠文書）
- Required status files: `progress.md`（更新は PA-02 の最後・任意項目。Codex がやってもよいが自己受け入れ宣言はしない）
- Hard forbidden areas: `src/player/BundleAudioClock.ts` ほか bundle export 経路 / mp4・webm・PNG export / `src/core/schema.ts`（§5）/ INVARIANT 表 / `hasAudioLayers` のセマンティクス / video 内蔵音声（`<video>` 直接再生）の配線 / `pauseVideo` 判定ロジック（`playbackVideoSync.ts` の純関数群）
- Allowed file policy: PA-01 は spec のみ、PA-02 は `src/editor/previewAudioClock.ts` のみ（下記参照）
- Required commands: `npm run typecheck`、`npm test`（既存回帰）
- Required generated artifacts: **なし**。`src/editor/previewAudioClock.ts` は `src/player/` からも `src/runtime/` からも import されない（`grep -r "previewAudioClock" src/player src/runtime` が無ヒットであることを PA-02 内で確認済み・再確認は 1 コマンドで足りる）＝ `npm run build:player` は不要。
- Human verification required: report §5 の検証表（A〜E）。実 Chromium + Playwright で音声の連続性（stop/resume が起きないこと）と playhead 追従を確認。**Codex は実施も自己宣言もしない。**
- Ambiguities: なし（削除・置換箇所は下記に exact before/after で確定済み）
- First safe action: PA-01（spec prose）→ PA-02（実装）の順で実施。逆順不可（CLAUDE.md「先に spec → 次に実装」）。

---

## Ticket PA-01 — spec prose 追記（§11.5, holdTimeline 時の audio-master 挙動）

- Owner: Codex medium
- Model: medium
- Size: 小（1 ファイル・prose のみ・10 分）
- Purpose: `doc/mafter-effect-spec.md` §11.5 に、`holdTimeline` 発生時の `PreviewAudioClock` の挙動（audio-master・非停止）を明文化する。**§5 スキーマ・INVARIANT 表は一切変更しない**（CLAUDE.md により本種の prose 追記は Codex 単独で進めてよい）。

### Allowed files

- `doc/mafter-effect-spec.md`（§11.5 内の 1 箇所のみ）

### Forbidden

- `§5 データスキーマ` の表・型定義への変更
- `§4 不変条件 (INVARIANTS)` の表への変更
- 他セクション（§11.4 の hold/pause 判定そのものの記述、§11.7 bundle 節）への変更
- prose の言い回し以外の意味変更（既存の「preview（音声マスタークロック）」段落の削除・大幅書き換え禁止。追記のみ）

### Pre-read

- `doc/mafter-effect-spec.md` の §11.5（`### §11.5 audio コンポーネント（MVP / 最小）`、`- **preview（音声マスタークロック）**:` で始まる段落）
- `doc/issue/static-noise-problem/after-v3-implement-report.md` §3

### Implementation scope（追記位置と文面）

`doc/mafter-effect-spec.md` の §11.5 内、`- **preview（音声マスタークロック）**: ...` の段落の**直後**（`- **プリロード（再生レイテンシ回避・非直列化）**:` の**直前**）に、新しい箇条書きを 1 つ追加する。

Before（該当 2 段落。間に追記する）:
```markdown
- **preview（音声マスタークロック）**: 再生中はオーディオレイヤーが 1 つでもあれば `AudioContext.currentTime` を**マスタークロック**とし、`currentFrame = rangeStart + floor((ctx.currentTime − t0) · fps)` を毎 rAF で算出して `resolve`/描画する（§11.7 と同型・INV-8）。各レイヤーは `inPoint`/`outPoint`/`trimStart` に従って `AudioBufferSourceNode` をスケジュールし、`gain` は毎 tick に live comp から `sampleGain(gainProp, currentFrame)` を再評価して `GainNode.gain.value` へ反映する（編集中スライダーが再生中に効く）。**スクラブ時・停止時は無音**。`AudioContext` の resume はユーザージェスチャ（再生ボタン）で行う。オーディオが無ければ従来の rAF 経過時間クロックを使う。
- **プリロード（再生レイテンシ回避・非直列化）**: decode 済み `AudioBuffer` は **assetId をキーに共有メモリキャッシュ**へ常駐させる。編集中 comp に音声レイヤーがあれば事前に decode しておき、再生ボタンで decode 待ちなく即発音する。波形抽出（§11.5.1）・再生・duration メタ取得は**同一バッファを共有**し、大きなソースを多重 decode しない。
```

After（間に 1 段落追加）:
```markdown
- **preview（音声マスタークロック）**: 再生中はオーディオレイヤーが 1 つでもあれば `AudioContext.currentTime` を**マスタークロック**とし、`currentFrame = rangeStart + floor((ctx.currentTime − t0) · fps)` を毎 rAF で算出して `resolve`/描画する（§11.7 と同型・INV-8）。各レイヤーは `inPoint`/`outPoint`/`trimStart` に従って `AudioBufferSourceNode` をスケジュールし、`gain` は毎 tick に live comp から `sampleGain(gainProp, currentFrame)` を再評価して `GainNode.gain.value` へ反映する（編集中スライダーが再生中に効く）。**スクラブ時・停止時は無音**。`AudioContext` の resume はユーザージェスチャ（再生ボタン）で行う。オーディオが無ければ従来の rAF 経過時間クロックを使う。
- **映像遅れ時も音声は止めない（audio-master, holdTimeline 非依存）**: §11.4 の双方向同期が `holdTimeline`（映像遅れ）を検出しても、`PreviewAudioClock` は `AudioContext.suspend()`/`resume()` を呼ばず、frame 進行も凍結しない。`ctx.currentTime` から求めた `currentFrame` の算出を継続し、毎 rAF tick は直近の frame だけを `onFrameChange`/`renderFrame` に渡す（中間フレームの描画は行わない＝取りこぼす）。すなわち音声が正準の transport clock であり、decode が追いつかない video は一時的に古いフレーム表示・コマ落ちを起こしうる（意図的なトレードオフ）。`pauseVideo`（映像先行時に video を pause）・±4% の `playbackRate` 補正・loop wrap／scrub／明示 pause・stop による音声制御は本項の対象外で従来どおり。video 内蔵音声（`<video>` 要素の直接再生）は本項の対象外（別途 Phase B）。
- **プリロード（再生レイテンシ回避・非直列化）**: decode 済み `AudioBuffer` は **assetId をキーに共有メモリキャッシュ**へ常駐させる。編集中 comp に音声レイヤーがあれば事前に decode しておき、再生ボタンで decode 待ちなく即発音する。波形抽出（§11.5.1）・再生・duration メタ取得は**同一バッファを共有**し、大きなソースを多重 decode しない。
```

### Explicit non-goals

- §11.4 の hold/pause 判定そのものの記述変更（`computePlaybackSyncState` の意味は変えない）
- §11.7（bundle）節の変更（`BundleAudioClock` は既に既定で audio-master・無関係）
- 実装（`previewAudioClock.ts`）への着手（PA-02 で別途行う）

### Tests / commands

- なし（prose のみ・ビルド/テスト対象外）。目視で Markdown の箇条書きインデント・言語が既存段落と揃っていることだけ確認する。

### Stop conditions

- 追記対象の段落が見つからない、または既に同旨の記述がある（report を再確認し、重複するなら追記しない）

### Completion report

```
Changed files: doc/mafter-effect-spec.md
Added paragraph: done/skip（skip の場合は理由）
Remaining work: PA-02（実装）
Blockers:
```

**次の Ticket（PA-02）へは、この Ticket 単独の報告後に進めてよい（同一セッションで連続実行可・ただし spec 追記が先に完了していることを確認してから）。**

---

## Ticket PA-02 — `PreviewAudioClock` の audio-master 化（実装）

- Owner: Codex medium
- Model: medium
- Size: 小〜中（1 ファイル・削除中心・20〜30 分）
- Purpose: `src/editor/previewAudioClock.ts` の `tick()` から `holdTimeline` による `frozenFrame` 凍結と `applyAudioHold()`（`AudioContext.suspend()`/`resume()`）を削除し、映像遅れ時も音声・frame 進行を止めないようにする。`pauseVideo` の算出・報告（`onPlaybackSyncState`）、±4% playbackRate 補正（呼び出し元 `PreviewPanel.tsx` が既に独立して行う）、loop wrap／scrub／明示 pause・stop の既存制御は**一切変更しない**。

### Allowed files

- `src/editor/previewAudioClock.ts`

### Forbidden files / areas（触るな）

- `src/player/BundleAudioClock.ts`（bundle は対象外・既に既定で audio-master）
- `src/runtime/playbackVideoSync.ts`（`computePlaybackSyncState` 等の純関数は変更しない。`holdTimeline` の**算出**は変えない。変えるのはそれを previewAudioClock がどう使うかだけ）
- `src/editor/panels/PreviewPanel.tsx`（`onPlaybackSyncState` の呼び出しシグネチャは変えない。中身の `pauseVideo` 中継はそのまま動く前提）
- `src/runtime/DomRenderer.ts`
- `src/runtime/exporter.ts` ほか export 経路
- `src/core/schema.ts`（§5）
- 本 Ticket の削除に無関係なリファクタ・整形・rename・コメント全面書き換え禁止

### Pre-read

- `src/editor/previewAudioClock.ts` 全体（特に `tick()`／`applyAudioHold()`／フィールド宣言／`stop()`）
- `doc/issue/static-noise-problem/after-v3-implement-report.md` §3
- 参考実装（**読むだけ・コピー先ではない**）: `src/player/BundleAudioClock.ts` の `tick()` — `this.sync?.audioMaster === false` のときだけ hold で pause する分岐が「既定は audio-master」の参考例

### Implementation scope（exact edits）

#### E1 — フィールド宣言から `frozenFrame` / `suspendDesired` を削除

Before:
```ts
  private syncState: PlaybackSyncState = initialPlaybackSyncState();
  /** hold 中に報告し続ける frame（suspend 非同期完了前の先行を防ぐ）。 */
  private frozenFrame: number | null = null;
  private suspendDesired = false;
```

After:
```ts
  private syncState: PlaybackSyncState = initialPlaybackSyncState();
```

#### E2 — `tick()` から hold 分岐（frozenFrame 凍結・applyAudioHold 呼び出し）を削除

`computePlaybackSyncState` の算出・`onPlaybackSyncState` への報告は**残す**（`pauseVideo` は `PreviewPanel.tsx` が引き続き使う）。`if (this.syncState.holdTimeline) { ... }` ブロックと、その後の hold 解除の再アンカー処理（`if (this.frozenFrame !== null) { ... }`）を削除し、`elapsedSec`/`frame` の算出を `this.originCtxTime`/`this.originFrame` からそのまま行う。

Before:
```ts
  private tick = (): void => {
    if (!this.playing || !this.ctx) return;

    // §11.4: 双方向同期 — 映像遅れ→timeline hold / 映像先行→video pause。
    const samples = this.opts.getVideoClockSamples?.() ?? [];
    this.syncState = computePlaybackSyncState(
      this.syncState,
      samples,
      holdThresholdsForFps(this.opts.fps),
      performance.now(),
    );
    this.opts.onPlaybackSyncState?.(this.syncState);
    if (this.syncState.holdTimeline) {
      if (this.frozenFrame === null) {
        const elapsedSec = this.ctx.currentTime - this.originCtxTime;
        this.frozenFrame = this.originFrame + Math.floor(elapsedSec * this.opts.fps);
      }
      this.applyAudioHold(true);
      this.updateLiveGains(this.frozenFrame);
      this.rafId = requestAnimationFrame(this.tick);
      return;
    }
    if (this.frozenFrame !== null) {
      this.originFrame = this.frozenFrame;
      this.originCtxTime = this.ctx.currentTime;
      this.frozenFrame = null;
      this.applyAudioHold(false);
    }

    const elapsedSec = this.ctx.currentTime - this.originCtxTime;
    const frame = this.originFrame + Math.floor(elapsedSec * this.opts.fps);
    const { loopStart, loopEnd, loop } = this.opts;
    const lastFrame = Math.max(loopStart, loopEnd - 1);
```

After:
```ts
  private tick = (): void => {
    if (!this.playing || !this.ctx) return;

    // §11.4 双方向同期: holdTimeline（映像遅れ）は pauseVideo 判定の副産物として算出・報告する
    // だけで、AudioContext の suspend/resume や frame 進行の凍結には使わない（audio-master、
    // doc/issue/static-noise-problem/after-v3-implement-report.md Phase A）。
    const samples = this.opts.getVideoClockSamples?.() ?? [];
    this.syncState = computePlaybackSyncState(
      this.syncState,
      samples,
      holdThresholdsForFps(this.opts.fps),
      performance.now(),
    );
    this.opts.onPlaybackSyncState?.(this.syncState);

    const elapsedSec = this.ctx.currentTime - this.originCtxTime;
    const frame = this.originFrame + Math.floor(elapsedSec * this.opts.fps);
    const { loopStart, loopEnd, loop } = this.opts;
    const lastFrame = Math.max(loopStart, loopEnd - 1);
```

`tick()` の残り（`if (frame >= lastFrame) { ... }` 以降、loop wrap／`onPlaybackEnd`／`updateLiveGains`／`onFrameChange`／`renderFrame`）は**一切変更しない**。

#### E3 — `applyAudioHold()` メソッドを削除

`stopNodes()` の直前にあるメソッド全体（JSDoc コメント込み）を削除する。

Before:
```ts
  /** hold 中は suspend、解除は resume。desired/actual 交錯を suspendDesired で抑止。 */
  private applyAudioHold(hold: boolean): void {
    const ctx = this.ctx;
    if (!ctx) return;
    if (hold) {
      if (this.suspendDesired) return;
      this.suspendDesired = true;
      void ctx.suspend().then(() => {
        // hold が既に解除されていたら即座に resume（suspend 完了レース）。
        if (!this.suspendDesired) {
          void ctx.resume().catch(() => {
            /* best-effort */
          });
        }
      });
      return;
    }
    this.suspendDesired = false;
    if (ctx.state === "suspended") {
      void ctx.resume().catch(() => {
        /* best-effort */
      });
    }
  }

  /** 各 tick で live comp から gain を再評価し、編集中の Volume スライダーを再生中に反映する。 */
  private updateLiveGains(frame: number): void {
```

After:
```ts
  /** 各 tick で live comp から gain を再評価し、編集中の Volume スライダーを再生中に反映する。 */
  private updateLiveGains(frame: number): void {
```

#### E4 — `stop()` から `frozenFrame`/`suspendDesired` のリセットを削除

Before:
```ts
  stop(): void {
    this.playing = false;
    this.syncState = initialPlaybackSyncState();
    this.opts.onPlaybackSyncState?.(this.syncState);
    this.frozenFrame = null;
    this.suspendDesired = false;
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
    this.stopNodes();
    if (this.ctx) {
      void this.ctx.close();
      this.ctx = null;
    }
  }
```

After:
```ts
  stop(): void {
    this.playing = false;
    this.syncState = initialPlaybackSyncState();
    this.opts.onPlaybackSyncState?.(this.syncState);
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
    this.stopNodes();
    if (this.ctx) {
      void this.ctx.close();
      this.ctx = null;
    }
  }
```

### Explicit non-goals

- 新しい declick / crossfade / playbackRate 補正の実装（E1〜E4 は削除・簡略化のみ）
- `BundleAudioClock.ts` / bundle export 経路への変更
- video 内蔵音声（`<video>` 直接再生）の audio-master 化（Phase B・別チケット）
- `pauseVideo` 判定・`playbackRate` 補正ロジックの変更
- 実ブラウザでの音声連続性の計測・判定・受け入れ自己宣言
- 無関係な整形・rename・import 並べ替え

### Tests / commands（この順で実行）

1. `grep -rn "previewAudioClock" src/player src/runtime` — 無ヒットであることを確認（player bundle 再ビルド不要の根拠。ヒットしたら Stop）
2. `npm run typecheck` — 型エラーゼロ（削除後に未使用 import・未使用フィールド警告が出ないこと）
3. `npm test` — 既存全テスト green（`previewAudioClock.ts` を直接 unit test しているファイルは現状無い想定。もし存在すれば個別に `npm test -- <ファイル名>` で確認し、結果を報告に含める）

### Generated artifacts

- なし（上記 grep で確認する通り `npm run build:player` は不要）

### Stop conditions

- allowed files（`src/editor/previewAudioClock.ts`）以外の編集が必要になった
- E1〜E4 の削除により、当該箇所以外で型エラー・未使用変数エラーが出て allowed files 内で解消できない
- `previewAudioClock` に無関係な既存テストが落ちる
- Tests/commands の 1. で `src/player` または `src/runtime` に `previewAudioClock` への参照が見つかった（想定外・要報告のうえ停止）

### Completion report

```
Changed files:
Edits applied: E1 / E2 / E3 / E4（各 done/skip）
grep previewAudioClock in src/player src/runtime: (ヒット有無)
typecheck:
npm test:
public/player.js rebuild: 不要（根拠: 上記 grep 無ヒット）
Remaining work: 実ブラウザ音声連続性の受け入れ計測（Codex 未実施・人間/Claude Code 側、report §5 表 A〜E）
Blockers:
```

**次の Ticket（Phase B）へは進まない。実ブラウザ計測の合否は宣言しない。**

---

## 実ブラウザ受け入れ（Codex 完了後・人間 / Claude Code 側）

Codex が PA-01・PA-02 を完了して報告した後、report §5 の検証表に従って実 Chromium（Playwright）で確認する。Codex はこの節を実施しない。

| # | 条件 | 合格条件 |
|---|---|---|
| A | standalone audio + 重い video/effect、Draft playback | 音声が stop/resume で断続せず、playhead が音声 clock と連続して進む |
| B | 同じ comp、負荷なし | 通常再生の A/V 時刻が既存許容範囲に収まる |
| C | 意図的に decode を遅らせる | 音声は連続し、中間フレームを捨てて最新時刻へ追従する（video lag は見た目の劣化として観測・記録） |
| D | loop / scrub / pause / resume | 明示操作は正しい seek・停止・再開を行い、ループ中に余分な stop/resume を発生させない |
| E | 標準 autoFade のある audio clip | in/out カット端の pop 防止が維持される |

---

## Codex へ渡す最終プロンプト（コピペ用）

```
Implement Ticket PA-01 then Ticket PA-02 from
doc/issue/static-noise-problem/after-v3-phase-a-codex.md, in that order.
Both are deletion/prose-addition changes (no new runtime logic).

--- Ticket PA-01 (spec prose) ---
Allowed files:
- doc/mafter-effect-spec.md (one insertion inside §11.5 only)

Forbidden:
- Do not touch §5 データスキーマ or §4 不変条件 tables
- Do not touch §11.4 or §11.7 prose
- Do not reword the existing "preview（音声マスタークロック）" paragraph

Insert exactly the paragraph given in Ticket PA-01's "After" block, between the
existing "preview（音声マスタークロック）" bullet and the "プリロード" bullet.

--- Ticket PA-02 (implementation) ---
Allowed files:
- src/editor/previewAudioClock.ts

Forbidden:
- Do not edit BundleAudioClock.ts, playbackVideoSync.ts, PreviewPanel.tsx,
  DomRenderer.ts, exporter.ts, or src/core/schema.ts
- Do not change computePlaybackSyncState or how holdTimeline/pauseVideo are
  computed — only change how PreviewAudioClock reacts to holdTimeline
- Do not add new declick/crossfade/playbackRate logic
- Do not touch video-embedded audio (<video> playback) — that is Phase B,
  out of scope
- Do not refactor, rename, or reformat anything unrelated to the deletions

Do exactly these 4 edits (exact before/after strings are in the doc):
E1 Remove the `frozenFrame` and `suspendDesired` fields.
E2 In tick(), delete the `if (this.syncState.holdTimeline) { ... }` freeze
   branch and the post-hold reanchor branch (`if (this.frozenFrame !== null)
   { ... }`). Keep computing/reporting syncState via onPlaybackSyncState.
   Keep everything from `const elapsedSec = ...` onward unchanged.
E3 Delete the `applyAudioHold()` method entirely.
E4 In stop(), remove the `this.frozenFrame = null;` and
   `this.suspendDesired = false;` lines.

Run in order:
1. grep -rn "previewAudioClock" src/player src/runtime
   (must be empty — if not, STOP and report; do not run build:player anyway
   without asking)
2. npm run typecheck
3. npm test

Stop if:
- You need to edit any file outside the allowed list for either ticket
- A type/reference error remains that you cannot fix within the allowed file
- Any test unrelated to previewAudioClock fails
- The grep in step 1 is non-empty

Report per ticket: changed files, which edits (PA-01 paragraph / E1-E4) were
applied, each command result, remaining work, blockers.

Do NOT run or judge real-browser audio-continuity capture (report §5 table
A-E); that acceptance stays with the human / Claude Code. Do not continue to
Phase B (video-embedded audio).
```
