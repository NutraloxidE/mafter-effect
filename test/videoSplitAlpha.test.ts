import { describe, expect, it, vi } from "vitest";
import {
  applyAlphaGenlock,
  computeAlphaGenlockRate,
  drawSplitAlphaComposite,
  resetAlphaGenlockRate,
  scheduleSplitAlphaRedrawWhenReady,
} from "../src/runtime/videoSplitAlpha";

// test env is node (no DOM); drawSplitAlphaComposite reads HTMLMediaElement.HAVE_CURRENT_DATA.
if (typeof HTMLMediaElement === "undefined") {
  (globalThis as unknown as { HTMLMediaElement: unknown }).HTMLMediaElement = { HAVE_CURRENT_DATA: 2 };
}

function fakeCanvas(isConnected = true): HTMLCanvasElement {
  return { isConnected } as unknown as HTMLCanvasElement;
}

function fakeVideo(): HTMLVideoElement {
  return {} as unknown as HTMLVideoElement;
}

/** raf that queues callbacks into an array the test drains manually (no real timers). */
function makeManualScheduler(startNow = 0) {
  const queue: Array<() => void> = [];
  let now = startNow;
  return {
    now: () => now,
    raf: (cb: () => void) => { queue.push(cb); },
    advance: (ms: number) => { now += ms; },
    flushOne: () => { const cb = queue.shift(); cb?.(); },
    pendingCount: () => queue.length,
  };
}

describe("scheduleSplitAlphaRedrawWhenReady", () => {
  it("retries via raf until draw succeeds, then stops", () => {
    const scheduler = makeManualScheduler();
    let calls = 0;
    const draw = vi.fn(() => {
      calls++;
      return calls >= 3; // ready on the 3rd attempt
    });
    const canvas = fakeCanvas();
    scheduleSplitAlphaRedrawWhenReady(fakeVideo(), fakeVideo(), canvas, fakeCanvas(), {
      now: scheduler.now,
      raf: scheduler.raf,
      draw,
    });

    scheduler.flushOne();
    scheduler.flushOne();
    expect(draw).toHaveBeenCalledTimes(2);
    expect(scheduler.pendingCount()).toBe(1);

    scheduler.flushOne();
    expect(draw).toHaveBeenCalledTimes(3);
    expect(scheduler.pendingCount()).toBe(0); // stopped retrying after success
  });

  it("gives up after the deadline without looping forever", () => {
    const scheduler = makeManualScheduler();
    const draw = vi.fn(() => false); // never ready
    scheduleSplitAlphaRedrawWhenReady(fakeVideo(), fakeVideo(), fakeCanvas(), fakeCanvas(), {
      now: scheduler.now,
      raf: scheduler.raf,
      draw,
      deadlineMs: 100,
    });

    scheduler.flushOne(); // attempt at now=0, schedules next
    scheduler.advance(150); // past deadline
    scheduler.flushOne(); // this attempt should be the last (now() > deadline)
    expect(scheduler.pendingCount()).toBe(0);
  });

  it("bails out immediately if the canvas is no longer connected (disposed)", () => {
    const scheduler = makeManualScheduler();
    const draw = vi.fn(() => false);
    const canvas = fakeCanvas(false);
    scheduleSplitAlphaRedrawWhenReady(fakeVideo(), fakeVideo(), canvas, fakeCanvas(), {
      now: scheduler.now,
      raf: scheduler.raf,
      draw,
    });

    scheduler.flushOne();
    expect(draw).not.toHaveBeenCalled();
    expect(scheduler.pendingCount()).toBe(0);
  });

  it("does not schedule a second retry loop for the same canvas while one is pending", () => {
    const scheduler = makeManualScheduler();
    const draw = vi.fn(() => false);
    const canvas = fakeCanvas();
    scheduleSplitAlphaRedrawWhenReady(fakeVideo(), fakeVideo(), canvas, fakeCanvas(), {
      now: scheduler.now,
      raf: scheduler.raf,
      draw,
    });
    scheduleSplitAlphaRedrawWhenReady(fakeVideo(), fakeVideo(), canvas, fakeCanvas(), {
      now: scheduler.now,
      raf: scheduler.raf,
      draw,
    });

    expect(scheduler.pendingCount()).toBe(1);
  });
});

