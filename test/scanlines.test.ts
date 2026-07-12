import { describe, expect, it } from "vitest";
import { SCANLINES_EFFECT_DEF } from "../src/runtime/builtinEffects";
import { scanlineTilePng } from "../src/runtime/effectSvg";

const ctx = { width: 1920, height: 1080, frame: 0 };

describe("scanlineTilePng (pure)", () => {
  it("returns a raw PNG data URI", () => {
    const { uri } = scanlineTilePng(4, 0.5, 0.35, "horizontal");
    expect(uri.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("horizontal tile has tile dims 1 x lineHeight", () => {
    const { w, h } = scanlineTilePng(6, 0.5, 0.35, "horizontal");
    expect(w).toBe(1);
    expect(h).toBe(6);
  });

  it("vertical tile has tile dims lineHeight x 1 (swap)", () => {
    const { w, h } = scanlineTilePng(6, 0.5, 0.35, "vertical");
    expect(w).toBe(6);
    expect(h).toBe(1);
  });

  it("is deterministic for same inputs", () => {
    const a = scanlineTilePng(5, 0.4, 0.6, "horizontal");
    const b = scanlineTilePng(5, 0.4, 0.6, "horizontal");
    expect(a).toEqual(b);
  });
});

describe("SCANLINES_EFFECT_DEF apply", () => {
  it("opacity=0 returns null (identity)", () => {
    expect(SCANLINES_EFFECT_DEF.apply({ opacity: 0 }, ctx)).toBeNull();
  });

  it("uses feTile and a raw PNG feImage, never <pattern> (§2.5 regression)", () => {
    const r = SCANLINES_EFFECT_DEF.apply({ lineHeight: 3, duty: 0.5, opacity: 0.35 }, ctx);
    expect(r?.kind).toBe("svg");
    if (r?.kind === "svg") {
      expect(r.primitives).toContain("<feTile");
      expect(r.primitives).toContain("data:image/png");
      expect(r.primitives).not.toContain("<pattern");
      expect(r.primitives).toContain('mode="multiply"');
    }
  });
});
