import { describe, expect, it } from "vitest";
import { fitPackedProxyDimensions } from "../src/runtime/packedVideoProxy";

// buildPackedVideoProxy itself needs <video>/canvas/WebCodecs (browser-only, covered by
// runtime verify), so only the pure dimension math is unit tested here.
describe("fitPackedProxyDimensions (§16.2b packed proxy)", () => {
  it("downscales content dims uniformly when the long side exceeds maxDim", () => {
    // longest(1080, 1138) = 1138 → scale = 640/1138
    const layout = fitPackedProxyDimensions(1080, { contentHeight: 1138, gutterPx: 8 }, 640);
    expect(layout.scale).toBeCloseTo(640 / 1138, 5);
    expect(layout.contentHeight).toBeLessThanOrEqual(640);
    expect(layout.contentWidth).toBeLessThan(1080);
    // aspect ratio roughly preserved
    expect(layout.contentWidth / layout.contentHeight).toBeCloseTo(1080 / 1138, 1);
  });

  it("does not upscale when source is already within maxDim (scale=1)", () => {
    const layout = fitPackedProxyDimensions(300, { contentHeight: 400, gutterPx: 8 }, 960);
    expect(layout.scale).toBe(1);
    expect(layout.contentWidth).toBe(300);
    expect(layout.contentHeight).toBe(400);
  });

  it("produces even dimensions (video encoder requirement)", () => {
    const layout = fitPackedProxyDimensions(1081, { contentHeight: 1139, gutterPx: 7 }, 601);
    expect(layout.contentWidth % 2).toBe(0);
    expect(layout.contentHeight % 2).toBe(0);
  });

  it("clamps gutter to a minimum even when scaled below it (chroma-bleed guard)", () => {
    // gutterPx=8 scaled by a tiny factor would round to 0 or 1 without the floor.
    const layout = fitPackedProxyDimensions(4000, { contentHeight: 4000, gutterPx: 8 }, 100);
    expect(layout.gutterPx).toBeGreaterThanOrEqual(4);
  });

  it("scales gutter proportionally once above the minimum", () => {
    const layout = fitPackedProxyDimensions(2000, { contentHeight: 2000, gutterPx: 40 }, 1000);
    // scale = 0.5 → gutter 40*0.5=20, well above the 4px floor.
    expect(layout.gutterPx).toBe(20);
  });
});
