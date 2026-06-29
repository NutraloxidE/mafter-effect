import { describe, expect, it, vi } from "vitest";
import {
  syncVideoElementTime,
  videoSeekThresholdSec,
  waitForVideoFrame,
} from "../src/runtime/videoElementSync";

function mockVideo(
  currentTime = 0,
  paused = true,
  extra: Record<string, unknown> = {},
): HTMLVideoElement {
  return {
    currentTime,
    paused,
    seeking: false,
    readyState: 2,
    videoWidth: 1920,
    videoHeight: 1080,
    muted: false,
    play: vi.fn().mockResolvedValue(undefined),
    pause: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    setAttribute: vi.fn(),
    removeAttribute: vi.fn(),
    ...extra,
  } as unknown as HTMLVideoElement;
}

describe("videoSeekThresholdSec", () => {
  it("is half a frame at 30fps", () => {
    expect(videoSeekThresholdSec(30)).toBeCloseTo(1 / 60, 6);
  });
});

describe("syncVideoElementTime", () => {
  it("seeks on scrub to frame center when drift exceeds half frame", () => {
    const video = mockVideo(0, true);
    syncVideoElementTime(video, 1, 30, { playbackMode: false });
    expect(video.currentTime).toBeCloseTo(1 + videoSeekThresholdSec(30), 6);
    expect(video.pause).not.toHaveBeenCalled();
  });

  it("skips micro-seek on scrub when already at the frame center", () => {
    const center = 1 + videoSeekThresholdSec(30);
    const video = mockVideo(center, true);
    syncVideoElementTime(video, 1, 30, { playbackMode: false });
    expect(video.currentTime).toBe(center);
  });

  it("starts playback with play() when paused", () => {
    const video = mockVideo(2, true);
    syncVideoElementTime(video, 2, 30, { playbackMode: true });
    expect(video.play).toHaveBeenCalled();
  });

  it("does not seek every frame while playing", () => {
    const video = mockVideo(1, false);
    const before = video.currentTime;
    syncVideoElementTime(video, 1 + 1 / 30, 30, { playbackMode: true });
    expect(video.currentTime).toBe(before);
    expect(video.play).not.toHaveBeenCalled();
  });

  it("resyncs when drift is large during playback", () => {
    const video = mockVideo(0, false);
    syncVideoElementTime(video, 1, 30, { playbackMode: true });
    expect(video.currentTime).toBe(1);
  });

  it("pauses when leaving playback mode", () => {
    const video = mockVideo(1, false);
    syncVideoElementTime(video, 1, 30, { playbackMode: false });
    expect(video.pause).toHaveBeenCalled();
  });

  const halfFrame = videoSeekThresholdSec(30);

  it("exportStep seeks to frame center (target + half frame), no play", () => {
    const video = mockVideo(0, true);
    syncVideoElementTime(video, 1 / 30, 30, { playbackMode: false, exportStep: true });
    expect(video.play).not.toHaveBeenCalled();
    expect(video.currentTime).toBeCloseTo(1 / 30 + halfFrame, 6);
  });

  it("exportStep seeks on large forward jump (frame center)", () => {
    const video = mockVideo(0, true);
    syncVideoElementTime(video, 5, 30, { playbackMode: false, exportStep: true });
    expect(video.play).not.toHaveBeenCalled();
    expect(video.currentTime).toBeCloseTo(5 + halfFrame, 6);
  });

  it("exportStep seeks on backward jump (frame center)", () => {
    const video = mockVideo(2, true);
    syncVideoElementTime(video, 0.5, 30, { playbackMode: false, exportStep: true });
    expect(video.play).not.toHaveBeenCalled();
    expect(video.currentTime).toBeCloseTo(0.5 + halfFrame, 6);
  });

  it("exportStep pauses a playing video before seeking", () => {
    const video = mockVideo(0, false);
    syncVideoElementTime(video, 1, 30, { playbackMode: false, exportStep: true });
    expect(video.pause).toHaveBeenCalled();
    expect(video.currentTime).toBeCloseTo(1 + halfFrame, 6);
  });

  it("exportStep skips re-seek when already at the same frame center", () => {
    const video = mockVideo(1 + halfFrame, true);
    syncVideoElementTime(video, 1, 30, { playbackMode: false, exportStep: true });
    expect(video.currentTime).toBe(1 + halfFrame);
  });
});

describe("syncVideoElementTime scrub seek coalescing", () => {
  const halfFrame = videoSeekThresholdSec(30);
  /** seeking 中の <video> を模し、seeked リスナを1つだけ捕捉する。 */
  function seekingVideo(currentTime = 0): {
    video: HTMLVideoElement;
    fireSeeked: () => void;
    listenerCount: number;
  } {
    const state = { listenerCount: 0, cb: undefined as (() => void) | undefined };
    const video = mockVideo(currentTime, true, {
      seeking: true,
      addEventListener: vi.fn((ev: string, cb: () => void) => {
        if (ev === "seeked") {
          state.listenerCount += 1;
          state.cb = cb;
        }
      }),
    });
    return {
      video,
      fireSeeked: () => {
        Object.assign(video, { seeking: false });
        state.cb?.();
      },
      get listenerCount() {
        return state.listenerCount;
      },
    };
  }

  it("does not assign currentTime while a seek is inflight", () => {
    const h = seekingVideo(0);
    syncVideoElementTime(h.video, 1, 30, { playbackMode: false });
    expect(h.video.currentTime).toBe(0); // 重ね seek しない
    expect(h.listenerCount).toBe(1); // seeked を1回だけ購読
  });

  it("coalesces a burst of scrub seeks into one, applying the latest target", () => {
    const h = seekingVideo(0);
    // 高速ドラッグを模して inflight 中に複数回呼ぶ
    syncVideoElementTime(h.video, 1, 30, { playbackMode: false });
    syncVideoElementTime(h.video, 2, 30, { playbackMode: false });
    syncVideoElementTime(h.video, 3, 30, { playbackMode: false });
    expect(h.video.currentTime).toBe(0); // まだ適用されない
    expect(h.listenerCount).toBe(1); // リスナは貼り直さず1つ

    h.fireSeeked(); // seek 完了 → 最新 target(3) に追従
    expect(h.video.currentTime).toBeCloseTo(3 + halfFrame, 6);
  });

  it("does not re-apply on seeked when already at the latest target", () => {
    const center = 1 + halfFrame;
    const h = seekingVideo(0);
    syncVideoElementTime(h.video, 1, 30, { playbackMode: false });
    Object.assign(h.video, { currentTime: center }); // settle が target に到達
    h.fireSeeked();
    expect(h.video.currentTime).toBe(center); // 余計な再 seek なし
  });
});

describe("waitForVideoFrame", () => {
  it("resolves when at target time", async () => {
    const video = mockVideo(1, true);
    await expect(waitForVideoFrame(video, 1, 100)).resolves.toBeUndefined();
  });

  it("waits for seeked when seeking", async () => {
    let seekCb: (() => void) | undefined;
    const video = mockVideo(0, true, {
      seeking: true,
      addEventListener: vi.fn((ev: string, cb: () => void) => {
        if (ev === "seeked") seekCb = cb;
      }),
    });
    const p = waitForVideoFrame(video, 1, 200);
    seekCb?.();
    Object.assign(video, { seeking: false, currentTime: 1 });
    await p;
  });
});
