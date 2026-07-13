import { describe, expect, it } from "vitest";
import { HYPER_GLOW_EFFECT_DEF, thresholdTransfer } from "../src/runtime/builtinEffects";

const ctx = { width: 1920, height: 1080, frame: 0 };

describe("thresholdTransfer (pure)", () => {
  it("t=0.5 -> slope=2, intercept=-1", () => {
    const { slope, intercept } = thresholdTransfer(0.5);
    expect(slope).toBeCloseTo(2, 10);
    expect(intercept).toBeCloseTo(-1, 10);
  });

  it("t=0 -> identity (slope=1, intercept=0)", () => {
    const { slope, intercept } = thresholdTransfer(0);
    expect(slope).toBeCloseTo(1, 10);
    expect(intercept).toBeCloseTo(0, 10);
  });

  it("t near 1 is guarded (finite, large slope)", () => {
    const { slope, intercept } = thresholdTransfer(1);
    expect(Number.isFinite(slope)).toBe(true);
    expect(Number.isFinite(intercept)).toBe(true);
  });
});

describe("HYPER_GLOW_EFFECT_DEF apply", () => {
  it("radius=0 returns null", () => {
    expect(HYPER_GLOW_EFFECT_DEF.apply({ radius: 0 }, ctx)).toBeNull();
  });

  it("intensity=0 returns null", () => {
    expect(HYPER_GLOW_EFFECT_DEF.apply({ intensity: 0 }, ctx)).toBeNull();
  });

  it("returns threshold -> blur -> intensity -> screen chain", () => {
    const r = HYPER_GLOW_EFFECT_DEF.apply({ threshold: 0.7, radius: 24, intensity: 1.5 }, ctx);
    expect(r?.kind).toBe("svg");
    if (r?.kind === "svg") {
      expect(r.primitives).toContain("feComponentTransfer");
      expect(r.primitives).toContain("feGaussianBlur");
      expect(r.primitives).toContain('mode="screen"');
    }
  });

  it("white tint (default) omits the tint feColorMatrix", () => {
    const r = HYPER_GLOW_EFFECT_DEF.apply({ radius: 24, intensity: 1.5 }, ctx);
    if (r?.kind === "svg") {
      expect(r.primitives).not.toContain('type="matrix" values="1 0 0 0 0  0 1 0 0 0');
    }
  });

  it("non-white tint adds a feColorMatrix on the glow", () => {
    const r = HYPER_GLOW_EFFECT_DEF.apply(
      { radius: 24, intensity: 1.5, tint: { r: 1, g: 0, b: 0, a: 1 } },
      ctx,
    );
    if (r?.kind === "svg") {
      expect(r.primitives).toContain('result="glow"/>');
    }
  });
});
