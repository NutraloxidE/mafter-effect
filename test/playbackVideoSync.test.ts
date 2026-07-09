import { describe, expect, it, vi } from "vitest";
import {
  computePlaybackSyncState,
  computePlaybackRateForSync,
  dominantVideoSyncErrorSec,
  filterPrimaryVideoSamples,
  holdThresholdsForFps,
  initialPlaybackSyncState,
  isVideoReadyAtTarget,
  isVideoSampleEligible,
  maxVideoLagSec,
  maxVideoLeadSec,
  type VideoClockSample,
} from "../src/runtime/playbackVideoSync";
import { videoSeekThresholdSec } from "../src/runtime/videoElementSync";

function sample(partial: Partial<VideoClockSample> & Pick<VideoClockSample, "targetSec" | "currentTimeSec">): VideoClockSample {
  return {
    paused: false,
    ended: false,
    error: false,
    duration: Number.POSITIVE_INFINITY,
    role: "primary",
    ...partial,
  };
}

describe("holdThresholdsForFps", () => {
  it("uses five-frame failsafe enter and half-frame exit at 30fps", () => {
    const t = holdThresholdsForFps(30);
    expect(t.enterSec).toBeCloseTo(5 / 30, 6);
    expect(t.exitSec).toBeCloseTo(videoSeekThresholdSec(30), 6);
    expect(t.maxHoldSec).toBe(1);
  });
});

describe("computePlaybackRateForSync", () => {
  it("returns 1.0 inside the quarter-frame deadband", () => {
    expect(computePlaybackRateForSync(0.25 / 30, 30)).toBe(1);
    expect(computePlaybackRateForSync(-0.25 / 30, 30)).toBe(1);
  });

  it("speeds up lagging video and slows down leading video", () => {
    expect(computePlaybackRateForSync(0.05, 30)).toBeGreaterThan(1);
    expect(computePlaybackRateForSync(-0.05, 30)).toBeLessThan(1);
  });

  it("clamps correction to +/-4 percent", () => {
    expect(computePlaybackRateForSync(10, 30)).toBe(1.04);
    expect(computePlaybackRateForSync(-10, 30)).toBe(0.96);
  });
});

describe("isVideoSampleEligible", () => {
  it("rejects ended, error, and duration-exceeded samples", () => {
    expect(isVideoSampleEligible(sample({ targetSec: 1, currentTimeSec: 1, ended: true }))).toBe(false);
    expect(isVideoSampleEligible(sample({ targetSec: 1, currentTimeSec: 1, error: true }))).toBe(false);
    expect(
      isVideoSampleEligible(sample({ targetSec: 10, currentTimeSec: 9, duration: 10 })),
    ).toBe(false);
  });

  it("accepts paused samples so sync-pause does not drop lead measurement", () => {
    expect(isVideoSampleEligible(sample({ targetSec: 1, currentTimeSec: 1.2, paused: true }))).toBe(true);
  });
});

describe("maxVideoLagSec / maxVideoLeadSec", () => {
  it("returns max lag and lead among eligible samples", () => {
    const samples = [
      sample({ targetSec: 2, currentTimeSec: 1 }),
      sample({ targetSec: 1, currentTimeSec: 1.5 }),
      sample({ targetSec: 5, currentTimeSec: 0, ended: true }),
    ];
    expect(maxVideoLagSec(samples)).toBeCloseTo(1, 6);
    expect(maxVideoLeadSec(samples)).toBeCloseTo(0.5, 6);
  });

  it("uses presentedSec when available and currentTimeSec as fallback", () => {
    const samples = [
      sample({ targetSec: 2, currentTimeSec: 1, presentedSec: 1.9 }),
      sample({ targetSec: 1, currentTimeSec: 1.5 }),
    ];
    expect(maxVideoLagSec(samples)).toBeCloseTo(0.1, 6);
    expect(maxVideoLeadSec(samples)).toBeCloseTo(0.5, 6);
    expect(dominantVideoSyncErrorSec(samples)).toBeCloseTo(-0.5, 6);
  });
});

