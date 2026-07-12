import { describe, expect, it } from "vitest";
import { NOISE_GRAIN_EFFECT_DEF } from "../src/runtime/builtinEffects";

const ctx = { width: 1920, height: 1080, frame: 0 };

describe("NOISE_GRAIN_EFFECT_DEF apply", () => {
  it("amount=0 returns null (identity)", () => {
    expect(NOISE_GRAIN_EFFECT_DEF.apply({ amount: 0 }, ctx)).toBeNull();
  });

  it("is deterministic for same props+frame", () => {
    const a = NOISE_GRAIN_EFFECT_DEF.apply({ amount: 0.2, seed: 5 }, ctx);
    const b = NOISE_GRAIN_EFFECT_DEF.apply({ amount: 0.2, seed: 5 }, ctx);
    expect(a).toEqual(b);
  });

  it("uses feTurbulence + zero-mean feComposite arithmetic (not feComponentTransfer offset)", () => {
    const r = NOISE_GRAIN_EFFECT_DEF.apply({ amount: 0.2, seed: 5 }, ctx);
    expect(r?.kind).toBe("svg");
    if (r?.kind === "svg") {
      expect(r.primitives).toContain("feTurbulence");
      expect(r.primitives).toContain('operator="arithmetic"');
      expect(r.primitives).toContain('k4="-0.1"');
    }
  });

  it("animated seed varies with frame; static seed does not", () => {
    const staticA = NOISE_GRAIN_EFFECT_DEF.apply({ amount: 0.2, seed: 5, animated: false }, { ...ctx, frame: 0 });
    const staticB = NOISE_GRAIN_EFFECT_DEF.apply({ amount: 0.2, seed: 5, animated: false }, { ...ctx, frame: 10 });
    expect(staticA).toEqual(staticB);

    const animA = NOISE_GRAIN_EFFECT_DEF.apply({ amount: 0.2, seed: 5, animated: true }, { ...ctx, frame: 0 });
    const animB = NOISE_GRAIN_EFFECT_DEF.apply({ amount: 0.2, seed: 5, animated: true }, { ...ctx, frame: 10 });
    expect(animA).not.toEqual(animB);
  });

  it("monochrome:false omits the luminance-averaging matrix", () => {
    const r = NOISE_GRAIN_EFFECT_DEF.apply({ amount: 0.2, monochrome: false }, ctx);
    if (r?.kind === "svg") {
      expect(r.primitives).not.toContain("0.33 0.33 0.33");
    }
  });
});
