import { describe, expect, it } from "vitest";
import {
  TRACK_EXCLUDE_CROWD,
  TRACK_ROI_FULL,
  TRACK_ROI_PRESETS,
  applyRoiMask,
  applyTrackMask,
  enhanceContrastRgba,
  isFullMask,
  isFullRoi,
  isValidTrackMaskPoint,
  normalizeTrackRoi,
  presetToMask,
  presetToRoi,
  resolveTrackMask,
  roiToPixelRect,
} from "../src/editor/motionTrack/trackRoi";

describe("normalizeTrackRoi", () => {
  it("returns full for null/undefined", () => {
    expect(normalizeTrackRoi(null)).toEqual(TRACK_ROI_FULL);
    expect(normalizeTrackRoi(undefined)).toEqual(TRACK_ROI_FULL);
  });

  it("clamps negative and oversized values", () => {
    expect(normalizeTrackRoi({ x: -0.5, y: -1, w: 2, h: 3 })).toEqual({
      x: 0,
      y: 0,
      w: 1,
      h: 1,
    });
  });

  it("enforces minimum 10% size", () => {
    const n = normalizeTrackRoi({ x: 0.5, y: 0.5, w: 0.01, h: 0.01 });
    expect(n.w).toBe(0.1);
    expect(n.h).toBe(0.1);
    expect(n.x + n.w).toBeLessThanOrEqual(1);
    expect(n.y + n.h).toBeLessThanOrEqual(1);
  });

  it("keeps x+w and y+h within [0,1]", () => {
    const n = normalizeTrackRoi({ x: 0.95, y: 0.95, w: 0.5, h: 0.5 });
    expect(n.x + n.w).toBeLessThanOrEqual(1 + 1e-9);
    expect(n.y + n.h).toBeLessThanOrEqual(1 + 1e-9);
    expect(n.w).toBeGreaterThanOrEqual(0.1);
    expect(n.h).toBeGreaterThanOrEqual(0.1);
  });

  it("passes through valid center preset", () => {
    expect(normalizeTrackRoi(TRACK_ROI_PRESETS.center)).toEqual(TRACK_ROI_PRESETS.center);
  });
});

describe("isFullRoi / presetToRoi", () => {
  it("detects full frame", () => {
    expect(isFullRoi(TRACK_ROI_FULL)).toBe(true);
    expect(isFullRoi(TRACK_ROI_PRESETS.center)).toBe(false);
  });

  it("maps presets", () => {
    expect(presetToRoi("top")).toEqual(TRACK_ROI_PRESETS.top);
    expect(presetToRoi("custom", { x: 0.1, y: 0.2, w: 0.3, h: 0.4 })).toEqual({
      x: 0.1,
      y: 0.2,
      w: 0.3,
      h: 0.4,
    });
  });
});

describe("roiToPixelRect", () => {
  it("maps full ROI to full pixels", () => {
    expect(roiToPixelRect(TRACK_ROI_FULL, 100, 80)).toEqual({
      x0: 0,
      y0: 0,
      x1: 100,
      y1: 80,
    });
  });

  it("maps left half", () => {
    expect(roiToPixelRect(TRACK_ROI_PRESETS.left, 100, 80)).toEqual({
      x0: 0,
      y0: 0,
      x1: 50,
      y1: 80,
    });
  });

  it("maps center 50%", () => {
    expect(roiToPixelRect(TRACK_ROI_PRESETS.center, 100, 100)).toEqual({
      x0: 25,
      y0: 25,
      x1: 75,
      y1: 75,
    });
  });
});

describe("applyRoiMask", () => {
  it("returns same buffer for full ROI (no copy)", () => {
    const src = solidRgba(4, 4, 10, 20, 30, 255);
    const out = applyRoiMask(src, 4, 4, TRACK_ROI_FULL);
    expect(out).toBe(src);
  });

  it("zeros pixels outside left half", () => {
    const src = solidRgba(4, 2, 10, 20, 30, 255);
    const out = applyRoiMask(src, 4, 2, TRACK_ROI_PRESETS.left);
    expect(out).not.toBe(src);

    // left half: x=0,1 kept; x=2,3 zeroed
    for (let y = 0; y < 2; y++) {
      for (let x = 0; x < 4; x++) {
        const o = (y * 4 + x) * 4;
        if (x < 2) {
          expect(out[o]).toBe(10);
          expect(out[o + 1]).toBe(20);
          expect(out[o + 2]).toBe(30);
          expect(out[o + 3]).toBe(255);
        } else {
          expect(out[o]).toBe(0);
          expect(out[o + 1]).toBe(0);
          expect(out[o + 2]).toBe(0);
          expect(out[o + 3]).toBe(0);
        }
      }
    }
  });

  it("keeps only center region", () => {
    const w = 4;
    const h = 4;
    const src = solidRgba(w, h, 1, 2, 3, 4);
    // center 50% on 4x4 → pixels [1,3) × [1,3)
    const out = applyRoiMask(src, w, h, TRACK_ROI_PRESETS.center);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const o = (y * w + x) * 4;
        const inside = x >= 1 && x < 3 && y >= 1 && y < 3;
        if (inside) {
          expect(out[o]).toBe(1);
          expect(out[o + 3]).toBe(4);
        } else {
          expect(out[o]).toBe(0);
          expect(out[o + 3]).toBe(0);
        }
      }
    }
  });

  it("preserves buffer length (no crop)", () => {
    const src = solidRgba(8, 6, 9, 8, 7, 6);
    const out = applyRoiMask(src, 8, 6, TRACK_ROI_PRESETS.top);
    expect(out.length).toBe(src.length);
  });
});

