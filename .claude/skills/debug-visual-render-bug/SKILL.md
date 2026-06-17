---
name: debug-visual-render-bug
description: Method for debugging visual/rendering bugs that can't be judged from code alone — wrong position/size/spacing/color/baseline, "looks off", or parity mismatches between two render paths (preview vs export, Draft vs Best, before vs after). Use when a bug is described visually and passing tests/typecheck do not prove it is fixed. Drive the real renderer, measure pixels, localize by how the error scales, converge shared math, lock with a unit test.
---

# Debugging visual / rendering bugs

Visual bugs cannot be solved by reading code or doing metric math in your head. Browser/runtime
behavior differs from the spec. **Reproduce in the real renderer, measure, and let the numbers
localize the cause.** This is a measure-don't-theorize loop.

## When to use
- A bug is described **visually**: "位置がズレる", "looks wrong", "二重に見える", spacing/size/
  baseline/color/alignment off.
- A **parity** bug: two outputs that must match don't (preview vs export, mode A vs mode B,
  before vs after a change, two browsers).
- `npm test` / `npm run typecheck` are green but the UI still looks wrong. **Green tests ≠ visually
  correct.** Treat them as necessary, not sufficient.

## The loop

**The fix loop must use Playwright + Chromium as the canonical harness.** Do not declare a fix from
manual browser checks or code reading alone.

1. **Reproduce in the real renderer with Playwright, not in your head.** Start `npm run dev`, drive
   Chromium via Playwright, and capture what it renders. Do not conclude from reading layout code or
   replicating font/CSS math analytically — the browser's real behavior is the ground truth.

2. **Turn "looks wrong" into numbers.** Don't eyeball-diff. Measure concrete geometry of the
   feature: ink bounding box (top/bottom/left/right), element `getBoundingClientRect`, centroids,
   and the **delta between the two states**. Scan pixels programmatically for the feature (e.g.
   near-white text ink on a black stage → first/last row & column above a luminance threshold).

3. **Vary one parameter and watch how the error scales — this localizes the cause faster than
   reading code.**
   - Error is a **constant offset** → origin / wiring / which-element bug.
   - Error **scales with size / zoom / count** → a formula on the wrong basis (em/ratio/percent).
   - Error in **one axis only** → that axis's math.
   - Error **disappears when a value changes** → the value isn't reaching the renderer (timing/state).

4. **Beware false negatives from aggregate metrics.** A raw pixel-diff *count* can hide a small
   positional shift inside the anti-aliasing band. Measure **position** (edges/centroid), not just
   "how many pixels differ". (Real example below: a 330/128000 diff was dismissed as AA but was a
   real 2px baseline shift — only measuring ink-top exposed it.)

5. **For parity bugs, converge on one computation.** If A and B must match, the fix is usually to
   make both consume a **single source of truth** (one layout/positioning function), not to patch
   each path separately. Two formulas drift; one cannot disagree with itself.

6. **Instrument state/timing when a value "doesn't apply".** If the correct value never reaches the
   renderer, add temporary logs for presence/order (`hasRenderer`, effect run order, which instance)
   rather than guessing. Remove the logs after.

7. **Re-measure to confirm convergence, with a tolerance.** Quote before→after numbers
   (e.g. `0.08em → 0.02em`). Define what "good enough" is (sub-pixel / within the AA band) and verify
   you are under it. "Different now" is not "fixed".

8. **Lock with a deterministic regression test.** You usually can't unit-test pixels, so extract the
   **pure computation underneath** (the formula/transform) and test that without a DOM. Document the
   wrong-vs-right basis in the test so the trap isn't re-introduced.

9. **Confirm visually, then clean up.** One side-by-side screenshot for human-confirmable closure.
   Delete throwaway harnesses and temporary logs; don't leave them in the tree.

## Anti-patterns
- Deriving render math purely from font/CSS specs and shipping it without measuring the browser.
- Trusting "tests pass" / "typecheck green" as proof a visual bug is fixed.
- Judging a parity fix by pixel-diff **count** alone (AA noise hides small shifts).
- Patching each render path independently instead of sharing the math.
- Leaving debug `console.log` or a one-off Playwright script committed.

## Worked example (this repo, §26.4 text Draft⇄Best)
Two bugs hid behind one symptom ("Draft and Best don't match"):
1. **Value never applied (constant / total failure).** The renderer was created *after* its comp
   was ready, but the `effectiveTextQuality → setTextQuality` effect didn't re-run on an unchanged
   value, so the renderer kept its default and Draft never took effect. Temporary log showed
   `hasRenderer=false` at the moment the value was "set" → init-order bug. Fix: apply the value at
   renderer creation via a ref.
2. **Error scaled with font size (proportional → formula basis).** Measured ink-top delta:
   48px→2px, 72px→3px, 120px→6px ⇒ ~0.08em, a pure vertical translation. The Best(SVG) baseline used
   **ink height** (`actualBoundingBoxAscent`) while Draft(DOM) used CSS line-box **font metrics**.
   Fix: one formula for both — `baseline = (lineHeight − (ascent + descent))/2 + ascent`, with
   `ascent/descent` from font metrics (opentype ascender/descender; system fonts via canvas
   `fontBoundingBoxAscent/Descent`). Re-measured: 0.08em → ≤0.02em. Locked with unit tests on
   `textBaselineY` (no DOM needed).

## Project harness notes (Mafter Effect)

Canonical setup is documented in [mafter-effect-agent.mdc](mdc:.cursor/rules/mafter-effect-agent.mdc)
(「修正ループの Playwright 実機検証」). Visual-bug extras:

- Reset state via `indexedDB.deleteDatabase("mafter-effect-fs")` + reload, `localStorage.clear()` for viewer settings
- Reach the live store with `(await import("/src/editor/store.ts")).useEditorStore.getState()`
- **Restart the dev server if measurements go flaky.** Accumulated HMR after many edits can null the
  store mid-run or serve a stale module graph. A fresh `vite` on a clean port removes the noise.
- Measure ink bounds inside the comp stage rect; **deselect layers** first so selection handles
  (white dots) don't pollute the scan.
- **Respect INV-1/INV-2.** Render modes are different rasterizations of the *same* `ResolvedScene`;
  `resolve()` stays pure. The precise/export-basis mode is the reference; the fast mode is an
  approximation allowed to differ only within an AA tolerance.
