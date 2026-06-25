/** preview 再生と scrub/export で video 要素の時刻同期方針を切り替える。 */

export interface VideoElementSyncOptions {
  /** true = タイムライン再生中（ネイティブ decode に任せる） */
  playbackMode: boolean;
}

/** 半フレーム未満の差は無視（scrub/export の過剰 seek 抑制）。 */
export function videoSeekThresholdSec(fps: number): number {
  return 0.5 / Math.max(1, fps);
}

export function syncVideoElementTime(
  video: HTMLVideoElement,
  targetSec: number,
  fps: number,
  options: VideoElementSyncOptions,
): void {
  if (!Number.isFinite(targetSec) || targetSec < 0) return;

  const frameSec = 1 / Math.max(1, fps);
  const seekThreshold = videoSeekThresholdSec(fps);

  if (options.playbackMode) {
    if (video.paused) {
      try {
        if (Math.abs(video.currentTime - targetSec) > seekThreshold) {
          video.currentTime = targetSec;
        }
        void video.play();
      } catch {
        /* play/seek best-effort */
      }
      return;
    }
    // ループ・スキップ等で大きくズレたときだけ再同期
    if (Math.abs(video.currentTime - targetSec) > frameSec * 3) {
      try {
        video.currentTime = targetSec;
      } catch {
        /* seek best-effort */
      }
    }
    return;
  }

  if (!video.paused) {
    try {
      video.pause();
    } catch {
      /* pause best-effort */
    }
  }
  if (Math.abs(video.currentTime - targetSec) > seekThreshold) {
    try {
      video.currentTime = targetSec;
    } catch {
      /* seek best-effort */
    }
  }
}
