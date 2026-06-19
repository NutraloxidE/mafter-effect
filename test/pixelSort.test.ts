import { describe, expect, it } from "vitest";
import {
  isPixelSortIdentity,
  luminance,
  processPixelSort,
  type PixelSortParams,
} from "../src/runtime/pixelSort";
import type { RasterBuffer } from "../src/runtime/plugin";

function makeUnsortedRow(w: number, h: number): RasterBuffer {
  const data = new Uint8ClampedArray(w * h * 4);
  const rowPattern = [255, 32, 200, 64, 128, 16];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = rowPattern[x % rowPattern.length]!;
      const i = (y * w + x) * 4;
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
      data[i + 3] = 255;
    }
  }
  return { data, width: w, height: h };
}

const defaultParams: PixelSortParams = {
  sortingMode: "simple",
  thresholdLow: 0,
  thresholdHigh: 1,
  angle: 0,
  length: 0,
  offset: 0,
  feather: 0,
  sortBlocks: 1,
};

describe("pixelSort (§27.3)", () => {
  it("luminance matches BT.709 weights", () => {
    expect(luminance(255, 255, 255)).toBeCloseTo(1, 5);
    expect(luminance(0, 0, 0)).toBeCloseTo(0, 5);
  });

  it("isPixelSortIdentity detects empty threshold range", () => {
    expect(isPixelSortIdentity({ ...defaultParams, thresholdLow: 0.5, thresholdHigh: 0.3 })).toBe(true);
  });

  it("simple mode changes an unsorted row pattern", () => {
    const input = makeUnsortedRow(64, 8);
    const output = processPixelSort(input, defaultParams, 42);
    expect(Array.from(output.data)).not.toEqual(Array.from(input.data));
  });

  it("is deterministic for same input and seed", () => {
    const input = makeUnsortedRow(32, 32);
    const params: PixelSortParams = { ...defaultParams, sortingMode: "random" };
    const a = processPixelSort(input, params, 99);
    const b = processPixelSort(input, params, 99);
    expect(Array.from(a.data)).toEqual(Array.from(b.data));
  });

  it("angle=90 differs from angle=0 on unsorted pattern", () => {
    const input = makeUnsortedRow(32, 16);
    const h0 = processPixelSort(input, defaultParams, 1);
    const h90 = processPixelSort(input, { ...defaultParams, angle: 90 }, 1);
    expect(Array.from(h0.data)).not.toEqual(Array.from(h90.data));
  });

  it("sortBlocks>1 produces uniform blocks within each block cell", () => {
    const input = makeUnsortedRow(16, 16);
    const output = processPixelSort(input, { ...defaultParams, sortBlocks: 4 }, 1);
    const p00 = [output.data[0], output.data[1], output.data[2]];
    const p03 = [output.data[12], output.data[13], output.data[14]];
    expect(p03).toEqual(p00);
  });
});
