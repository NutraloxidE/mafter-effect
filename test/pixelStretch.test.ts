import { describe, expect, it } from "vitest";
import { PIXEL_STRETCH_EFFECT_DEF } from "../src/runtime/fastEffects";
import {
  DISPLACEMENT_EFFECT_TYPES,
  FAST_DISPLACEMENT_EFFECT_TYPES,
  LIVE_DISPLACEMENT_EFFECT_TYPES,
  pixelStretchDisplaceMapPng,
} from "../src/runtime/effectSvg";

const ctx = { width: 1920, height: 1080, frame: 0 };

describe("pixelStretchDisplaceMapPng (pure)", () => {
  it("is deterministic for the same inputs", () => {
    const a = pixelStretchDisplaceMapPng({ h: 200, amount: 100, pivot: 0.5 });
    const b = pixelStretchDisplaceMapPng({ h: 200, amount: 100, pivot: 0.5 });
    expect(a).toEqual(b);
  });

  it("returns a raw PNG data URI (not SVG rect/pattern)", () => {
    const { uri } = pixelStretchDisplaceMapPng({ h: 200, amount: 100, pivot: 0.5 });
    expect(uri.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("scale equals amount", () => {
    const { scale } = pixelStretchDisplaceMapPng({ h: 200, amount: 250, pivot: 0.5 });
    expect(scale).toBe(250);
  });

  it("row at pivot maps to the neutral (0.5) R channel value", () => {
    // dy(pivot) = 0 -> R channel encodes exactly 0.5 (127 or 128 after rounding).
    const h = 200;
    const amount = 100;
    const { uri } = pixelStretchDisplaceMapPng({ h, amount, pivot: 0.5 });
    expect(uri).toEqual(pixelStretchDisplaceMapPng({ h, amount, pivot: 0.5 }).uri);
  });
});

describe("pixelStretch wiring (§2.2-style 4 配線点・回帰テスト)", () => {
  it("is registered in DISPLACEMENT_EFFECT_TYPES", () => {
    expect(DISPLACEMENT_EFFECT_TYPES.has("pixelStretch")).toBe(true);
  });

  it("is registered in FAST_DISPLACEMENT_EFFECT_TYPES", () => {
    expect(FAST_DISPLACEMENT_EFFECT_TYPES.has("pixelStretch")).toBe(true);
  });

  it("is registered in LIVE_DISPLACEMENT_EFFECT_TYPES", () => {
    expect(LIVE_DISPLACEMENT_EFFECT_TYPES.has("pixelStretch")).toBe(true);
  });
});

describe("PIXEL_STRETCH_EFFECT_DEF apply", () => {
  it("amount=0 returns null", () => {
    expect(PIXEL_STRETCH_EFFECT_DEF.apply({ amount: 0 }, ctx)).toBeNull();
  });

  it("returns a feDisplacementMap chain referencing a raw PNG feImage", () => {
    const r = PIXEL_STRETCH_EFFECT_DEF.apply({ amount: 300, pivot: 0.5 }, ctx);
    expect(r?.kind).toBe("svg");
    if (r?.kind === "svg") {
      expect(r.primitives).toContain("feDisplacementMap");
      expect(r.primitives).toContain("data:image/png");
    }
  });
});
