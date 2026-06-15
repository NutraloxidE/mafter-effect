import { describe, expect, it } from "vitest";
import { cubicBezier, easingFn } from "../src/runtime/easing";

describe("cubicBezier", () => {
  it("endpoints are exact", () => {
    const f = cubicBezier(0.42, 0, 0.58, 1);
    expect(f(0)).toBe(0);
    expect(f(1)).toBe(1);
  });

  it("linear control points (0,0,1,1) ≈ identity", () => {
    const f = cubicBezier(0, 0, 1, 1);
    for (const t of [0.1, 0.25, 0.5, 0.75, 0.9]) {
      expect(f(t)).toBeCloseTo(t, 4);
    }
  });

  it("ease-in-out is symmetric around 0.5", () => {
    const f = cubicBezier(0.42, 0, 0.58, 1);
    expect(f(0.5)).toBeCloseTo(0.5, 4);
    expect(f(0.25) + f(0.75)).toBeCloseTo(1, 3);
  });

  it("is monotonic non-decreasing", () => {
    const f = cubicBezier(0.25, 0.1, 0.25, 1);
    let prev = -Infinity;
    for (let t = 0; t <= 1.0001; t += 0.05) {
      const y = f(t);
      expect(y).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = y;
    }
  });
});

describe("easingFn", () => {
  it("linear is identity", () => {
    const f = easingFn({ type: "linear" });
    expect(f(0.3)).toBeCloseTo(0.3, 6);
  });

  it("hold returns 0 (step interpolation)", () => {
    const f = easingFn({ type: "hold" });
    expect(f(0.99)).toBe(0);
  });

  it("bezier delegates to cubicBezier", () => {
    const f = easingFn({ type: "bezier", bezier: [0, 0, 1, 1] });
    expect(f(0.5)).toBeCloseTo(0.5, 4);
  });
});
