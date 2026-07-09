# Codex Status: preview-loop-wrap WP-1/WP-2

- status: implemented-awaiting-capture
- branch: codex/preview-v2-wp2-presented-servo
- phase0 commit: e5f366e preview v2 phase0: record loop wrap findings
- WP-1 spec commit: 372ee07 preview v2 wp1: document loop warmup
- WP-1 implementation commit: c8d09e4 preview v2 wp1: implement loop doublebuffer
- WP-1 tests/status commit: f8e722d preview v2 wp1: add loop warmup tests
- WP-2 spec commit: 1a4086e preview v2 wp2: document presented-frame servo
- WP-2 implementation commit: 72effb7 preview v2 wp2: implement presented-frame servo
- tests/status commit: see the commit containing this file

## Scope

Implemented WP-1 from `doc/preview-improvement-plan-v2-for-codex.md` after confirming `doc/issue/preview-loop-wrap/decision-record.md` has `status: FINAL` and `order: [WP-1, WP-2]`.

The change is preview/bundle scoped:

- `computeVideoLookaheadWarmupTargets` can now emit loop warm-up targets for clips active at `loopStart` when playback is within the lookahead window before `loopEnd`.
- `DomRenderer` tracks preview loop options and the previous rendered frame. On a wrap to `loopStart`, it tries to swap the live video element with the warmed pooled element, falling back to the old seek path when the warmed element is missing or not ready.
- `PreviewPanel` and `BundlePlayer` pass loop range information into `DomRenderer` during playback.
- Scrub/export paths were left unchanged.

WP-2 adds presented-frame based servo sync:

- `videoPresentedClock.ts` tracks the last rVFC `mediaTime` per video element when available.
- `VideoClockSample.presentedSec` is used before `currentTimeSec` for lag/lead calculations.
- Normal playback applies a continuous `playbackRate` correction clamped to 0.96-1.04 with a quarter-frame deadband.
- `holdTimeline` / `pauseVideo` are now five-frame failsafes; scrub/export/pause reset `playbackRate` to 1.
- Editor preview, HTML bundle no-audio playback, and bundle audio-clock playback all apply the same servo wiring.

## Verification

- PASS: `npm run typecheck`
- PASS: `npm test -- test/videoLookaheadWarmup.test.ts`
- PASS: `npm test -- test/playbackVideoSync.test.ts test/videoElementSync.test.ts`
- PASS: `npm run build:player`
- PASS: `npm test`

## Awaiting Capture

Real Chrome capture was run once after WP-1/WP-2:

- command: `node doc/issue/preview-loop-wrap/capture-comp33-loop-wrap.mjs`
- output: `doc/issue/preview-loop-wrap/out/live/metrics.json`
- wraps: 11
- wrapFreezeStats: median 103ms, max 485ms, min 0ms, values `[0,0,0,0,98,103,103,113,116,215,485]`
- desyncStats: medianAbsFrames 1.77, p95AbsFrames 10.92, maxAbsFrames 147.09, meanSignedFrames 3.24
- ffmpeg freezedetect: 0 windows / 0%

No pixel/user-perception acceptance is claimed from this run. The internal hold proxy still reports a 485ms worst wrap, so status remains `implemented-awaiting-capture` rather than `verified`.

Interpretation: among the measured states so far, the current WP-1/WP-2 implementation is the lightest overall candidate. The worst wrap improved from the Phase 0 baseline max 533ms to 485ms, and the capture-level `overallFreezePct` reported 0% versus the baseline internal-hold freeze ratio of about 9.8%. This is not a clean win: wrap median regressed from 0ms to 103ms and desync p95 landed at 10.92 frames, between the two baseline trials (5.73-24.39). Treat the branch as the best current lightweight candidate, not as accepted/verified.

Residual risks:

- The double-buffer swap depends on the loop warm-up element being ready at wrap time. If not ready, the renderer deliberately falls back to the existing seek behavior.
- rVFC is unavailable in some environments; those fall back to `currentTimeSec`.
- Pixel/user-perception acceptance for both WP-1 and WP-2 is still pending.
