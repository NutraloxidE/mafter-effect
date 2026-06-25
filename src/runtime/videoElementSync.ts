/** preview 再生と scrub/export で video 要素の時刻同期方針を切り替える。 */

const DEFAULT_VIDEO_FRAME_WAIT_MS = 5000;
/** HTMLMediaElement.HAVE_CURRENT_DATA — 定数直書き（node テスト環境に HTMLMediaElement が無い） */
const HAVE_CURRENT_DATA = 2;

/** export 前に video の seek / decode が完了するのを待つ（foreignObject は video を描けないため）。 */
export function waitForVideoFrame(
  video: HTMLVideoElement,
  timeoutMs = DEFAULT_VIDEO_FRAME_WAIT_MS,
): Promise<void> {
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer);
      video.removeEventListener("seeked", done);
      video.removeEventListener("loadeddata", done);
      video.removeEventListener("loadedmetadata", done);
    };
    const done = () => {
      cleanup();
      resolve();
    };
    if (video.readyState >= HAVE_CURRENT_DATA && video.videoWidth > 0) {
      done();
      return;
    }
    timer = setTimeout(done, timeoutMs);
    video.addEventListener("seeked", done, { once: true });
    video.addEventListener("loadeddata", done, { once: true });
    video.addEventListener("loadedmetadata", done, { once: true });
  });
}

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