// 実機 Playwright 検証（doc/issue/subject-extract-split-alpha-webm-preview-instability.md）で
// 実測したドリフト分布（平均33〜50ms・最大147ms）を境界値として固定する。
describe("computeAlphaGenlockRate", () => {
  it("does not correct sub-threshold drift (avoids rate creep on measurement noise)", () => {
    expect(computeAlphaGenlockRate(0.01)).toBe(1);
    expect(computeAlphaGenlockRate(-0.02)).toBe(1);
  });

  it("gently speeds up alpha when it lags behind color (positive drift)", () => {
    const rate = computeAlphaGenlockRate(0.1);
    expect(rate).toBeGreaterThan(1);
    expect(rate).toBeLessThanOrEqual(1.08);
  });

  it("gently slows down alpha when it leads color (negative drift)", () => {
    const rate = computeAlphaGenlockRate(-0.1);
    expect(rate).toBeLessThan(1);
    expect(rate).toBeGreaterThanOrEqual(0.92);
  });

  it("clamps to the max rate adjust for large-but-still-in-band drift", () => {
    expect(computeAlphaGenlockRate(0.4)).toBeCloseTo(1.08, 5);
    expect(computeAlphaGenlockRate(-0.4)).toBeCloseTo(0.92, 5);
  });

  it("leaves large drift (beyond the hard-seek threshold) uncorrected by rate", () => {
    // 0.5s 超はハードシーク（呼び出し側 applyAlphaGenlock）に委ねる帯域。
    expect(computeAlphaGenlockRate(0.6)).toBe(1);
    expect(computeAlphaGenlockRate(-0.6)).toBe(1);
  });
});

function fakeVideoWithTime(currentTime: number, playbackRate = 1): HTMLVideoElement {
  return { currentTime, playbackRate } as unknown as HTMLVideoElement;
}

describe("applyAlphaGenlock", () => {
  it("nudges playbackRate (no seek) for small drift within the correction band", () => {
    const color = fakeVideoWithTime(1.1);
    const alpha = fakeVideoWithTime(1.0);
    applyAlphaGenlock(color, alpha);
    expect(alpha.currentTime).toBe(1.0); // no seek
    expect(alpha.playbackRate).toBeGreaterThan(1);
  });

  it("hard-seeks alpha to color's currentTime and resets rate when drift exceeds the threshold", () => {
    const color = fakeVideoWithTime(5.0);
    const alpha = fakeVideoWithTime(3.0, 1.05);
    applyAlphaGenlock(color, alpha);
    expect(alpha.currentTime).toBe(5.0);
    expect(alpha.playbackRate).toBe(1);
  });
});

describe("resetAlphaGenlockRate", () => {
  it("resets a non-default playbackRate back to 1", () => {
    const alpha = fakeVideoWithTime(2.0, 1.08);
    resetAlphaGenlockRate(alpha);
    expect(alpha.playbackRate).toBe(1);
  });

  it("is a no-op when playbackRate is already 1", () => {
    const alpha = fakeVideoWithTime(2.0, 1);
    resetAlphaGenlockRate(alpha);
    expect(alpha.playbackRate).toBe(1);
  });
});

function fakeVideoReadyForComposite(w = 64, h = 64): HTMLVideoElement {
  return { readyState: 4, videoWidth: w, videoHeight: h } as unknown as HTMLVideoElement;
}

function fakeCanvasWithCtx(ctx: unknown): HTMLCanvasElement {
  return { width: 0, height: 0, getContext: () => ctx } as unknown as HTMLCanvasElement;
}

describe("drawSplitAlphaComposite — bundle export split-alpha freeze regression", () => {
  it("returns false instead of throwing when getImageData throws (e.g. tainted-canvas SecurityError)", () => {
    // Same throw site/mechanism as drawPackedAlphaComposite's regression test: an uncaught
    // synchronous exception here used to permanently kill the shared rAF playback tick instead
    // of just failing this one composite attempt.
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
    const colorVideo = fakeVideoReadyForComposite();
    const alphaVideo = fakeVideoReadyForComposite();

    expect(() => drawSplitAlphaComposite(colorVideo, alphaVideo, canvas, maskScratch)).not.toThrow();
    expect(drawSplitAlphaComposite(colorVideo, alphaVideo, canvas, maskScratch)).toBe(false);
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
    const colorVideo = fakeVideoReadyForComposite(8, 8);
    const alphaVideo = fakeVideoReadyForComposite(8, 8);

    expect(drawSplitAlphaComposite(colorVideo, alphaVideo, canvas, maskScratch)).toBe(true);
  });
});
