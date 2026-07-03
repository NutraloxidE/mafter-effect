import { describe, expect, it } from "vitest";
import {
  TRACK_VALIDITY_WARN_RATIO,
  summarizeTrackValidity,
} from "../src/editor/motionTrack/trackDiagnostics";

describe("summarizeTrackValidity", () => {
  it("returns 0 for empty mask", () => {
    expect(summarizeTrackValidity([])).toEqual({
      validCount: 0,
      total: 0,
      validRatio: 0,
    });
  });

  it("skips warmup frames", () => {
    const mask = [false, false, false, false, true, true, false, true];
    const s = summarizeTrackValidity(mask, 4);
    expect(s.total).toBe(4);
    expect(s.validCount).toBe(3);
    expect(s.validRatio).toBeCloseTo(0.75, 5);
  });

  it("detects total failure below warn ratio", () => {
    const mask = Array.from({ length: 20 }, (_, i) => i < 4 || i === 10);
    // warmup 4, then 16 frames with 1 valid → 1/16 = 0.0625
    const s = summarizeTrackValidity(mask, 4);
    expect(s.validRatio).toBeLessThan(TRACK_VALIDITY_WARN_RATIO);
  });

  it("all valid after warmup", () => {
    const mask = Array.from({ length: 10 }, () => true);
    const s = summarizeTrackValidity(mask, 4);
    expect(s.validRatio).toBe(1);
  });
});
