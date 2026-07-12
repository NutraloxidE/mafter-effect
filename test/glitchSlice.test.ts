import { describe, expect, it } from "vitest";
import { GLITCH_SLICE_EFFECT_DEF } from "../src/runtime/fastEffects";
import {
  DISPLACEMENT_EFFECT_TYPES,
  FAST_DISPLACEMENT_EFFECT_TYPES,
  LIVE_DISPLACEMENT_EFFECT_TYPES,
  glitchSliceDisplaceMapPng,
} from "../src/runtime/effectSvg";

const ctx = { width: 1920, height: 1080, frame: 0 };

describe("glitchSliceDisplaceMapPng (pure)", () => {
  it("is deterministic for same seed+evolution", () => {
    const a = glitchSliceDisplaceMapPng({ w: 64, h: 64, sliceHeight: 8, maxShift: 60, density: 0.5, seed: 3, evolution: 10 });
    const b = glitchSliceDisplaceMapPng({ w: 64, h: 64, sliceHeight: 8, maxShift: 60, density: 0.5, seed: 3, evolution: 10 });
    expect(a).toEqual(b);
  });

  it("returns a raw PNG data URI (not SVG rect/pattern)", () => {
    const { uri } = glitchSliceDisplaceMapPng({ w: 32, h: 32, sliceHeight: 8, maxShift: 60, density: 0.5, seed: 3, evolution: 0 });
    expect(uri.startsWith("data:image/png;base64,")).toBe(true);
    expect(uri).not.toContain("<rect");
    expect(uri).not.toContain("<pattern");
  });

  it("scale equals maxShift", () => {
    const { scale } = glitchSliceDisplaceMapPng({ w: 32, h: 32, sliceHeight: 8, maxShift: 42, density: 0.5, seed: 1, evolution: 0 });
    expect(scale).toBe(42);
  });

  it("different evolution changes output", () => {
    const a = glitchSliceDisplaceMapPng({ w: 32, h: 32, sliceHeight: 8, maxShift: 60, density: 0.9, seed: 3, evolution: 0 });
    const b = glitchSliceDisplaceMapPng({ w: 32, h: 32, sliceHeight: 8, maxShift: 60, density: 0.9, seed: 3, evolution: 90 });
    expect(a.uri).not.toEqual(b.uri);
  });
});

describe("glitchSlice wiring (§2.2 4 配線点・回帰テスト)", () => {
  it("is registered in DISPLACEMENT_EFFECT_TYPES", () => {
    expect(DISPLACEMENT_EFFECT_TYPES.has("glitchSlice")).toBe(true);
  });

  it("is registered in FAST_DISPLACEMENT_EFFECT_TYPES", () => {
    expect(FAST_DISPLACEMENT_EFFECT_TYPES.has("glitchSlice")).toBe(true);
  });

  it("is registered in LIVE_DISPLACEMENT_EFFECT_TYPES", () => {
    expect(LIVE_DISPLACEMENT_EFFECT_TYPES.has("glitchSlice")).toBe(true);
  });
});

describe("GLITCH_SLICE_EFFECT_DEF apply", () => {
  it("intensity=0 returns null", () => {
    expect(GLITCH_SLICE_EFFECT_DEF.apply({ intensity: 0 }, ctx)).toBeNull();
  });

  it("maxShift=0 returns null", () => {
    expect(GLITCH_SLICE_EFFECT_DEF.apply({ maxShift: 0 }, ctx)).toBeNull();
  });

  it("returns a feDisplacementMap chain referencing a raw PNG feImage", () => {
    const r = GLITCH_SLICE_EFFECT_DEF.apply({ intensity: 0.5, maxShift: 60 }, ctx);
    expect(r?.kind).toBe("svg");
    if (r?.kind === "svg") {
      expect(r.primitives).toContain("feDisplacementMap");
      expect(r.primitives).toContain("data:image/png");
    }
  });
});
