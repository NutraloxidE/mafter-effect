import { describe, expect, it } from "vitest";
import {
  applyAutoScaleToPositions,
  computeAutoScale,
  defaultAutoScaleTargetPx,
  defaultSolveAutoScaleTargetPx,
  isMotionSuspiciouslySmall,
  SOLVE_AUTO_SCALE_HEIGHT_FRAC,
  AUTO_SCALE_HEIGHT_FRAC,
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

  it("applies userScale after autoScale isotropically (X/Y/Z)", () => {
    const baseline = { x: 100, y: 200, z: 300 };
    const positions = [
      baseline,
      { x: 110, y: 205, z: 290 },
      { x: 120, y: 210, z: 280 },
    ];
    const target = 40; // dominant rx=20 → auto=2
    const userScale = 3;
    const { positions: out, autoScale } = applyAutoScaleToPositions(
      positions,
      baseline,
      target,
      userScale,
    );
    expect(autoScale).toBeCloseTo(2, 5);
    // effective = auto * user = 6
    expect(out[2]!.x).toBeCloseTo(100 + 20 * 6, 5);
    expect(out[2]!.y).toBeCloseTo(200 + 10 * 6, 5);
    expect(out[2]!.z).toBeCloseTo(300 + -20 * 6, 5);
  });

  it("userScale alone multiplies when applied as post-factor (solve wiring)", () => {
    // traj at unit scale, then autoScale(target) * userScale — userScale must not be cancelled.
    const baseline = { x: 0, y: 0, z: 0 };
    const unit = [
      baseline,
      { x: 0, y: 0, z: -1 },
      { x: 0, y: 0, z: -2 },
    ];
    const a = applyAutoScaleToPositions(unit, baseline, 100, 1);
    const b = applyAutoScaleToPositions(unit, baseline, 100, 2.5);
    expect(a.autoScale).toBeCloseTo(b.autoScale, 5);
    expect(b.positions[2]!.z).toBeCloseTo(a.positions[2]!.z! * 2.5, 5);
    expect(b.positions[2]!.x).toBeCloseTo(a.positions[2]!.x! * 2.5, 5);
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

describe("default auto-scale targets", () => {
  it("solve target is 10× the position/walk fraction (userScale 10 feedback)", () => {
    expect(SOLVE_AUTO_SCALE_HEIGHT_FRAC / AUTO_SCALE_HEIGHT_FRAC).toBeCloseTo(10, 5);
    expect(defaultSolveAutoScaleTargetPx(1080)).toBeCloseTo(1080 * 1.5, 5);
    expect(defaultAutoScaleTargetPx(1080)).toBeCloseTo(1080 * 0.15, 5);
  });
});
