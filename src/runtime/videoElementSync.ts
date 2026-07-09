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
 * seek / decode の完了を待つ（currentTime が target に乗り data が揃うまで）。
 * present（rVFC）待ちはしない。export の present 待ちと preview warm-up が共有する step 1。
 * 戻り値: deadline 内に readyState >= HAVE_CURRENT_DATA && videoWidth > 0 に達したか。
 */
async function waitVideoDataReady(video: HTMLVideoElement, deadline: number): Promise<boolean> {
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
    return true;
  }
  return video.readyState >= HAVE_CURRENT_DATA && video.videoWidth > 0;
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
  await waitVideoDataReady(video, deadline);

  // 2. target フレームが compositor に present されるまで待つ（drawImage が新フレームを得る）。
  const presentBudget = Math.min(PRESENT_WAIT_MS, Math.max(0, deadline - performance.now()));
  await waitPresentedFrame(video, targetSec, fps, presentBudget);
}

const DEFAULT_PRIME_TIMEOUT_MS = 800;

/**
 * preview warm-up（§11.4）: target 時刻へ scrub 同型 seek し、loadeddata（decode 済みフレーム）
 * まで待つ。rVFC present 待ちはしない＝再生開始を遅らせない。export の決定論 seek（exportStep +
 * waitForVideoFrame）は一切経由しない（INV-2 非干渉）。
 * 成功 = deadline 内に readyState >= HAVE_CURRENT_DATA && videoWidth > 0。失敗は best-effort。
 */
export async function primeVideoElement(
  video: HTMLVideoElement,
  targetSec: number,
  fps: number,
  timeoutMs = DEFAULT_PRIME_TIMEOUT_MS,
): Promise<boolean> {
  if (!Number.isFinite(targetSec) || targetSec < 0) return false;
  const deadline = performance.now() + Math.max(0, timeoutMs);
  // 既に data 揃いなら syncVideoElementTime は半フレーム以内で再 seek せず即返る。
  syncVideoElementTime(video, targetSec, fps, { playbackMode: false });
  return waitVideoDataReady(video, deadline);
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
  /**
   * true = このフレームでカット境界を跨いだ（entry の子要素を作り直した／プールから
   * 別クリップ用に再取得した）。再生中の resync 判定を緩い PLAYBACK_RESYNC_THRESHOLD_SEC
   * ではなく半フレーム精度で行い、trim-in が前クリップの停止位置とわずかにズレる
   * ケースで seek が抜けるのを防ぐ（真に連続するカットは半フレーム以内なら無音継続を維持）。
   */
  forceSeek?: boolean;
  /**
   * true = 映像がタイムラインより先行しているので pause して待つ（seek しない）。
   * playbackMode 中のみ意味を持つ。旧 HW seek 連鎖を避けつつ双方向同期する。
   */
  pauseForSync?: boolean;
  playbackRateForSync?: number;
  /**
   * §11.7 bundle: true の間は playbackMode 中でも unmute しない（muted のまま再生を進める）。
   * ページロード直後（ユーザー操作前）の unmute 付き play() はブラウザの autoplay ポリシーで
   * 拒否され currentTime が進まなくなる（=映像だけフリーズ）。ジェスチャー前は muted のまま
   * ネイティブ再生を進め、初回ジェスチャーのコールスタック内で unmute する側で解除する。
   * editor preview は Play 自体がユーザー操作なので常に false のまま無関係。
   */
  forceMuted?: boolean;
}

function setVideoPlaybackRate(video: HTMLVideoElement, rate: number): void {
  const next = Number.isFinite(rate) ? Math.max(0.96, Math.min(1.04, rate)) : 1;
  if (Math.abs(video.playbackRate - next) <= 0.001) return;
  try {
    video.playbackRate = next;
  } catch {
    /* playbackRate best-effort */
  }
}

/** 半フレーム未満の差は無視（scrub/export の過剰 seek 抑制）。 */
export function videoSeekThresholdSec(fps: number): number {
  return 0.5 / Math.max(1, fps);
}

