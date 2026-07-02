import { describe, expect, it, vi } from "vitest";
import {
  isSourceContinuousAcrossCut,
  primeVideoElement,
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

  it("unmutes the video during playback (§11.4 embedded audio)", () => {
    const video = mockVideo(2, true, { muted: true });
    syncVideoElementTime(video, 2, 30, { playbackMode: true });
    expect(video.muted).toBe(false);
    expect(video.play).toHaveBeenCalled();
  });

  it("keeps the video unmuted while already playing", () => {
    const video = mockVideo(1, false, { muted: true });
    syncVideoElementTime(video, 1 + 1 / 30, 30, { playbackMode: true });
    expect(video.muted).toBe(false);
  });

  it("mutes the video on scrub", () => {
    const video = mockVideo(0, true, { muted: false });
    syncVideoElementTime(video, 1, 30, { playbackMode: false });
    expect(video.muted).toBe(true);
  });

  it("mutes the video on export frame step", () => {
    const video = mockVideo(0, true, { muted: false });
    syncVideoElementTime(video, 1 / 30, 30, { playbackMode: false, exportStep: true });
    expect(video.muted).toBe(true);
  });

  it("does not seek every frame while playing", () => {
    const video = mockVideo(1, false);
    const before = video.currentTime;
    syncVideoElementTime(video, 1 + 1 / 30, 30, { playbackMode: true });
    expect(video.currentTime).toBe(before);
    expect(video.play).not.toHaveBeenCalled();
  });

  it("does not resync on moderate decode-lag drift during playback", () => {
    // target 1.0 との差 0.2s（旧 100ms 閾値超だが新 0.5s 未満）。旧 HW で問題化していた領域。
    const video = mockVideo(0.8, false);
    syncVideoElementTime(video, 1.0, 30, { playbackMode: true });
    expect(video.currentTime).toBe(0.8);
    expect(video.play).not.toHaveBeenCalled();
  });

  it("resyncs only when drift exceeds the large playback threshold", () => {
    // 差 0.6s > 0.5s（ループ復帰・大ジャンプ相当）でのみ currentTime を矯正。
    const video = mockVideo(0.4, false);
    syncVideoElementTime(video, 1.0, 30, { playbackMode: true });
    expect(video.currentTime).toBe(1.0);
  });

  it("forceSeek resyncs at half-frame precision even within the loose playback threshold", () => {
    // カット境界（プール再取得）: 差 0.2s は旧閾値(0.5s)未満のため通常なら seek されないが、
    // forceSeek=true なら trim-in のズレを正しく検出して seek する。
    const video = mockVideo(0.8, false);
    syncVideoElementTime(video, 1.0, 30, { playbackMode: true, forceSeek: true });
    expect(video.currentTime).toBe(1.0);
  });

  it("forceSeek does not seek when the cut is truly contiguous (within half a frame)", () => {
    // trim-in が前クリップの停止位置と一致する連続カット: forceSeek でも無音継続を維持する。
    const video = mockVideo(1.0, false);
    syncVideoElementTime(video, 1.0 + 1 / 120, 30, { playbackMode: true, forceSeek: true });
    expect(video.currentTime).toBe(1.0);
  });

  describe("isSourceContinuousAcrossCut", () => {
    // カット境界の seek 要否は ct（decode lag を含む）ではなく target の軌道で判定する。
    // 実測: 再生中の ct は target から 1〜5 フレーム遅れるのが常態で、ct 基準だと
    // シームレス境界でも毎回 seek が発火して映像・内蔵音声の連続を壊す。
    it("returns true for a seamless cut (next target continues the trajectory)", () => {
      // 前クリップ f59 の target=59/30、次クリップ f60 の target=(60-60+60)/30=2.0 → 連続。
      expect(isSourceContinuousAcrossCut(59 / 30, 59, 2.0, 60, 30)).toBe(true);
    });

    it("returns false when trim-in is shifted beyond half a frame", () => {
      // trim-in +6f（0.2s）ずれ: 期待軌道 2.0 に対し target 2.2 → 不連続 = seek させる。
      expect(isSourceContinuousAcrossCut(59 / 30, 59, 2.2, 60, 30)).toBe(false);
    });

    it("tolerates skipped render frames when the source keeps advancing", () => {
      // f58 → f60（1 フレーム落ち）: 期待 = prev + 2/30。連続とみなす。
      expect(isSourceContinuousAcrossCut(58 / 30, 58, 2.0, 60, 30)).toBe(true);
    });

    it("returns false without previous target info (fresh or warm-up-only element)", () => {
      expect(isSourceContinuousAcrossCut(undefined, undefined, 2.0, 60, 30)).toBe(false);
      expect(isSourceContinuousAcrossCut(Number.NaN, 59, 2.0, 60, 30)).toBe(false);
    });

    it("returns false when frames go backwards (loop restart / scrub jump)", () => {
      expect(isSourceContinuousAcrossCut(59 / 30, 59, 0, 0, 30)).toBe(false);
    });
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

describe("primeVideoElement", () => {
  const halfFrame = videoSeekThresholdSec(30);

  it("scrub-seeks to the target frame center and resolves true when data is ready", async () => {
    const video = mockVideo(0, true);
    await expect(primeVideoElement(video, 1, 30, 200)).resolves.toBe(true);
    expect(video.currentTime).toBeCloseTo(1 + halfFrame, 6);
    expect(video.play).not.toHaveBeenCalled();
  });

  it("returns true immediately when already at the frame and ready (no re-seek)", async () => {
    const center = 1 + halfFrame;
    const video = mockVideo(center, true);
    await expect(primeVideoElement(video, 1, 30, 200)).resolves.toBe(true);
    expect(video.currentTime).toBe(center);
  });

  it("waits for loadeddata before resolving when not yet decoded", async () => {
    let dataCb: (() => void) | undefined;
    const video = mockVideo(1, true, {
      readyState: 0,
      videoWidth: 0,
      addEventListener: vi.fn((ev: string, cb: () => void) => {
        if (ev === "loadeddata") dataCb = cb;
      }),
    });
    const p = primeVideoElement(video, 1, 30, 500);
    Object.assign(video, { readyState: 2, videoWidth: 1920 });
    dataCb?.();
    await expect(p).resolves.toBe(true);
  });

  it("resolves false on timeout when data never becomes ready", async () => {
    const video = mockVideo(1, true, { readyState: 0, videoWidth: 0 });
    await expect(primeVideoElement(video, 1, 30, 30)).resolves.toBe(false);
  });

  it("rejects negative / non-finite targets without seeking", async () => {
    const video = mockVideo(0, true);
    await expect(primeVideoElement(video, -1, 30, 50)).resolves.toBe(false);
    expect(video.currentTime).toBe(0);
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
