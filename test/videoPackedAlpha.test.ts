import { describe, expect, it } from "vitest";
import {
  computePackedAlphaRects,
  packedLayoutFitsSizeLimit,
  packedVideoHeight,
  PACKED_ALPHA_GUTTER_PX,
} from "../src/runtime/videoPackedAlpha";

describe("packedVideoHeight", () => {
  it("computes 2*contentHeight + gutterPx", () => {
    expect(packedVideoHeight(1080, 8)).toBe(1080 * 2 + 8);
    expect(packedVideoHeight(720, PACKED_ALPHA_GUTTER_PX)).toBe(720 * 2 + PACKED_ALPHA_GUTTER_PX);
  });
});

describe("computePackedAlphaRects", () => {
  it("places color at the top and mask below the gutter", () => {
    const rects = computePackedAlphaRects(1920, { contentHeight: 1080, gutterPx: 8 });
    expect(rects.color).toEqual({ sx: 0, sy: 0, sw: 1920, sh: 1080 });
    expect(rects.mask).toEqual({ sx: 0, sy: 1088, sw: 1920, sh: 1080 });
  });

  it("excludes the gutter band from both rects (no overlap, no gap beyond gutter)", () => {
    const rects = computePackedAlphaRects(100, { contentHeight: 50, gutterPx: 4 });
    const colorBottom = rects.color.sy + rects.color.sh;
    expect(colorBottom).toBe(50);
    expect(rects.mask.sy).toBe(colorBottom + 4);
  });

  it("handles zero gutter (adjacent bands)", () => {
    const rects = computePackedAlphaRects(64, { contentHeight: 32, gutterPx: 0 });
    expect(rects.mask.sy).toBe(32);
  });
});

describe("packedLayoutFitsSizeLimit", () => {
  it("accepts 1080p-class content (well under 4096)", () => {
    expect(packedLayoutFitsSizeLimit({ contentHeight: 1080, gutterPx: 8 })).toBe(true);
  });

  it("rejects content whose packed height exceeds the 4096 limit (4K-class source)", () => {
    // 2*2044 + 8 = 4096 (境界ぴったりは許容)
    expect(packedLayoutFitsSizeLimit({ contentHeight: 2044, gutterPx: 8 })).toBe(true);
    // 2*2045 + 8 = 4098 (超過)
    expect(packedLayoutFitsSizeLimit({ contentHeight: 2045, gutterPx: 8 })).toBe(false);
  });

  it("respects a custom maxHeight override", () => {
    expect(packedLayoutFitsSizeLimit({ contentHeight: 100, gutterPx: 8 }, 200)).toBe(false);
    expect(packedLayoutFitsSizeLimit({ contentHeight: 96, gutterPx: 8 }, 200)).toBe(true);
  });
});
