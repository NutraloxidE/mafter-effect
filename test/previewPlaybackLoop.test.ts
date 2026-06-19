import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { runPreviewFrameClock, runPreviewPlaybackLoop } from "../src/editor/previewPlaybackLoop";

describe("previewPlaybackLoop", () => {
  beforeEach(() => {
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      return setTimeout(() => cb(performance.now()), 16) as unknown as number;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => {
      clearTimeout(id);
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("runPreviewFrameClock advances frames", async () => {
    const frames: number[] = [];
    const stop = runPreviewFrameClock({
      fps: 30,
      loopStart: 0,
      loopEnd: 10,
      loop: false,
      initialFrame: 0,
      onFrameChange: (f) => frames.push(f),
      onPlaybackEnd: () => {},
    });
    await new Promise((r) => setTimeout(r, 80));
    stop();
    expect(frames.length).toBeGreaterThan(0);
    expect(frames[frames.length - 1]).toBeGreaterThan(0);
  });

  it("runPreviewPlaybackLoop calls renderFrame", async () => {
    const rendered: number[] = [];
    const stop = runPreviewPlaybackLoop({
      fps: 30,
      loopStart: 0,
      loopEnd: 10,
      loop: false,
      initialFrame: 0,
      onFrameChange: () => {},
      onPlaybackEnd: () => {},
      renderFrame: (f) => {
        rendered.push(f);
      },
    });
    await new Promise((r) => setTimeout(r, 80));
    stop();
    expect(rendered.length).toBeGreaterThan(0);
  });

  it("non-loop playback stops on last work-area frame", async () => {
    const frames: number[] = [];
    let ended = false;
    const stop = runPreviewFrameClock({
      fps: 1000,
      loopStart: 0,
      loopEnd: 5,
      loop: false,
      initialFrame: 0,
      onFrameChange: (f) => frames.push(f),
      onPlaybackEnd: () => {
        ended = true;
      },
    });
    await new Promise((r) => setTimeout(r, 50));
    stop();
    expect(ended).toBe(true);
    expect(frames[frames.length - 1]).toBe(4);
  });
});
