import { describe, expect, it } from "vitest";
import { SCANLINES_EFFECT_DEF } from "../src/runtime/builtinEffects";
import { scanlineTilePng } from "../src/runtime/effectSvg";

const ctx = { width: 1920, height: 1080, frame: 0 };

describe("scanlineTilePng (pure)", () => {
  it("returns a raw PNG data URI", () => {
    const { uri } = scanlineTilePng(4, 0.5, 0.35, "horizontal");
    expect(uri.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("horizontal tile keeps the static (x) axis >= 16px — regression for the fractional-scale bug", () => {
    // 実 Chrome 実測: feImage が 1px 幅だと feTile タイル結果が祖先の CSS
    // transform:scale(...)（Preview の Fit ズーム）下で GPU テクスチャ縮小サンプリングが
    // 破綻し、縞が一切描画されない（feBlend multiply が事実上 no-op になり原色が透過する）。
    // mosaicGridSnapFilter の MOSAIC_TILE_MIN_DIM=16 と同じ最小タイル寸法規約をここでも守る。
    const { w, h } = scanlineTilePng(6, 0.5, 0.35, "horizontal");
    expect(w).toBeGreaterThanOrEqual(16);
    expect(h).toBe(6);
  });

  it("vertical tile keeps the static (y) axis >= 16px (swap)", () => {
    const { w, h } = scanlineTilePng(6, 0.5, 0.35, "vertical");
    expect(w).toBe(6);
    expect(h).toBeGreaterThanOrEqual(16);
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
