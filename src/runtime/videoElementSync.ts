/** preview 再生と scrub/export で video 要素の時刻同期方針を切り替える。 */

export const EXPORT_VIDEO_TARGET_ATTR = "data-mafter-export-video-target";

const DEFAULT_VIDEO_FRAME_WAIT_MS = 1500;
/** HTMLMediaElement.HAVE_CURRENT_DATA — 定数直書き（node テスト環境に HTMLMediaElement が無い） */
const HAVE_CURRENT_DATA = 2;

/** rVFC が new presented frame の提示時刻 mediaTime を渡す（stale フレーム判別に使う）。 */
type RvfMeta = { mediaTime?: number };
type VideoWithRvf = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: (now: number, meta: RvfMeta) => void) => number;
};

/** target フレームを実際に present し終えるまでの最大待ち（rVFC 未発火時のフォールバック）。 */
const PRESENT_WAIT_MS = 300;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function onceEvent(target: EventTarget, type: string): Promise<void> {
  return new Promise((resolve) => {
    target.addEventListener(type, () => resolve(), { once: true });
  });
}

/**
 * rVFC で「target に一致する presented フレーム」が出るまで待つ。
 * seek 完了直後の最初の rVFC が seek 前に提示済みの古いフレームを指すことがあるため、
 * mediaTime ≈ target を満たす present を待って初めて resolve する（every-Nth stale capture 防止）。
 * targetSec 未指定 = 1 present 待ち。rVFC 非対応/未発火環境は maxMs でフォールバック。
 */
function waitPresentedFrame(
  video: HTMLVideoElement,
  targetSec: number | undefined,
  fps: number,
  maxMs: number,
): Promise<void> {
  return new Promise((resolve) => {
    const rvf = (video as VideoWithRvf).requestVideoFrameCallback;
    const timer = setTimeout(resolve, Math.max(0, maxMs));
    if (typeof rvf !== "function") {
      clearTimeout(timer);
      resolve();
      return;
    }
    const tol = videoSeekThresholdSec(fps);
    const tick = (_now: number, meta: RvfMeta): void => {
      const mt = meta?.mediaTime;
      // source fps が comp fps 未満だと target ちょうどのフレームが無いので、
      // 半フレーム以内 OR その手前（target を内包する直近フレーム）を許容。
      if (
        targetSec === undefined ||
        typeof mt !== "number" ||
        (mt <= targetSec + tol && mt > targetSec - 1 / Math.max(1, fps) - tol)
      ) {
        clearTimeout(timer);
        resolve();
        return;
      }
      rvf.call(video, tick);
    };
    rvf.call(video, tick);
  });
}

/**
 * export 前に video の seek / decode / present が完了するのを待つ。
 * targetSec 指定時は target フレームが実際に提示されるまで待つ（古いフレーム capture 防止）。
 */
export async function waitForVideoFrame(
  video: HTMLVideoElement,
  targetSec?: number,
  timeoutMs = DEFAULT_VIDEO_FRAME_WAIT_MS,
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  const fps = 30;

  // 1. seek / decode の完了を待つ（currentTime が target に乗り data が揃うまで）。
  while (performance.now() < deadline) {
    if (video.seeking) {
      await Promise.race([onceEvent(video, "seeked"), sleep(50)]);
      continue;
    }
    if (video.readyState < HAVE_CURRENT_DATA || video.videoWidth <= 0) {
      await Promise.race([
        onceEvent(video, "loadeddata"),
        onceEvent(video, "loadedmetadata"),
        sleep(40),
      ]);
      continue;
    }
    break;
  }

  // 2. target フレームが compositor に present されるまで待つ（drawImage が新フレームを得る）。
  const presentBudget = Math.min(PRESENT_WAIT_MS, Math.max(0, deadline - performance.now()));
  await waitPresentedFrame(video, targetSec, fps, presentBudget);
}

/**
 * scrub 中の seek 詰まり対策。inflight seek 中に新しい currentTime 代入を重ねると
 * デコーダの seek（キーフレーム検索→前方デコード）が積み上がってもっさりする。
 * 要素ごとに最新の希望時刻だけ保持し、seeked 完了後に最新値へ1回だけ追従する。
 * scrub 経路専用（export=決定論 seek+待ち / playback=native play はこの state を触らない）。
 */