describe("computePlaybackSyncState", () => {
  const th = holdThresholdsForFps(30);
  const enter = th.enterSec + 0.001;
  const exit = th.exitSec;

  it("holds timeline when video lags beyond the five-frame failsafe", () => {
    const next = computePlaybackSyncState(
      initialPlaybackSyncState(),
      [sample({ targetSec: 1 + enter, currentTimeSec: 1 })],
      th,
      1000,
    );
    expect(next.holdTimeline).toBe(true);
    expect(next.pauseVideo).toBe(false);
  });

  it("pauses video when video leads beyond the five-frame failsafe", () => {
    const next = computePlaybackSyncState(
      initialPlaybackSyncState(),
      [sample({ targetSec: 1, currentTimeSec: 1 + enter })],
      th,
      1000,
    );
    expect(next.pauseVideo).toBe(true);
    expect(next.holdTimeline).toBe(false);
  });

  it("prefers timeline hold over video pause when both lag and lead exist", () => {
    const next = computePlaybackSyncState(
      initialPlaybackSyncState(),
      [
        sample({ targetSec: 2, currentTimeSec: 1 }), // lag 1s
        sample({ targetSec: 1, currentTimeSec: 2 }), // lead 1s
      ],
      th,
      1000,
    );
    expect(next.holdTimeline).toBe(true);
    expect(next.pauseVideo).toBe(false);
  });

  it("keeps pause while lead is between exit and enter (hysteresis)", () => {
    const pausing = {
      holdTimeline: false,
      pauseVideo: true,
      holdStartedAtMs: null,
      pauseStartedAtMs: 1000,
    };
    const midLead = (th.enterSec + th.exitSec) / 2;
    const still = computePlaybackSyncState(
      pausing,
      [sample({ targetSec: 1, currentTimeSec: 1 + midLead, paused: true })],
      th,
      1100,
    );
    expect(still.pauseVideo).toBe(true);

    const released = computePlaybackSyncState(
      pausing,
      [sample({ targetSec: 1, currentTimeSec: 1 + exit * 0.5, paused: true })],
      th,
      1100,
    );
    expect(released.pauseVideo).toBe(false);
  });

  it("does not oscillate pause on jitter around enter threshold", () => {
    let state = initialPlaybackSyncState();
    const justAbove = th.enterSec * 1.01;
    const justBelow = th.enterSec * 0.99;
    state = computePlaybackSyncState(
      state,
      [sample({ targetSec: 1, currentTimeSec: 1 + justAbove })],
      th,
      0,
    );
    expect(state.pauseVideo).toBe(true);
    state = computePlaybackSyncState(
      state,
      [sample({ targetSec: 1, currentTimeSec: 1 + justBelow, paused: true })],
      th,
      16,
    );
    expect(state.pauseVideo).toBe(true);
  });

  it("force-releases pause after maxHoldSec", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const pausing = {
      holdTimeline: false,
      pauseVideo: true,
      holdStartedAtMs: null,
      pauseStartedAtMs: 0,
    };
    const forced = computePlaybackSyncState(
      pausing,
      [sample({ targetSec: 1, currentTimeSec: 3, paused: true })],
      th,
      1000,
    );
    expect(forced.pauseVideo).toBe(false);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("force-releases timeline hold after maxHoldSec", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const holding = {
      holdTimeline: true,
      pauseVideo: false,
      holdStartedAtMs: 0,
      pauseStartedAtMs: null,
    };
    const forced = computePlaybackSyncState(
      holding,
      [sample({ targetSec: 3, currentTimeSec: 1 })],
      th,
      1000,
    );
    expect(forced.holdTimeline).toBe(false);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("filterPrimaryVideoSamples", () => {
  it("keeps primary samples and drops companion samples", () => {
    const samples = [
      sample({ targetSec: 1, currentTimeSec: 1, role: "primary" }),
      sample({ targetSec: 1, currentTimeSec: 0.4, role: "companion" }),
    ];
    const filtered = filterPrimaryVideoSamples(samples);
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.role).toBe("primary");
  });

  it("regression guard: a lagging split-alpha companion no longer forces a global timeline hold", () => {
    // doc/issue/subject-extract-split-alpha-webm-preview-instability.md 修正1 — companion
    // （見えない alpha mask ストリーム）だけが大きく遅れても、primary（color/通常video）に絞れば
    // holdTimeline は発火しない。companion 込みだと発火することも併せて固定する（対照実験）。
    const th = holdThresholdsForFps(30);
    const samplesWithLaggingCompanion: VideoClockSample[] = [
      sample({ targetSec: 1, currentTimeSec: 1, role: "primary" }), // color: on time
      sample({ targetSec: 1, currentTimeSec: 0.3, role: "companion" }), // alpha companion: 0.7s behind
    ];

    const withCompanion = computePlaybackSyncState(
      initialPlaybackSyncState(),
      samplesWithLaggingCompanion,
      th,
      1000,
    );
    expect(withCompanion.holdTimeline).toBe(true);

    const primaryOnly = computePlaybackSyncState(
      initialPlaybackSyncState(),
      filterPrimaryVideoSamples(samplesWithLaggingCompanion),
      th,
      1000,
    );
    expect(primaryOnly.holdTimeline).toBe(false);
  });
});

describe("isVideoReadyAtTarget", () => {
  it("is true when currentTime is within half-frame of seek target and data is ready", () => {
    const fps = 30;
    const targetSec = 1;
    const seekTo = targetSec + videoSeekThresholdSec(fps);
    expect(
      isVideoReadyAtTarget(
        { currentTime: seekTo, seeking: false, readyState: 2 },
        targetSec,
        fps,
      ),
    ).toBe(true);
  });
});
