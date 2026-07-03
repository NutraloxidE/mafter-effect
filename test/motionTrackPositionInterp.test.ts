import { describe, expect, it } from "vitest";
import { interpolateInvalidVec3Series } from "../src/editor/motionTrack/positionInterp";
import type { Vec3 } from "../src/core/schema";

const v = (x: number, y = 0, z = 0): Vec3 => ({ x, y, z });

describe("interpolateInvalidVec3Series", () => {
  it("passes through all-valid series", () => {
    const out = interpolateInvalidVec3Series([v(0), v(1), v(2)], v(0));
    expect(out).toEqual([v(0), v(1), v(2)]);
  });

  it("interpolates middle invalid instead of snapping to fallback", () => {
    const out = interpolateInvalidVec3Series([v(0), null, v(10)], v(99));
    expect(out[0]).toEqual(v(0));
    expect(out[1]!.x).toBeCloseTo(5, 5);
    expect(out[2]).toEqual(v(10));
    // must not be baseline/fallback
    expect(out[1]!.x).not.toBe(99);
  });

  it("holds previous at trailing invalids", () => {
    const out = interpolateInvalidVec3Series([v(3), v(4), null, null], v(0));
    expect(out[2]).toEqual(v(4));
    expect(out[3]).toEqual(v(4));
  });

  it("uses next value for leading invalids", () => {
    const out = interpolateInvalidVec3Series([null, null, v(8)], v(0));
    expect(out[0]).toEqual(v(8));
    expect(out[1]).toEqual(v(8));
    expect(out[2]).toEqual(v(8));
  });

  it("all invalid uses fallback", () => {
    const out = interpolateInvalidVec3Series([null, null], v(1, 2, 3));
    expect(out).toEqual([v(1, 2, 3), v(1, 2, 3)]);
  });

  it("limits slope relative to valid median step", () => {
    // valid steps of 1, then a huge jump would be created by bad interp — clamp
    const series: Array<Vec3 | null> = [v(0), v(1), v(2), null, v(100)];
    const out = interpolateInvalidVec3Series(series, v(0), 3);
    // median valid step ≈ 1, max step = 3
    // from v(2) to interpolated toward v(100): without clamp would be ~51 at index 3
    // with clamp from prev=2, max step 3 → at most 5
    expect(out[3]!.x).toBeLessThanOrEqual(2 + 3 + 1e-6);
    // final may also be slope-limited from out[3]
    expect(out[4]!.x).toBeLessThanOrEqual(out[3]!.x + 3 + 1e-6);
  });

  it("snap-back acceptance: max jump ≤ 3× median valid step", () => {
    const series: Array<Vec3 | null> = [
      v(0),
      v(1),
      v(2),
      null, // would have been baseline 0 (snap-back of 2)
      v(3),
      v(4),
    ];
    const out = interpolateInvalidVec3Series(series, v(0), 3);
    const jumps: number[] = [];
    for (let i = 1; i < out.length; i++) {
      jumps.push(Math.abs(out[i]!.x - out[i - 1]!.x));
    }
    const med = 1;
    const maxJump = Math.max(...jumps);
    expect(maxJump).toBeLessThanOrEqual(med * 3 + 1e-6);
    // middle was not baseline
    expect(out[3]!.x).toBeCloseTo(2.5, 5);
  });
});
