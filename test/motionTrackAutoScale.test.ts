import { describe, expect, it } from "vitest";
import {
  applyAutoScaleToPositions,
  computeAutoScale,
  isMotionSuspiciouslySmall,
  vec3Range,
} from "../src/editor/motionTrack/autoScale";

describe("computeAutoScale", () => {
  it("scales dominant axis to target range", () => {
    const deltas = [
      { x: 0, y: 0, z: 0 },
      { x: 0, y: 0, z: -0.1 },
      { x: 0, y: 0, z: -0.2 },
    ];
    const s = computeAutoScale(deltas, 100);
    expect(s).toBeCloseTo(500, 5);
  });

  it("returns 1 when range is tiny", () => {
    const deltas = [
      { x: 0, y: 0, z: 0 },
      { x: 1e-9, y: 0, z: 0 },
    ];
    expect(computeAutoScale(deltas, 100)).toBe(1);
  });
});

describe("applyAutoScaleToPositions", () => {
  it("preserves baseline and stretches motion", () => {
    const baseline = { x: 960, y: 540, z: 1000 };
    const positions = [
      baseline,
      { x: 960, y: 540, z: 999.9 },
      { x: 960, y: 540, z: 999.8 },
    ];
    const { positions: out, autoScale } = applyAutoScaleToPositions(positions, baseline, 100);
    expect(out[0]).toEqual(baseline);
    expect(autoScale).toBeCloseTo(500, 5);
    expect(out[2]!.z).toBeCloseTo(1000 - 100, 5);
  });
});

describe("isMotionSuspiciouslySmall", () => {
  it("flags small range with large flow", () => {
    expect(isMotionSuspiciouslySmall(0.1, 10)).toBe(true);
    expect(isMotionSuspiciouslySmall(50, 10)).toBe(false);
    expect(isMotionSuspiciouslySmall(0.1, 0.5)).toBe(false);
  });
});

describe("vec3Range", () => {
  it("returns dominant axis span", () => {
    expect(
      vec3Range([
        { x: 0, y: 0, z: 0 },
        { x: 3, y: 1, z: 2 },
      ]),
    ).toBe(3);
  });
});
