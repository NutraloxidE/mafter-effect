/** §16.2 — split alpha 再生用 canvas 合成（color × alpha マスク WebM）。 */

import { PLAYBACK_RESYNC_THRESHOLD_SEC } from "./videoElementSync";

export const SPLIT_ALPHA_VIDEO_CLASS = "mafter-split-alpha";
export const SPLIT_ALPHA_CANVAS_CLASS = "mafter-split-alpha-canvas";
export const SPLIT_ALPHA_MASK_SCRATCH_CLASS = "mafter-split-alpha-mask-scratch";

export interface SplitAlphaCompanion {
  alphaVideo: HTMLVideoElement;
  canvas: HTMLCanvasElement;
  maskScratch: HTMLCanvasElement;
}

/** color `<video>` の兄弟 alpha video（split alpha 時）。 */
export function findSplitAlphaVideo(colorVideo: HTMLVideoElement): HTMLVideoElement | null {
  const parent = colorVideo.parentElement;
  if (!parent) return null;
  return parent.querySelector(`video.${SPLIT_ALPHA_VIDEO_CLASS}`) as HTMLVideoElement | null;
}

/** split alpha 合成 canvas が存在するか（export inline 判定用）。 */
export function hasSplitAlphaCanvas(host: ParentNode): boolean {
  return host.querySelector(`canvas.${SPLIT_ALPHA_CANVAS_CLASS}`) !== null;
}

/** color `<video>` の兄弟として alpha video + composite canvas を確保。 */
export function ensureSplitAlphaCompanion(colorVideo: HTMLVideoElement): SplitAlphaCompanion {
  const parent = colorVideo.parentElement;
  if (!parent) throw new Error("split alpha: video has no parent");

  let alphaVideo = parent.querySelector(
    `video.${SPLIT_ALPHA_VIDEO_CLASS}`,
  ) as HTMLVideoElement | null;
  if (!alphaVideo) {
    alphaVideo = document.createElement("video");
    alphaVideo.className = SPLIT_ALPHA_VIDEO_CLASS;
    alphaVideo.muted = true;
    alphaVideo.playsInline = true;
    alphaVideo.preload = "auto";
    alphaVideo.controls = false;
    alphaVideo.style.cssText = "position:absolute;width:0;height:0;opacity:0;pointer-events:none";
    parent.appendChild(alphaVideo);
  }

  let canvas = parent.querySelector(
    `canvas.${SPLIT_ALPHA_CANVAS_CLASS}`,
  ) as HTMLCanvasElement | null;
  if (!canvas) {
    canvas = document.createElement("canvas");
    canvas.className = SPLIT_ALPHA_CANVAS_CLASS;
    canvas.style.cssText = "position:absolute;top:0;left:0;pointer-events:none";
    parent.appendChild(canvas);
  }

  let maskScratch = parent.querySelector(
    `canvas.${SPLIT_ALPHA_MASK_SCRATCH_CLASS}`,
  ) as HTMLCanvasElement | null;
  if (!maskScratch) {
    maskScratch = document.createElement("canvas");
    maskScratch.className = SPLIT_ALPHA_MASK_SCRATCH_CLASS;
    maskScratch.style.cssText = "position:absolute;width:0;height:0;opacity:0;pointer-events:none";
    parent.appendChild(maskScratch);
  }

  return { alphaVideo, canvas, maskScratch };
}

/** color video の dataset / sync 状態を alpha video へミラー。 */
export function mirrorSplitAlphaVideoState(
  colorVideo: HTMLVideoElement,
  alphaVideo: HTMLVideoElement,
): void {
  for (const key of [
    "mafterTargetSec",
    "mafterTargetFrame",
    "mafterVideoAsset",
  ] as const) {
    const v = colorVideo.dataset[key];
    if (v !== undefined) alphaVideo.dataset[key] = v;
    else delete alphaVideo.dataset[key];
  }
  const exportT = colorVideo.getAttribute("data-mafter-export-target-sec");
  if (exportT !== null) {
    alphaVideo.setAttribute("data-mafter-export-target-sec", exportT);
  } else {
    alphaVideo.removeAttribute("data-mafter-export-target-sec");
  }
}

