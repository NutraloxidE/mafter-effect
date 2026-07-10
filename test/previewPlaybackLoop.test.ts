import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runPreviewPlaybackLoop } from "../src/runtime/previewPlaybackLoop";

// fix-plan-v2-minimal: onFrameAudio は renderGate が視覚描画を間引いても frame が進むたびに
// 必ず呼ばれることが要件（declick を adaptiveRenderBudget から独立させるための土台）。
// requestAnimationFrame を手動キューで模擬し、任意の経過時間で tick を進める。

interface FakeRaf {
  now: number;
  advance: (ms: number) => void;
  install: () => void;
  restore: () => void;
}

function makeFakeRaf(): FakeRaf {
  let now = 0;
  let queue: Array<(t: number) => void> = [];
  let origRaf: typeof requestAnimationFrame;
  let origCaf: typeof cancelAnimationFrame;
  return {
    get now() {
      return now;
    },
    set now(v: number) {
      now = v;
    },
    advance(ms: number) {
      now += ms;
      const due = queue;
      queue = [];
      for (const cb of due) cb(now);
    },
    install() {
      origRaf = globalThis.requestAnimationFrame;
      origCaf = globalThis.cancelAnimationFrame;
      let id = 0;
      globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
        queue.push(cb as (t: number) => void);
        return ++id;
      }) as typeof requestAnimationFrame;
      globalThis.cancelAnimationFrame = (() => {}) as typeof cancelAnimationFrame;
    },
    restore() {
      globalThis.requestAnimationFrame = origRaf;
      globalThis.cancelAnimationFrame = origCaf;
    },
  };
}

describe("runPreviewPlaybackLoop — onFrameAudio independence from renderGate", () => {
  let raf: FakeRaf;
  beforeEach(() => {
    raf = makeFakeRaf();
    raf.install();
    vi.spyOn(performance, "now").mockImplementation(() => raf.now);
  });
  afterEach(() => {
    raf.restore();
    vi.restoreAllMocks();
  });

  it("fires onFrameAudio on every frame advance even when renderGate suppresses renderFrame", () => {
    const audioFrames: number[] = [];
    const renderedFrames: number[] = [];
    const fps = 30;
    const msPerFrame = 1000 / fps;

    const stop = runPreviewPlaybackLoop({
      fps,
      loopStart: 0,
      loopEnd: 10,
      loop: false,
      initialFrame: 0,
      renderFrame: (f) => {
        renderedFrames.push(f);
      },
      onFrameChange: () => {},
      onFrameAudio: (f) => {
        audioFrames.push(f);
      },
      onPlaybackEnd: () => {},
      renderGate: {
        // Always suppress the heavy render — simulates adaptiveRenderBudget skipping every frame
        // under CPU pressure, the exact precondition report.md identifies.
        shouldRender: () => false,
        recordRenderCost: () => {},
      },
    });

    // Slack (+0.01ms) keeps each advance safely past the exact frame boundary — repeated
    // additions of the same non-terminating binary fraction (1000/30) can otherwise land a
    // hair under the boundary on some iterations and floor() to 0 (a fake-clock artifact,
    // not a loop bug: real rAF timestamps are never that exact either, and the loop's own
    // `lastRafMs = now - (elapsed % msPerFrame)` compensation is what makes it robust to this).
    raf.advance(0); // prime lastRafMs
    raf.advance(msPerFrame + 0.01); // frame 1
    raf.advance(msPerFrame + 0.01); // frame 2
    raf.advance(msPerFrame + 0.01); // frame 3

    expect(renderedFrames).toEqual([]); // gate suppressed every visual render
    expect(audioFrames).toEqual([1, 2, 3]); // audio callback still ran every frame

    stop();
  });

  it("fires onFrameAudio at the loop-wrap boundary (not just mid-clip frames)", () => {
    const audioFrames: number[] = [];
    const fps = 30;
    const msPerFrame = 1000 / fps;

    const stop = runPreviewPlaybackLoop({
      fps,
      loopStart: 0,
      loopEnd: 3,
      loop: true,
      initialFrame: 0,
      renderFrame: () => {},
      onFrameChange: () => {},
      onFrameAudio: (f) => audioFrames.push(f),
      onPlaybackEnd: () => {},
    });

    raf.advance(0);
    raf.advance(msPerFrame + 0.01); // -> 1
    raf.advance(msPerFrame + 0.01); // -> 2
    raf.advance(msPerFrame + 0.01); // -> wraps back to 0

    expect(audioFrames).toEqual([1, 2, 0]);
    stop();
  });

  it("is a no-op when onFrameAudio is not provided (existing editor-preview callers unaffected)", () => {
    const renderedFrames: number[] = [];
    const fps = 30;
    const msPerFrame = 1000 / fps;

    const stop = runPreviewPlaybackLoop({
      fps,
      loopStart: 0,
      loopEnd: 10,
      loop: false,
      initialFrame: 0,
      renderFrame: (f) => {
        renderedFrames.push(f);
      },
      onFrameChange: () => {},
      onPlaybackEnd: () => {},
    });

    raf.advance(0);
    raf.advance(msPerFrame);
    raf.advance(msPerFrame);

    expect(renderedFrames).toEqual([1, 2]); // unchanged behavior, no crash without the callback
    stop();
  });
});
