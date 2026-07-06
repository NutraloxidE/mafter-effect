import { describe, expect, it } from "vitest";
import { bundleAudioUnlockElapsedSec, reanchorStartWallMsAfterHold } from "../src/player/BundleAudioClock";

describe("bundleAudioUnlockElapsedSec", () => {
  it("uses frozenFrame-derived seconds while a hold is active (not raw wall-clock elapsed)", () => {
    // hold 中: startWallMs はまだ再アンカーされていないので wall-clock 経過をそのまま使うと
    // 音声だけ先行した位置に seek されてしまう。frozenFrame ベースが正しい。
    const rangeStart = 0;
    const fps = 30;
    const frozenFrame = 60; // 2.0s 相当で凍結中
    const startWallMs = 1_000;
    const nowMs = 5_000; // 4s 経過した「ふり」をしても無視されるべき
    expect(bundleAudioUnlockElapsedSec(frozenFrame, rangeStart, fps, startWallMs, nowMs)).toBeCloseTo(2.0, 6);
  });

  it("falls back to wall-clock elapsed seconds when not holding (frozenFrame null)", () => {
    const rangeStart = 0;
    const fps = 30;
    const startWallMs = 1_000;
    const nowMs = 3_500; // 2.5s 経過
    expect(bundleAudioUnlockElapsedSec(null, rangeStart, fps, startWallMs, nowMs)).toBeCloseTo(2.5, 6);
  });

  it("clamps to zero instead of returning negative elapsed time", () => {
    expect(bundleAudioUnlockElapsedSec(null, 0, 30, 5_000, 1_000)).toBe(0);
  });

  it("accounts for a non-zero rangeStart when deriving seconds from frozenFrame", () => {
    // rangeStart=30 (1s @30fps), frozenFrame=90 → 60 フレーム経過 = 2.0s。
    expect(bundleAudioUnlockElapsedSec(90, 30, 30, 0, 0)).toBeCloseTo(2.0, 6);
  });
});

describe("reanchorStartWallMsAfterHold", () => {
  it("shifts startWallMs forward by exactly the held wall-clock duration", () => {
    const startWallMs = 1_000;
    const holdEnteredWallMs = 2_000;
    const releaseNowMs = 2_700; // held for 700ms
    expect(reanchorStartWallMsAfterHold(startWallMs, holdEnteredWallMs, releaseNowMs)).toBe(1_700);
  });

  it("produces frame continuity across the hold boundary (no jump)", () => {
    const fps = 30;
    const rangeStart = 0;
    const startWallMs = 0;
    const holdEnterMs = 1_000; // frame at hold-entry: floor(1.0 * 30) = 30
    const frameAtHoldEntry = rangeStart + Math.floor(((holdEnterMs - startWallMs) / 1000) * fps);

    const releaseMs = holdEnterMs + 613; // held for 613ms of wall-clock time
    const reanchored = reanchorStartWallMsAfterHold(startWallMs, holdEnterMs, releaseMs);
    const frameAtRelease = rangeStart + Math.floor(((releaseMs - reanchored) / 1000) * fps);

    // 解除直後は held 直前と同じフレームに連続する（ジャンプしない）。
    expect(frameAtRelease).toBe(frameAtHoldEntry);
  });

  it("does not accumulate drift across repeated hold/release cycles", () => {
    const fps = 30;
    let startWallMs = 0;
    let nowMs = 0;

    // cycle 1: play 500ms, hold 300ms
    nowMs += 500;
    const frameBeforeHold1 = Math.floor(((nowMs - startWallMs) / 1000) * fps);
    const holdEnter1 = nowMs;
    nowMs += 300;
    startWallMs = reanchorStartWallMsAfterHold(startWallMs, holdEnter1, nowMs);
    const frameAfterHold1 = Math.floor(((nowMs - startWallMs) / 1000) * fps);
    expect(frameAfterHold1).toBe(frameBeforeHold1);

    // cycle 2: play another 200ms, hold 900ms
    nowMs += 200;
    const frameBeforeHold2 = Math.floor(((nowMs - startWallMs) / 1000) * fps);
    const holdEnter2 = nowMs;
    nowMs += 900;
    startWallMs = reanchorStartWallMsAfterHold(startWallMs, holdEnter2, nowMs);
    const frameAfterHold2 = Math.floor(((nowMs - startWallMs) / 1000) * fps);
    expect(frameAfterHold2).toBe(frameBeforeHold2);
  });
});
