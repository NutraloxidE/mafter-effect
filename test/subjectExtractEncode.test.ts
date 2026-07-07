import { describe, expect, it } from "vitest";
import { toGrayscaleAlpha, toOpaqueRgbColor } from "../src/editor/subjectExtract/encodeAlphaWebm";
import { isPackedAlphaVideoMeta, isSplitAlphaVideoMeta } from "../src/runtime/imageAssetCache";
import { applyGrayscaleMaskToAlphaChannel } from "../src/runtime/videoSplitAlpha";

describe("subjectExtract encode helpers", () => {
  it("toOpaqueRgbColor keeps RGB and forces opaque alpha", () => {
    const rgba = new Uint8ClampedArray([200, 100, 50, 128, 0, 0, 0, 0]);
    const out = toOpaqueRgbColor(rgba);
    expect(out[0]).toBe(200);
    expect(out[1]).toBe(100);
    expect(out[2]).toBe(50);
    expect(out[3]).toBe(255);
    expect(out[4]).toBe(0);
    expect(out[7]).toBe(255);
  });

  it("toGrayscaleAlpha copies alpha channel to RGB", () => {
    const rgba = new Uint8ClampedArray([10, 20, 30, 200, 0, 0, 0, 64]);
    const out = toGrayscaleAlpha(rgba);
    expect(out[0]).toBe(200);
    expect(out[1]).toBe(200);
    expect(out[2]).toBe(200);
    expect(out[3]).toBe(255);
    expect(out[4]).toBe(64);
    expect(out[7]).toBe(255);
  });
});

describe("applyGrayscaleMaskToAlphaChannel", () => {
  it("copies mask R channel into color alpha", () => {
    const color = {
      data: new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255]),
    } as ImageData;
    const mask = {
      data: new Uint8ClampedArray([128, 128, 128, 255, 0, 0, 0, 255]),
    } as ImageData;
    applyGrayscaleMaskToAlphaChannel(color, mask);
    expect(color.data[3]).toBe(128);
    expect(color.data[7]).toBe(0);
  });
});

describe("isSplitAlphaVideoMeta", () => {
  it("detects split alpha meta", () => {
    expect(
      isSplitAlphaVideoMeta({
        hasAlpha: true,
        alphaMode: "split",
        alphaPath: "assets/x.alpha.webm",
      }),
    ).toBe(true);
    expect(isSplitAlphaVideoMeta({ hasAlpha: true, alphaMode: "unified" })).toBe(false);
  });
});

describe("isPackedAlphaVideoMeta", () => {
  it("detects packed alpha meta (§2.2)", () => {
    expect(
      isPackedAlphaVideoMeta({
        hasAlpha: true,
        alphaMode: "packed",
        packedLayout: "topBottom",
        contentHeight: 1080,
        gutterPx: 8,
      }),
    ).toBe(true);
  });

  it("rejects split/unified meta and incomplete packed meta", () => {
    expect(isSplitAlphaVideoMeta === isPackedAlphaVideoMeta).toBe(false);
    expect(isPackedAlphaVideoMeta({ hasAlpha: true, alphaMode: "split", alphaPath: "x" })).toBe(false);
    expect(isPackedAlphaVideoMeta({ hasAlpha: true, alphaMode: "unified" })).toBe(false);
    expect(
      isPackedAlphaVideoMeta({ hasAlpha: true, alphaMode: "packed", packedLayout: "topBottom" }),
    ).toBe(false); // contentHeight/gutterPx 欠落
  });
});