describe("background (crowd exclude) mask", () => {
  it("presetToMask(background) excludes crowd corridor", () => {
    const m = presetToMask("background");
    expect(m.exclude).toEqual([TRACK_EXCLUDE_CROWD]);
    expect(isFullMask(m)).toBe(false);
  });

  it("zeros crowd region and keeps road/side/top pixels", () => {
    const w = 100;
    const h = 100;
    const src = solidRgba(w, h, 10, 20, 30, 255);
    const out = applyTrackMask(src, w, h, presetToMask("background"));
    // center of crowd exclude (y≈0.6) should be zero
    const cx = Math.floor(w * 0.5);
    const cy = Math.floor(h * 0.6);
    const co = (cy * w + cx) * 4;
    expect(out[co]).toBe(0);
    // road mid-band above exclude (y=0.25 < 0.35) kept — Comp 27 路面標示帯
    const road = (Math.floor(h * 0.25) * w + cx) * 4;
    expect(out[road]).toBe(10);
    // top-center kept
    const to = (5 * w + cx) * 4;
    expect(out[to]).toBe(10);
    // left edge kept
    const lo = (cy * w + 2) * 4;
    expect(out[lo]).toBe(10);
  });

  it("rejects features inside exclude margin", () => {
    const mask = presetToMask("background");
    // inside crowd zone
    expect(isValidTrackMaskPoint(50, 60, mask, 3, 100, 100)).toBe(false);
    // road band above crowd exclude (Comp 27)
    expect(isValidTrackMaskPoint(50, 25, mask, 3, 100, 100)).toBe(true);
    // top building band
    expect(isValidTrackMaskPoint(50, 5, mask, 3, 100, 100)).toBe(true);
    // left building band
    expect(isValidTrackMaskPoint(5, 50, mask, 3, 100, 100)).toBe(true);
  });

  it("resolveTrackMask prefers mask over roi", () => {
    const m = resolveTrackMask(presetToMask("background"), TRACK_ROI_PRESETS.center);
    expect(m.exclude).toHaveLength(1);
    expect(m.exclude![0]!.x).toBeCloseTo(TRACK_EXCLUDE_CROWD.x, 10);
    expect(m.exclude![0]!.y).toBeCloseTo(TRACK_EXCLUDE_CROWD.y, 10);
    expect(m.include).toBeUndefined();
  });
});

describe("enhanceContrastRgba", () => {
  it("keeps mask zeros", () => {
    const src = solidRgba(4, 4, 100, 100, 100, 255);
    // zero left half
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 2; x++) {
        const o = (y * 4 + x) * 4;
        src[o] = src[o + 1] = src[o + 2] = src[o + 3] = 0;
      }
    }
    const out = enhanceContrastRgba(src, 4, 4);
    expect(out[0]).toBe(0);
    expect(out[4]).toBe(0);
  });

  it("stretches low-contrast non-zero pixels", () => {
    const src = solidRgba(4, 4, 80, 80, 80, 255);
    src[0] = src[1] = src[2] = 60;
    src[4] = src[5] = src[6] = 100;
    const out = enhanceContrastRgba(src, 4, 4);
    // range should expand
    const vals = [out[0]!, out[4]!, out[8]!];
    expect(Math.max(...vals) - Math.min(...vals)).toBeGreaterThanOrEqual(100 - 60);
  });
});

function solidRgba(w: number, h: number, r: number, g: number, b: number, a: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    out[o] = r;
    out[o + 1] = g;
    out[o + 2] = b;
    out[o + 3] = a;
  }
  return out;
}
