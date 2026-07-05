import { describe, expect, it } from "vitest";
import {
  alphaMaskHasInk,
  applySubjectMask,
  categoryMaskToAlpha,
  confidenceFloatToAlpha,
  normalizeAlphaMaskForeground,
  scaleAlphaMaskNearest,
} from "../src/editor/subjectExtract/maskComposite";

describe("applySubjectMask", () => {
  it("multiplies alpha by mask luminance", () => {
    const rgba = new Uint8ClampedArray([
      255, 0, 0, 200,
      0, 255, 0, 255,
    ]);
    const mask = new Uint8ClampedArray([128, 255]);
    const out = applySubjectMask(rgba, mask, 2, 1);
    expect(out[0]).toBe(255);
    expect(out[3]).toBe(Math.round(200 * 128 / 255));
    expect(out[7]).toBe(255);
  });

  it("throws on dimension mismatch", () => {
    expect(() =>
      applySubjectMask(new Uint8ClampedArray(4), new Uint8ClampedArray(2), 1, 1),
    ).toThrow(/mismatch/);
  });
});

describe("categoryMaskToAlpha", () => {
  it("maps person category 1 to 255", () => {
    const cat = new Uint8ClampedArray([0, 1, 0, 1]);
    const alpha = categoryMaskToAlpha(cat, 1);
    expect(Array.from(alpha)).toEqual([0, 255, 0, 255]);
  });

  it("maps person category 255 to 255 (MediaPipe binary mask)", () => {
    const cat = new Uint8ClampedArray([0, 255, 0, 255]);
    const alpha = categoryMaskToAlpha(cat, 1);
    expect(Array.from(alpha)).toEqual([0, 255, 0, 255]);
  });
});

describe("confidenceFloatToAlpha", () => {
  it("scales float confidence to byte alpha", () => {
    const f = new Float32Array([0, 0.5, 1]);
    expect(Array.from(confidenceFloatToAlpha(f))).toEqual([0, 128, 255]);
  });
});

describe("scaleAlphaMaskNearest", () => {
  it("upsamples 2x2 mask to 4x4", () => {
    const m = new Uint8ClampedArray([255, 0, 0, 255]);
    const out = scaleAlphaMaskNearest(m, 2, 2, 4, 4);
    expect(out[0]).toBe(255);
    expect(out[3]).toBe(0);
    expect(out.length).toBe(16);
  });
});

describe("normalizeAlphaMaskForeground", () => {
  it("inverts mask when foreground covers almost entire frame", () => {
    const m = new Uint8ClampedArray(100);
    m.fill(255);
    m[0] = 0;
    const out = normalizeAlphaMaskForeground(m);
    expect(out[1]).toBe(0);
    expect(out[0]).toBe(255);
  });
});

describe("alphaMaskHasInk", () => {
  it("detects non-empty mask", () => {
    const m = new Uint8ClampedArray(100);
    m[50] = 200;
    expect(alphaMaskHasInk(m, 1)).toBe(true);
    expect(alphaMaskHasInk(new Uint8ClampedArray(100))).toBe(false);
  });
});
