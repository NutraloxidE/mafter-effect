import { describe, expect, it } from "vitest";
import {
  BurstTracker,
  computeFrustrationScore,
  createFrustrationState,
  FRUSTRATION_THRESHOLD,
  KeyedBurstTracker,
  recordEvent,
  ReversalTracker,
  SIGNAL_WEIGHTS,
} from "../src/editor/feedbackSignals";

describe("BurstTracker", () => {
  it("fires exactly once when crossing the threshold within the window", () => {
    const t = new BurstTracker(10_000, 3);
    expect(t.push(0)).toBe(false);
    expect(t.push(1_000)).toBe(false);
    expect(t.push(2_000)).toBe(true); // 3件目でburst
    expect(t.push(3_000)).toBe(false); // 既にburst状態なので再発火しない
  });

  it("does not fire when events fall outside the window", () => {
    const t = new BurstTracker(10_000, 3);
    expect(t.push(0)).toBe(false);
    expect(t.push(1_000)).toBe(false);
    expect(t.push(20_000)).toBe(false); // 最初の2件は窓外に落ちる
  });

  it("re-fires after the burst resets and re-crosses the threshold", () => {
    const t = new BurstTracker(10_000, 3);
    t.push(0);
    t.push(1_000);
    expect(t.push(2_000)).toBe(true);
    // 十分に時間が経過し、窓内のイベントが再び2件以下に減る
    expect(t.push(50_000)).toBe(false);
    expect(t.push(51_000)).toBe(false);
    expect(t.push(52_000)).toBe(true);
  });
});

describe("KeyedBurstTracker", () => {
  it("tracks independent bursts per key", () => {
    const t = new KeyedBurstTracker(30_000, 2);
    expect(t.push("obj1:opacity", 0)).toBe(false);
    expect(t.push("obj1:position", 0)).toBe(false); // 別キーは影響しない
    expect(t.push("obj1:opacity", 1_000)).toBe(true);
  });
});

describe("ReversalTracker", () => {
  it("ignores the first delta (no prior direction) and counts only true reversals", () => {
    const t = new ReversalTracker(2_000, 4);
    expect(t.pushDelta(1, 0)).toBe(false); // 初回は基準なので反転扱いしない
    expect(t.pushDelta(1, 100)).toBe(false); // 同方向は反転ではない
    expect(t.pushDelta(-1, 200)).toBe(false); // 反転1
    expect(t.pushDelta(1, 300)).toBe(false); // 反転2
    expect(t.pushDelta(-1, 400)).toBe(false); // 反転3
    expect(t.pushDelta(1, 500)).toBe(true); // 反転4 → burst
  });

  it("does not count zero-delta as a direction change", () => {
    const t = new ReversalTracker(2_000, 2);
    t.pushDelta(1, 0);
    expect(t.pushDelta(0, 100)).toBe(false); // delta=0 は反転にカウントしない
    expect(t.pushDelta(-1, 200)).toBe(false); // 反転1
    expect(t.pushDelta(1, 300)).toBe(true); // 反転2 → burst
  });
});

describe("computeFrustrationScore", () => {
  it("sums weights of recent events", () => {
    let state = createFrustrationState();
    state = recordEvent(state, "export_error", 0);
    const score = computeFrustrationScore(state, 0);
    expect(score).toBe(SIGNAL_WEIGHTS.export_error);
  });

  it("decays older events (score strictly decreases with age)", () => {
    let state = createFrustrationState();
    state = recordEvent(state, "undo_burst", 0);
    const scoreNow = computeFrustrationScore(state, 0);
    const scoreLater = computeFrustrationScore(state, 5 * 60 * 1000); // 半減期経過
    expect(scoreLater).toBeLessThan(scoreNow);
    expect(scoreLater).toBeCloseTo(scoreNow / 2, 0);
  });

  it("ignores events outside the score window", () => {
    let state = createFrustrationState();
    state = recordEvent(state, "export_error", 0);
    const score = computeFrustrationScore(state, 31 * 60 * 1000, 30 * 60 * 1000);
    expect(score).toBe(0);
  });

  it("ignores future events relative to now (defensive)", () => {
    let state = createFrustrationState();
    state = recordEvent(state, "export_error", 10_000);
    const score = computeFrustrationScore(state, 0);
    expect(score).toBe(0);
  });

  it("clamps at 100", () => {
    let state = createFrustrationState();
    for (let i = 0; i < 10; i++) {
      state = recordEvent(state, "export_error", 0);
    }
    expect(computeFrustrationScore(state, 0)).toBe(100);
  });

  it("crosses FRUSTRATION_THRESHOLD after a plausible combination of signals", () => {
    let state = createFrustrationState();
    state = recordEvent(state, "undo_burst", 0); // 12
    state = recordEvent(state, "proxy_failed", 0); // +15 = 27
    expect(computeFrustrationScore(state, 0)).toBeLessThan(FRUSTRATION_THRESHOLD);
    state = recordEvent(state, "redo_after_undo", 0); // +4 = 31
    expect(computeFrustrationScore(state, 0)).toBeGreaterThanOrEqual(FRUSTRATION_THRESHOLD);
  });
});
