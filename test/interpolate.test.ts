import { describe, expect, it } from "vitest";
import { lerp, sampleAny, sampleScalar, sampleVec3 } from "../src/runtime/interpolate";
import { staticProp, vec3 } from "../src/core/props";
import type { AnimatedProp, Vec3 } from "../src/core/schema";

const lin = { type: "linear" as const };

function scalarKfs(): AnimatedProp<number> {
  return {
    value: 0,
    keyframes: [
      { frame: 10, value: 0, easing: lin },
      { frame: 20, value: 100, easing: lin },
    ],
  };
}

describe("lerp", () => {
  it("interpolates", () => {
    expect(lerp(0, 10, 0.5)).toBe(5);
  });
});

describe("sampleScalar", () => {
  it("returns base value when no keyframes", () => {
    expect(sampleScalar(staticProp(42), 5)).toBe(42);
  });

  it("clamps before first and after last keyframe (§6.4)", () => {
    const p = scalarKfs();
    expect(sampleScalar(p, 0)).toBe(0); // before first
    expect(sampleScalar(p, 10)).toBe(0); // at first
    expect(sampleScalar(p, 20)).toBe(100); // at last
    expect(sampleScalar(p, 999)).toBe(100); // after last
  });

  it("linearly interpolates within a segment", () => {
    expect(sampleScalar(scalarKfs(), 15)).toBeCloseTo(50, 6);
  });

  it("hold easing steps (holds start value across the segment)", () => {
    const p: AnimatedProp<number> = {
      value: 0,
      keyframes: [
        { frame: 0, value: 0, easing: { type: "hold" } },
        { frame: 10, value: 100, easing: lin },
      ],
    };
    expect(sampleScalar(p, 5)).toBe(0);
    expect(sampleScalar(p, 9)).toBe(0);
    expect(sampleScalar(p, 10)).toBe(100);
  });
});

describe("sampleVec3", () => {
  it("interpolates each component", () => {
    const p: AnimatedProp<Vec3> = {
      value: vec3(),
      keyframes: [
        { frame: 0, value: vec3(0, 0, 0), easing: lin },
        { frame: 10, value: vec3(10, 20, 30), easing: lin },
      ],
    };
    expect(sampleVec3(p, 5)).toEqual(vec3(5, 10, 15));
  });
});

describe("sampleAny", () => {
  it("passes through non-AnimatedProp raw values", () => {
    expect(sampleAny("hello", 5)).toBe("hello");
    expect(sampleAny({ r: 1, g: 0, b: 0, a: 1 }, 5)).toEqual({ r: 1, g: 0, b: 0, a: 1 });
  });

  it("samples numeric and vec3 AnimatedProps", () => {
    expect(sampleAny(scalarKfs(), 15)).toBeCloseTo(50, 6);
  });

  it("step-interpolates non-numeric AnimatedProps", () => {
    const p: AnimatedProp<string> = {
      value: "a",
      keyframes: [
        { frame: 0, value: "a", easing: lin },
        { frame: 10, value: "b", easing: lin },
      ],
    };
    expect(sampleAny(p, 5)).toBe("a");
    expect(sampleAny(p, 10)).toBe("b");
    expect(sampleAny(p, 15)).toBe("b");
  });
});