const scrubSeekState = new WeakMap<HTMLVideoElement, { pending: number | null; listening: boolean }>();

export interface VideoElementSyncOptions {
  /** true = タイムライン再生中（ネイティブ decode に任せる） */
  playbackMode: boolean;
  /** mp4/png export: 各フレームを正確な target 時刻へ決定論 seek（INV-2） */
  exportStep?: boolean;
}

/** 半フレーム未満の差は無視（scrub/export の過剰 seek 抑制）。 */
export function videoSeekThresholdSec(fps: number): number {
  return 0.5 / Math.max(1, fps);
}

/**
 * フレーム整列 target（k/fps）から **実際に seek すべき時刻** を返す。
 * 境界ちょうどへ seek すると float 丸めで currentTime が境界をわずかに下回り、
 * 前フレームが選ばれる（k≡2 mod 3 等で every-Nth 重複 = もっさり）。
 * フレーム区間の中央へ seek して目的フレームを確実に選ぶ。
 * scrub（preview 停止）と export 双方が同一フレームを表示するための単一の正（INV-2）。
 */
export function videoSeekTargetSec(frameAlignedSec: number, fps: number): number {
  return frameAlignedSec + videoSeekThresholdSec(fps);
}

/**
 * export 専用: 各フレームを **決定論 seek** で目的フレームへ合わせる。
 * かつて play() でデコードを進めていたが、play は実時間進行のため export ループの
 * 離散フレーム処理とズレ、ターゲットを行き過ぎ→逆行 seek→再度行き過ぎ、で
 * フレームが前後に振動（ちらつき）し INV-2（フレーム決定論）を破る。
 * 常に pause + フレーム中央へ seek し、waitForVideoFrame で present を待つ。
 */
function syncVideoElementExportStep(
  video: HTMLVideoElement,
  targetSec: number,
  fps: number,
): void {
  const halfFrame = videoSeekThresholdSec(fps);
  const seekTo = videoSeekTargetSec(targetSec, fps);
  try {
    video.muted = true;
    if (!video.paused) video.pause();
    if (Math.abs(video.currentTime - seekTo) > halfFrame) {
      video.currentTime = seekTo;
    }
  } catch {
    /* pause/seek best-effort */
  }
}

export function syncVideoElementTime(
  video: HTMLVideoElement,
  targetSec: number,
  fps: number,
  options: VideoElementSyncOptions,
): void {
  if (!Number.isFinite(targetSec) || targetSec < 0) return;

  if (options.exportStep) {
    syncVideoElementExportStep(video, targetSec, fps);
    return;
  }

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
  // scrub も export と同じフレーム中央へ seek（preview↔export で同一フレーム表示・INV-2）。
  const scrubTo = videoSeekTargetSec(targetSec, fps);
  if (Math.abs(video.currentTime - scrubTo) <= seekThreshold) {
    return;
  }
  // inflight seek 中は currentTime を重ねず、最新の希望時刻だけ保持して seeked 後に追従する
  // （高速ドラッグの N 回 seek を実質 1〜2 回に畳み込み、デコーダ詰まりを解消）。
  if (video.seeking) {
    const state = scrubSeekState.get(video) ?? { pending: null, listening: false };
    state.pending = scrubTo;
    if (!state.listening) {
      state.listening = true;
      const onSeeked = (): void => {
        const s = scrubSeekState.get(video);
        if (!s) return;
        s.listening = false;
        const next = s.pending;
        s.pending = null;
        // settle 後も最新 target からズレていれば 1 回だけ追従。
        // この代入で再び seeking になっても、ドラッグ継続中の次の sync 呼び出しが
        // 同じ機構で listener を貼り直して追従する。
        if (next !== null && Math.abs(video.currentTime - next) > seekThreshold) {
          try {
            video.currentTime = next;
          } catch {
            /* seek best-effort */
          }
        }
      };
      video.addEventListener("seeked", onSeeked, { once: true });
    }
    scrubSeekState.set(video, state);
    return;
  }
  try {
    video.currentTime = scrubTo;
  } catch {
    /* seek best-effort */
  }
}
