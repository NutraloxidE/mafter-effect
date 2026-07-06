/** preview 再生: 映像ピクセルとタイムライン（カメラ）の双方向ズレ抑制。 */

import { videoSeekTargetSec, videoSeekThresholdSec } from "./videoElementSync";

/** HTMLMediaElement.HAVE_CURRENT_DATA — node テスト環境に定数が無いため直書き。 */
const HAVE_CURRENT_DATA = 2;

export interface VideoClockSample {
  targetSec: number;
  currentTimeSec: number;
  paused: boolean;
  ended: boolean;
  error: boolean;
  /** 不明時は NaN / Infinity。有限かつ targetSec >= duration なら除外。 */
  duration: number;
  /**
   * "primary" = 表示に直結する主ストリーム（通常 video / split alpha の color）。
   * "companion" = 裏方ストリーム（split alpha の alpha mask 等・単独では画面に映らない）。
   * companion のドリフトは per-element の resync（syncVideoElementTime）で個別に補正されるため、
   * comp 全体を止めてまで待つ理由にはしない（holdTimeline/pauseVideo の判定対象から除外する）。
   */
  role: "primary" | "companion";
}

/** comp 全体の hold/pause 判定に使うサンプルだけを残す（companion を除外）。 */
export function filterPrimaryVideoSamples(
  samples: ReadonlyArray<VideoClockSample>,
): VideoClockSample[] {
  return samples.filter((s) => s.role === "primary");
}

export interface HoldThresholds {
  /** この秒数超の |error| でゲート開始（既定: 1 フレーム）。 */
  enterSec: number;
  /** この秒数以下の |error| でゲート解除（既定: 半フレーム）。 */
  exitSec: number;
  /** 連続ゲートの上限秒（既定: 1.0）。超えたら強制解除。 */
  maxHoldSec: number;
}

/** @deprecated PlaybackSyncState を使う。holdTimeline 互換用。 */
export interface HoldState {
  holding: boolean;
  holdStartedAtMs: number | null;
}

export interface PlaybackSyncState {
  /** 映像遅れ → タイムライン（カメラ）を止める */
  holdTimeline: boolean;
  /** 映像先行 → video を pause（タイムラインは進める） */
  pauseVideo: boolean;
  holdStartedAtMs: number | null;
  pauseStartedAtMs: number | null;
}

export function holdThresholdsForFps(fps: number): HoldThresholds {
  const f = Math.max(1, fps);
  return {
    enterSec: 1 / f,
    exitSec: videoSeekThresholdSec(f),
    maxHoldSec: 1,
  };
}

export function initialHoldState(): HoldState {
  return { holding: false, holdStartedAtMs: null };
}

export function initialPlaybackSyncState(): PlaybackSyncState {
  return {
    holdTimeline: false,
    pauseVideo: false,
    holdStartedAtMs: null,
    pauseStartedAtMs: null,
  };
}

/**
 * hold/pause 判定に使うサンプルか。
 * paused は除外しない（sync pause 中も lead を測る。除外すると pause↔play 発振）。
 */
export function isVideoSampleEligible(sample: VideoClockSample): boolean {
  if (sample.ended || sample.error) return false;
  if (
    Number.isFinite(sample.duration) &&
    sample.duration > 0 &&
    sample.targetSec >= sample.duration
  ) {
    return false;
  }
  return Number.isFinite(sample.targetSec) && Number.isFinite(sample.currentTimeSec);
}

/** 適格サンプルのうち最大のタイムライン先行量（秒）= 映像遅れ。適格なしは 0。 */
export function maxVideoLagSec(samples: ReadonlyArray<VideoClockSample>): number {
  let maxLag = 0;
  for (const s of samples) {
    if (!isVideoSampleEligible(s)) continue;
    const lag = s.targetSec - s.currentTimeSec;
    if (lag > maxLag) maxLag = lag;
  }
  return maxLag;
}

/** 適格サンプルのうち最大の映像先行量（秒）。適格なしは 0。 */
export function maxVideoLeadSec(samples: ReadonlyArray<VideoClockSample>): number {
  let maxLead = 0;
  for (const s of samples) {
    if (!isVideoSampleEligible(s)) continue;
    const lead = s.currentTimeSec - s.targetSec;
    if (lead > maxLead) maxLead = lead;
  }
  return maxLead;
}