/**
 * カット境界（要素プール再取得）でのソース読み出し位置の連続性判定。
 * 「ct と target の差」で seek 要否を決めると、通常の再生 decode lag（数フレーム）が
 * 半フレーム閾値を常に超え、真に連続するシームレス境界でも毎回 seek が発火して
 * プール再利用が保っている映像・内蔵音声の連続（§11.4）を壊す。
 * そこで target の軌道どうしを比較する: 前フレームの target（前クリップの最終描画時刻）
 * から経過フレームぶん進めた時刻と新クリップの target が半フレーム以内なら
 * 「真に連続するカット」= seek 不要。trim-in がずれている場合だけ seek させる。
 * prev が無い（新規要素・warm-up 投入のみ）や逆行は連続と見なさない（安全側 = seek 判定へ）。
 */
export function isSourceContinuousAcrossCut(
  prevTargetSec: number | undefined,
  prevTargetFrame: number | undefined,
  targetSec: number,
  frame: number,
  fps: number,
): boolean {
  if (
    prevTargetSec === undefined ||
    prevTargetFrame === undefined ||
    !Number.isFinite(prevTargetSec) ||
    !Number.isFinite(prevTargetFrame)
  ) {
    return false;
  }
  const framesAdvanced = frame - prevTargetFrame;
  if (framesAdvanced < 0) return false;
  const expected = prevTargetSec + framesAdvanced / Math.max(1, fps);
  return Math.abs(targetSec - expected) <= videoSeekThresholdSec(fps);
}

/**
 * 再生中はネイティブ play() に任せ、本当の不連続（ループ復帰・大ジャンプ）でのみ再同期する閾値。
 * 小さな decode lag drift で毎フレーム seek すると、旧 HW（例: Ivy Bridge / HD 4000）では
 * seek 後の present 復帰が遅く、また遅れて seek… と自己増殖の seek ループ＝映像 plane の
 * ガクつきになる。閾値を大きくして decode lag の追従は play() に委ね、seek 連鎖を断つ。
 */
export const PLAYBACK_RESYNC_THRESHOLD_SEC = 0.5; // ≈15 frames @30fps

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
  setVideoPlaybackRate(video, 1);
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
    setVideoPlaybackRate(video, 1);
    syncVideoElementExportStep(video, targetSec, fps);
    return;
  }

  const seekThreshold = videoSeekThresholdSec(fps);

  if (options.playbackMode) {
    setVideoPlaybackRate(video, options.playbackRateForSync ?? 1);
    // §11.4 video 内蔵音声: 再生中のみアンミュートしてネイティブ A/V 同期に委ねる。
    // §11.7 forceMuted 中は autoplay ポリシー回避のため unmute を保留する。
    try {
      video.muted = options.forceMuted ? true : false;
    } catch {
      /* muted best-effort */
    }
    // 映像先行ゲート: pause のみ（seek しない＝旧 HW スタッタ対策 A を維持）。
    if (options.pauseForSync) {
      setVideoPlaybackRate(video, 1);
      if (!video.paused) {
        try {
          video.pause();
        } catch {
          /* pause best-effort */
        }
      }
      return;
    }
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
    // 再生中は drift 矯正 seek をしない。本当の不連続（ループ復帰・大ジャンプ）でのみ
    // 再同期し、通常の decode lag drift はネイティブ play() の追従に任せる（旧 HW の
    // 自己増殖 seek ループ＝映像ガクつきを断つ）。
    // forceSeek（カット境界でプールから再取得した直後）は緩い閾値だと trim-in のズレを
    // 見逃すため、半フレーム精度で判定する。
    const resyncThreshold = options.forceSeek ? seekThreshold : PLAYBACK_RESYNC_THRESHOLD_SEC;
    if (Math.abs(video.currentTime - targetSec) > resyncThreshold) {
      try {
        video.currentTime = targetSec;
      } catch {
        /* seek best-effort */
      }
    }
    return;
  }

  setVideoPlaybackRate(video, 1);
  // §11.4 video 内蔵音声: スクラブ・停止・warm-up は決定論のため常にミュート。
  try {
    video.muted = true;
  } catch {
    /* muted best-effort */
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
