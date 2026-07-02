import { describe, expect, it } from "vitest";
import { ditherEffectiveReveal, quantizeDitherReveal, shouldForceOpaqueForDither } from "../src/runtime/ditherReveal";

describe("ditherReveal", () => {
  it("quantizeDitherReveal uses 64 steps", () => {
    expect(quantizeDitherReveal(0)).toBe(0);
    expect(quantizeDitherReveal(1)).toBe(1);
    expect(quantizeDitherReveal(0.5)).toBe(32 / 64);
  });

  it("ditherEffectiveReveal multiplies layer opacity and completion", () => {
    expect(ditherEffectiveReveal(1, 0)).toBe(1);
    expect(ditherEffectiveReveal(0.5, 0)).toBe(0.5);
    expect(ditherEffectiveReveal(1, 0.5)).toBe(0.5);
    expect(ditherEffectiveReveal(0.5, 0.5)).toBe(0.25);
  });

  it("shouldForceOpaqueForDither when reveal < 1 only", () => {
    const fx = [{ type: "ditherDissolve", enabled: true, props: { completion: 0 } }];
    expect(shouldForceOpaqueForDither(fx, 0.5)).toBe(true);
    expect(shouldForceOpaqueForDither(fx, 1)).toBe(false);
    expect(shouldForceOpaqueForDither(undefined, 0.5)).toBe(false);
    expect(shouldForceOpaqueForDither([{ type: "ditherDissolve", enabled: false, props: {} }], 0.5)).toBe(false);
  });
});
