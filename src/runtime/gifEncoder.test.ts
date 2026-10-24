import { describe, expect, it } from "vitest";
import { GifEncoder, gifFrameDelayCs, quantizeRgbaToGif } from "./gifEncoder";

describe("gifFrameDelayCs", () => {
  it("uses cumulative centisecond rounding without long-term 30fps drift", () => {
    expect([0, 1, 2, 3, 4, 5].map((i) => gifFrameDelayCs(i, 30))).toEqual([3, 4, 3, 3, 4, 3]);
  });

  it("clamps unrepresentable rates to one centisecond per frame", () => {
    expect(gifFrameDelayCs(0, 120)).toBe(1);
  });
});

describe("quantizeRgbaToGif", () => {
  it("reserves palette index 255 for one-bit transparency", () => {
    const rgba = new Uint8ClampedArray([
      255, 255, 255, 255,
      10, 20, 30, 127,
      10, 20, 30, 128,
    ]);
    const indexed = quantizeRgbaToGif(rgba, true);
    expect(indexed[0]).not.toBe(255);
    expect(indexed[1]).toBe(255);
    expect(indexed[2]).not.toBe(255);
  });

  it("does not make pixels transparent when alpha export is disabled", () => {
    const indexed = quantizeRgbaToGif(new Uint8Array([0, 0, 0, 0]), false);
    expect(indexed[0]).not.toBe(255);
  });
});

describe("GifEncoder", () => {
  it("writes deterministic GIF89a bytes with the requested dimensions", () => {
    const make = () => {
      const encoder = new GifEncoder(2, 2, 0);
      encoder.addFrame(new Uint8Array([0, 1, 2, 3]), 3, false);
      encoder.addFrame(new Uint8Array([3, 2, 1, 0]), 4, false);
      return encoder.finish();
    };

    const first = make();
    const second = make();
    expect(first).toEqual(second);
    expect(String.fromCharCode(...first.slice(0, 6))).toBe("GIF89a");
    expect(first[6]! | (first[7]! << 8)).toBe(2);
    expect(first[8]! | (first[9]! << 8)).toBe(2);
    expect(first[first.length - 1]).toBe(0x3b);
  });

  it("restores transparent frames to a transparent background to prevent trails", () => {
    const encoder = new GifEncoder(2, 1);
    encoder.addFrame(new Uint8Array([0, 255]), 3, true);
    const bytes = encoder.finish();

    // Logical Screen Descriptor background index is the reserved transparent palette entry.
    expect(bytes[11]).toBe(255);

    let gce = -1;
    for (let i = 0; i < bytes.length - 4; i++) {
      if (bytes[i] === 0x21 && bytes[i + 1] === 0xf9 && bytes[i + 2] === 0x04) {
        gce = i;
        break;
      }
    }
    expect(gce).toBeGreaterThanOrEqual(0);
    // Disposal method 2 + transparency flag = 0b00001001.
    expect(bytes[gce + 3]).toBe(0x09);
  });

  it("rejects frames with the wrong number of pixels", () => {
    const encoder = new GifEncoder(2, 2);
    expect(() => encoder.addFrame(new Uint8Array([0, 1, 2]), 3, false)).toThrow(/expected 4/);
  });
});