function failsafeExpired(
  startedAtMs: number | null,
  nowMs: number,
  maxHoldSec: number,
  label: string,
): boolean {
  if (startedAtMs === null) return false;
  if (nowMs - startedAtMs < maxHoldSec * 1000) return false;
  if (typeof console !== "undefined" && typeof console.warn === "function") {
    console.warn(
      `[mafter] playback ${label} exceeded ${maxHoldSec}s; releasing (A/V may drift)`,
    );
  }
  return true;
}

/**
 * 双方向同期状態遷移。
 * - lag（映像遅れ）優先で holdTimeline（pause しない＝遅れ video が追いつける）
 * - 遅れが無く lead（映像先行）なら pauseVideo
 * - ヒステリシス: enter=1f / exit=半フレーム
 * - 各ゲート連続 maxHoldSec で強制解除
 */
export function computePlaybackSyncState(
  prev: PlaybackSyncState,
  samples: ReadonlyArray<VideoClockSample>,
  thresholds: HoldThresholds,
  nowMs: number,
): PlaybackSyncState {
  const eligible = samples.some(isVideoSampleEligible);
  if (!eligible) {
    return initialPlaybackSyncState();
  }
  const lag = maxVideoLagSec(samples);
  const lead = maxVideoLeadSec(samples);

  // --- timeline hold（映像遅れ）: 優先。hold 中は pause しない ---
  let holdTimeline = prev.holdTimeline;
  let holdStartedAtMs = prev.holdStartedAtMs;
  if (holdTimeline) {
    if (failsafeExpired(holdStartedAtMs, nowMs, thresholds.maxHoldSec, "timeline hold")) {
      holdTimeline = false;
      holdStartedAtMs = null;
    } else if (lag <= thresholds.exitSec) {
      holdTimeline = false;
      holdStartedAtMs = null;
    }
  } else if (lag > thresholds.enterSec) {
    holdTimeline = true;
    holdStartedAtMs = nowMs;
  }

  if (holdTimeline) {
    return {
      holdTimeline: true,
      pauseVideo: false,
      holdStartedAtMs,
      pauseStartedAtMs: null,
    };
  }

  // --- video pause（映像先行）---
  let pauseVideo = prev.pauseVideo;
  let pauseStartedAtMs = prev.pauseStartedAtMs;
  if (pauseVideo) {
    if (failsafeExpired(pauseStartedAtMs, nowMs, thresholds.maxHoldSec, "video pause")) {
      pauseVideo = false;
      pauseStartedAtMs = null;
    } else if (lead <= thresholds.exitSec) {
      pauseVideo = false;
      pauseStartedAtMs = null;
    }
  } else if (lead > thresholds.enterSec) {
    pauseVideo = true;
    pauseStartedAtMs = nowMs;
  }

  return {
    holdTimeline: false,
    pauseVideo,
    holdStartedAtMs: null,
    pauseStartedAtMs,
  };
}

/**
 * @deprecated computePlaybackSyncState を使う。
 * holdTimeline だけを HoldState 形で返す互換ラッパ。
 */
export function computeHoldState(
  prev: HoldState,
  samples: ReadonlyArray<VideoClockSample>,
  thresholds: HoldThresholds,
  nowMs: number,
): HoldState {
  const prevSync: PlaybackSyncState = {
    holdTimeline: prev.holding,
    pauseVideo: false,
    holdStartedAtMs: prev.holdStartedAtMs,
    pauseStartedAtMs: null,
  };
  const next = computePlaybackSyncState(prevSync, samples, thresholds, nowMs);
  return {
    holding: next.holdTimeline,
    holdStartedAtMs: next.holdStartedAtMs,
  };
}

/**
 * Play barrier: 実要素が既に target 近傍かつ data ready なら seek/pause 不要。
 * primed キャッシュは見ない（呼び出し側が毎回判定する）。
 */
export function isVideoReadyAtTarget(
  video: Pick<HTMLVideoElement, "currentTime" | "seeking" | "readyState">,
  targetSec: number,
  fps: number,
): boolean {
  if (!Number.isFinite(targetSec) || targetSec < 0) return false;
  if (video.seeking || video.readyState < HAVE_CURRENT_DATA) return false;
  const seekTo = videoSeekTargetSec(targetSec, fps);
  return Math.abs(video.currentTime - seekTo) <= videoSeekThresholdSec(fps);
}
