import { describe, expect, it, vi } from "vitest";
import { syncVideoElementTime, videoSeekThresholdSec, waitForVideoFrame } from "../src/runtime/videoElementSync";

function mockVideo(currentTime = 0, paused = true): HTMLVideoElement {
  return {
    currentTime,
    paused,
    play: vi.fn().mockResolvedValue(undefined),
    pause: vi.fn(),
  } as unknown as HTMLVideoElement;
}

describe("videoSeekThresholdSec", () => {
  it("is half a frame at 30fps", () => {
    expect(videoSeekThresholdSec(30)).toBeCloseTo(1 / 60, 6);
  });
});

describe("syncVideoElementTime", () => {
  it("seeks on scrub when drift exceeds half frame", () => {
    const video = mockVideo(0, true);
    syncVideoElementTime(video, 1, 30, { playbackMode: false });
    expect(video.currentTime).toBe(1);
    expect(video.pause).not.toHaveBeenCalled();
  });

  it("skips micro-seek on scrub inside half frame", () => {
    const video = mockVideo(1, true);
    syncVideoElementTime(video, 1 + 1 / 120, 30, { playbackMode: false });
    expect(video.currentTime).toBe(1);
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
});

describe("waitForVideoFrame", () => {
  it("resolves immediately when frame data is ready", async () => {
    const video = {
      readyState: 2,
      videoWidth: 1920,
      videoHeight: 1080,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as HTMLVideoElement;
    await expect(waitForVideoFrame(video, 100)).resolves.toBeUndefined();
    expect(video.addEventListener).not.toHaveBeenCalled();
  });
});