/**
 * split alpha マスク（グレースケール RGB の R）を color ImageData の alpha に適用。
 * VP9 discard-alpha エンコードではマスクは RGB にのみ載るため destination-in は使えない。
 */
export function applyGrayscaleMaskToAlphaChannel(color: ImageData, mask: ImageData): void {
  const cd = color.data;
  const md = mask.data;
  if (cd.length !== md.length) {
    throw new Error("applyGrayscaleMaskToAlphaChannel: dimension mismatch");
  }
  for (let i = 0; i < cd.length; i += 4) {
    cd[i + 3] = md[i]!;
  }
}

/**
 * alpha 側はグレースケール（R=G=B=マスク）。color の RGB にマスク R を alpha として合成。
 * 両 video が ready なときのみ描画。成功時 true。
 */
export function drawSplitAlphaComposite(
  colorVideo: HTMLVideoElement,
  alphaVideo: HTMLVideoElement,
  canvas: HTMLCanvasElement,
  maskScratch: HTMLCanvasElement,
): boolean {
  const w = colorVideo.videoWidth;
  const h = colorVideo.videoHeight;
  if (w <= 0 || h <= 0) return false;
  if (alphaVideo.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return false;
  if (colorVideo.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return false;

  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  if (maskScratch.width !== w) maskScratch.width = w;
  if (maskScratch.height !== h) maskScratch.height = h;

  const ctx = canvas.getContext("2d");
  const maskCtx = maskScratch.getContext("2d");
  if (!ctx || !maskCtx) return false;

  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(colorVideo, 0, 0, w, h);
  const colorData = ctx.getImageData(0, 0, w, h);

  maskCtx.clearRect(0, 0, w, h);
  maskCtx.drawImage(alphaVideo, 0, 0, w, h);
  const maskData = maskCtx.getImageData(0, 0, w, h);

  applyGrayscaleMaskToAlphaChannel(colorData, maskData);
  ctx.putImageData(colorData, 0, 0);
  return true;
}

const pendingRedraws = new WeakSet<HTMLCanvasElement>();

export interface SplitAlphaRedrawOptions {
  /** 打ち切りまでの秒数（既定 2000ms）。dispose 漏れの無限ループ防止。 */
  deadlineMs?: number;
  now?: () => number;
  raf?: (cb: () => void) => void;
  draw?: (
    colorVideo: HTMLVideoElement,
    alphaVideo: HTMLVideoElement,
    canvas: HTMLCanvasElement,
    maskScratch: HTMLCanvasElement,
  ) => boolean;
}

/**
 * §16.2 split alpha — `drawSplitAlphaComposite` が readyState 不足で false を返したとき、
 * 両 video が ready になり次第 1 回だけ再描画する。通常の `<video>` はブラウザが decode
 * 完了時に自動再描画するが、canvas 合成は明示呼び出しでしか更新されないため、スクラブ直後の
 * render pass が seek/decode 中に当たると canvas が古い内容のまま固定される（次に render() が
 * 呼ばれるまで）。bounded retry（既定 2000ms）+ `canvas.isConnected` チェックで、要素が
 * dispose された後に無限ループしないようにする。同一 canvas への多重スケジュールは無視する。
 */
export function scheduleSplitAlphaRedrawWhenReady(
  colorVideo: HTMLVideoElement,
  alphaVideo: HTMLVideoElement,
  canvas: HTMLCanvasElement,
  maskScratch: HTMLCanvasElement,
  options?: SplitAlphaRedrawOptions,
): void {
  if (pendingRedraws.has(canvas)) return;
  pendingRedraws.add(canvas);
  const now = options?.now ?? (() => performance.now());
  const raf = options?.raf ?? ((cb: () => void) => { requestAnimationFrame(cb); });
  const draw = options?.draw ?? drawSplitAlphaComposite;
  const deadline = now() + (options?.deadlineMs ?? 2000);
  const tick = (): void => {
    if (!canvas.isConnected) {
      pendingRedraws.delete(canvas);
      return;
    }
    if (draw(colorVideo, alphaVideo, canvas, maskScratch) || now() > deadline) {
      pendingRedraws.delete(canvas);
      return;
    }
    raf(tick);
  };
  raf(tick);
}

/** split alpha 表示 ON/OFF（color video / canvas の visibility）。 */
export function setSplitAlphaPresentation(
  colorVideo: HTMLVideoElement,
  companion: SplitAlphaCompanion,
  enabled: boolean,
  displayWidth: number,
  displayHeight: number,
): void {
  if (enabled) {
    colorVideo.style.opacity = "0";
    colorVideo.style.pointerEvents = "none";
    companion.canvas.style.display = "block";
    companion.canvas.style.width = `${displayWidth}px`;
    companion.canvas.style.height = `${displayHeight}px`;
    companion.alphaVideo.style.display = "block";
  } else {
    colorVideo.style.opacity = "";
    colorVideo.style.pointerEvents = "none";
    companion.canvas.style.display = "none";
    companion.alphaVideo.style.display = "none";
    if (companion.alphaVideo.getAttribute("src")) {
      companion.alphaVideo.removeAttribute("src");
      companion.alphaVideo.load();
    }
  }
}

/**
 * §16.2 — color/alpha フレーム対応の genlock（実測: 実機 Playwright 検証で companion ドリフトは
 * 平均33〜50ms・最大147ms 程度と判明。0.5s のハードシーク閾値には遠く届かないため無補正のまま
 * 蓄積していた）。誤差レベル未満は補正せず、大ドリフトは呼び出し側でハードシークに委ねる帯域だけ
 * playbackRate を穏やかに調整する（seek を伴わないため decode 再開コストが発生しない）。
 */
const ALPHA_GENLOCK_MIN_DRIFT_SEC = 0.03;
/** ハードシークにフォールバックする閾値。videoElementSync の再生中 resync 閾値と揃える。 */
const ALPHA_GENLOCK_MAX_DRIFT_SEC = PLAYBACK_RESYNC_THRESHOLD_SEC;
const ALPHA_GENLOCK_MAX_RATE_ADJUST = 0.08; // ±8%
const ALPHA_GENLOCK_RATE_GAIN = 0.3;

/**
 * drift（color.currentTime − alpha.currentTime）から alpha に適用すべき playbackRate を返す。
 * drift > 0（alpha が遅れている）→ rate > 1（速める）。誤差帯・大ドリフト帯は 1（補正なし）。
 */
export function computeAlphaGenlockRate(driftSec: number): number {
  const abs = Math.abs(driftSec);
  if (abs < ALPHA_GENLOCK_MIN_DRIFT_SEC || abs > ALPHA_GENLOCK_MAX_DRIFT_SEC) return 1;
  const adjust = Math.max(
    -ALPHA_GENLOCK_MAX_RATE_ADJUST,
    Math.min(ALPHA_GENLOCK_MAX_RATE_ADJUST, driftSec * ALPHA_GENLOCK_RATE_GAIN),
  );
  return 1 + adjust;
}

/**
 * 再生中の color/alpha フレーム対応を playbackRate の微調整で徐々に揃える（seek しない）。
 * 大ドリフト（閾値超）のみハードシークにフォールバックする。呼び出し側は定常再生中
 * （playbackMode かつ pause/cut/scrub/export のいずれでもない）のときだけ呼ぶこと。
 */
export function applyAlphaGenlock(colorVideo: HTMLVideoElement, alphaVideo: HTMLVideoElement): void {
  const drift = colorVideo.currentTime - alphaVideo.currentTime;
  if (Math.abs(drift) > ALPHA_GENLOCK_MAX_DRIFT_SEC) {
    try {
      alphaVideo.currentTime = colorVideo.currentTime;
      alphaVideo.playbackRate = 1;
    } catch {
      /* seek best-effort */
    }
    return;
  }
  try {
    alphaVideo.playbackRate = computeAlphaGenlockRate(drift);
  } catch {
    /* playbackRate best-effort */
  }
}

/** genlock 対象外のとき呼ぶ（scrub/export/pause/cut境界）。playbackRate を既定に戻す。 */
export function resetAlphaGenlockRate(alphaVideo: HTMLVideoElement): void {
  if (alphaVideo.playbackRate !== 1) {
    try {
      alphaVideo.playbackRate = 1;
    } catch {
      /* best-effort */
    }
  }
}
