import { describe, expect, it } from "vitest";
import { applyFitTransform, computeFitPan, computeFitZoom } from "../src/player/bundleFit";

describe("bundleFit", () => {
  it("computeFitZoom scales comp into viewport", () => {
    expect(computeFitZoom(960, 540, 1920, 1080)).toBeCloseTo(0.5);
    expect(computeFitZoom(1920, 1080, 1920, 1080)).toBe(1);
  });

  it("computeFitPan centers comp in viewport", () => {
    const pan = computeFitPan(960, 540, 1920, 1080, 0.5);
    expect(pan.x).toBe(0);
    expect(pan.y).toBe(0);
    const pan2 = computeFitPan(1000, 800, 1920, 1080, 0.5);
    expect(pan2.x).toBeGreaterThan(0);
    expect(pan2.y).toBeGreaterThan(0);
  });

  it("applyFitTransform sets scale transform on element", () => {
    const el = { style: { width: "", height: "", transform: "", transformOrigin: "" } } as HTMLElement;
    applyFitTransform(el, 960, 540, 1920, 1080);
    expect(el.style.width).toBe("1920px");
    expect(el.style.height).toBe("1080px");
    expect(el.style.transform).toContain("scale(0.5)");
  });
});
