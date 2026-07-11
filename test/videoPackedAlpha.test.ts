import { describe, expect, it, vi } from "vitest";
import {
  computePackedAlphaRects,
  drawPackedAlphaComposite,
  packedLayoutFitsSizeLimit,
  packedVideoHeight,
  PACKED_ALPHA_GUTTER_PX,
} from "../src/runtime/videoPackedAlpha";

// test env is node (no DOM); drawPackedAlphaComposite reads HTMLMediaElement.HAVE_CURRENT_DATA.
if (typeof HTMLMediaElement === "undefined") {
  (globalThis as unknown as { HTMLMediaElement: unknown }).HTMLMediaElement = { HAVE_CURRENT_DATA: 2 };
}

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

function fakeVideoReady(vw = 64, vh = 64): HTMLVideoElement {
  return { readyState: 4 /* HAVE_ENOUGH_DATA */, videoWidth: vw, videoHeight: vh } as unknown as HTMLVideoElement;
}

function fakeCanvasWithCtx(ctx: unknown): HTMLCanvasElement {
  return {
    width: 0,
    height: 0,
    getContext: () => ctx,
  } as unknown as HTMLCanvasElement;
}

describe("drawPackedAlphaComposite — bundle export packed-alpha freeze regression", () => {
  it("returns false instead of throwing when getImageData throws (e.g. tainted-canvas SecurityError)", () => {
    // This is the concrete throw site identified while investigating a permanent (non-recovering)
    // playback freeze specific to the exported HTML bundle for packed-alpha video: an uncaught
    // synchronous exception here used to escape all the way out of the shared rAF tick
    // (previewPlaybackLoop.ts / BundleAudioClock.ts), which then never reached its own
    // requestAnimationFrame(tick) reschedule — killing playback permanently. The composite
    // function must fail closed (return false, letting the existing bounded-retry scheduler
    // handle it) rather than throw.
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const ctx = {
      clearRect: vi.fn(),
      drawImage: vi.fn(),
      getImageData: vi.fn(() => {
        throw new DOMException("The canvas has been tainted by cross-origin data.", "SecurityError");
      }),
      putImageData: vi.fn(),
    };
    const canvas = fakeCanvasWithCtx(ctx);
    const maskScratch = fakeCanvasWithCtx(ctx);
    const video = fakeVideoReady();

    expect(() =>
      drawPackedAlphaComposite(video, canvas, maskScratch, { contentHeight: 32, gutterPx: 8 }),
    ).not.toThrow();
    expect(drawPackedAlphaComposite(video, canvas, maskScratch, { contentHeight: 32, gutterPx: 8 })).toBe(false);
    errorSpy.mockRestore();
  });

  it("still returns true on the normal (non-throwing) path", () => {
    const ctx = {
      clearRect: vi.fn(),
      drawImage: vi.fn(),
      getImageData: vi.fn(() => ({ data: new Uint8ClampedArray(4 * 8 * 8) })),
      putImageData: vi.fn(),
    };
    const canvas = fakeCanvasWithCtx(ctx);
    const maskScratch = fakeCanvasWithCtx(ctx);
    const video = fakeVideoReady(8, 8);

    expect(drawPackedAlphaComposite(video, canvas, maskScratch, { contentHeight: 8, gutterPx: 0 })).toBe(true);
  });
});
