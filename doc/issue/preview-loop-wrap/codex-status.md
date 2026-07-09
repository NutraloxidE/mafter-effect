# Codex Status: preview-loop-wrap WP-1

- status: implemented-awaiting-capture
- branch: codex/preview-v2-wp1-loop-doublebuffer
- phase0 commit: e5f366e preview v2 phase0: record loop wrap findings
- spec commit: 372ee07 preview v2 wp1: document loop warmup
- implementation commit: c8d09e4 preview v2 wp1: implement loop doublebuffer
- tests/status commit: see the commit containing this file

## Scope

Implemented WP-1 from `doc/preview-improvement-plan-v2-for-codex.md` after confirming `doc/issue/preview-loop-wrap/decision-record.md` has `status: FINAL` and `order: [WP-1, WP-2]`.

The change is preview/bundle scoped:

- `computeVideoLookaheadWarmupTargets` can now emit loop warm-up targets for clips active at `loopStart` when playback is within the lookahead window before `loopEnd`.
- `DomRenderer` tracks preview loop options and the previous rendered frame. On a wrap to `loopStart`, it tries to swap the live video element with the warmed pooled element, falling back to the old seek path when the warmed element is missing or not ready.
- `PreviewPanel` and `BundlePlayer` pass loop range information into `DomRenderer` during playback.
- Scrub/export paths were left unchanged.

## Verification

- PASS: `npm run typecheck`
- PASS: `npm test -- test/videoLookaheadWarmup.test.ts`
- PASS: `npm run build:player`
- PASS: `npm test`

## Awaiting Capture

No pixel/user-perception acceptance is claimed here. Per the plan, the next acceptance step is the real capture comparison by Claude Code or the user using the Phase 0 harness/fixture.

Residual risks:

- The double-buffer swap depends on the loop warm-up element being ready at wrap time. If not ready, the renderer deliberately falls back to the existing seek behavior.
- WP-2 is still pending and should address steady-state desync/playback-rate servo behavior after WP-1 capture.
