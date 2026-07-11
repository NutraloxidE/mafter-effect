/**
 * §16.2 プランv2 §2.2 — packed alpha（color の直下に grayscale mask を上下パックした 1 本の
 * 動画）再生用 canvas 合成。split alpha（videoSplitAlpha.ts）と異なり `<video>` は 1 本だけで、
 * companion / genlock / holdTimeline の companion 除外機構は一切不要（1 クロックなので不発）。
 */

import type { PackedAlphaLayout } from "./videoAlphaGl";
import {
  dispatchAlphaComposite,
  ensureUsableAlphaCanvas,
  getGlAlphaCompositor,
  releaseGlAlphaCompositor,
} from "./videoAlphaGl";
import { applyGrayscaleMaskToAlphaChannel } from "./videoSplitAlpha";

export type { PackedAlphaLayout };

/** §2.2 — encode/decode で共有する境界ガター（クロマにじみ防止）。 */
export const PACKED_ALPHA_GUTTER_PX = 8;

export const PACKED_ALPHA_CANVAS_CLASS = "mafter-packed-alpha-canvas";
export const PACKED_ALPHA_MASK_SCRATCH_CLASS = "mafter-packed-alpha-mask-scratch";

export interface PackedAlphaCompanion {
  canvas: HTMLCanvasElement;
  maskScratch: HTMLCanvasElement;
}

/** packed 動画の総高さ（`2*contentHeight + gutterPx`、§2.2）。 */
export function packedVideoHeight(contentHeight: number, gutterPx: number): number {
  return contentHeight * 2 + gutterPx;
}

export interface PackedAlphaRect {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

/**
 * packed 動画内の color / mask それぞれの source rect（drawImage の sx/sy/sw/sh）を計算する純関数。
 * gutter 分は除外して sample する（境界のクロマにじみを拾わない）。
 */
export function computePackedAlphaRects(
  contentWidth: number,
  layout: PackedAlphaLayout,
): { color: PackedAlphaRect; mask: PackedAlphaRect } {
  const { contentHeight, gutterPx } = layout;
  return {
    color: { sx: 0, sy: 0, sw: contentWidth, sh: contentHeight },
    mask: { sx: 0, sy: contentHeight + gutterPx, sw: contentWidth, sh: contentHeight },
  };
}

/** packed 動画のアセットが 4096px 高さ制限に収まるか（§2.2 サイズ上限）。 */
export function packedLayoutFitsSizeLimit(layout: PackedAlphaLayout, maxHeight = 4096): boolean {
  return packedVideoHeight(layout.contentHeight, layout.gutterPx) <= maxHeight;
}

/** packed 動画の合成 canvas + mask 用スクラッチ canvas を確保。 */
export function ensurePackedAlphaCompanion(video: HTMLVideoElement): PackedAlphaCompanion {
  const parent = video.parentElement;
  if (!parent) throw new Error("packed alpha: video has no parent");

  let canvas = parent.querySelector(
    `canvas.${PACKED_ALPHA_CANVAS_CLASS}`,
  ) as HTMLCanvasElement | null;
  if (!canvas) {
    canvas = document.createElement("canvas");
    canvas.className = PACKED_ALPHA_CANVAS_CLASS;
    canvas.style.cssText = "position:absolute;top:0;left:0;pointer-events:none";
    parent.appendChild(canvas);
  }
  canvas = ensureUsableAlphaCanvas(canvas, parent, PACKED_ALPHA_CANVAS_CLASS);

  let maskScratch = parent.querySelector(
    `canvas.${PACKED_ALPHA_MASK_SCRATCH_CLASS}`,
  ) as HTMLCanvasElement | null;
  if (!maskScratch) {
    maskScratch = document.createElement("canvas");
    maskScratch.className = PACKED_ALPHA_MASK_SCRATCH_CLASS;
    maskScratch.style.cssText = "position:absolute;width:0;height:0;opacity:0;pointer-events:none";
    parent.appendChild(maskScratch);
  }

  return { canvas, maskScratch };
}

/** packed alpha を使わなくなったレイヤーの canvas を DOM から取り除く前に呼ぶ（GL 予算解放）。 */
export function releasePackedAlphaGlCompositor(canvas: HTMLCanvasElement): void {
  releaseGlAlphaCompositor(canvas);
}

/**
 * CPU フォールバック: packed 動画の色帯・マスク帯を drawImage の source rect で個別に抜き出し、
 * split alpha の `applyGrayscaleMaskToAlphaChannel`（straight alpha）と同じ式で合成する。
 * `drawSplitAlphaComposite` より `getImageData` が 1 回少ない（video 自体は 1 本のため）。
 */
export function drawPackedAlphaComposite(
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement,
  maskScratch: HTMLCanvasElement,
  layout: PackedAlphaLayout,
): boolean {
  if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return false;
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (vw <= 0 || vh <= 0 || layout.contentHeight <= 0) return false;

  const w = vw;
  const h = layout.contentHeight;
  const rects = computePackedAlphaRects(w, layout);

  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  if (maskScratch.width !== w) maskScratch.width = w;
  if (maskScratch.height !== h) maskScratch.height = h;

  const ctx = canvas.getContext("2d");
  const maskCtx = maskScratch.getContext("2d");
  if (!ctx || !maskCtx) return false;

  // 呼び出し側（updateComponentEl → rAF ループ）は draw 呼び出しの外側に try/catch を持たない。
  // getImageData/putImageData は同期例外（例: file:// 経由の video を drawImage した canvas が
  // "tainted" 扱いになる環境での SecurityError）を投げうるが、ここで拾わず投げると rAF ループの
  // tick が己の requestAnimationFrame(tick) 再スケジュールに届く前に中断し、再生が二度と進まない
  // 恒久フリーズになる（schedulePackedAlphaRedrawWhenReady の bounded retry も機能しなくなる）。
  // false を返して「この 1 フレームは合成失敗」として扱えば、既存の再試行経路がそのまま効く。
  try {
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(video, rects.color.sx, rects.color.sy, rects.color.sw, rects.color.sh, 0, 0, w, h);
    const colorData = ctx.getImageData(0, 0, w, h);

    maskCtx.clearRect(0, 0, w, h);
    maskCtx.drawImage(video, rects.mask.sx, rects.mask.sy, rects.mask.sw, rects.mask.sh, 0, 0, w, h);
    const maskData = maskCtx.getImageData(0, 0, w, h);

    applyGrayscaleMaskToAlphaChannel(colorData, maskData);
    ctx.putImageData(colorData, 0, 0);
    return true;
  } catch (err) {
    console.error("drawPackedAlphaComposite: composite failed", err);
    return false;
  }
}

/** drawPackedAlphaComposite と同一契約の薄いラッパ。GL compositor が生きていればシェーダ合成。 */
export function compositePackedAlpha(
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement,
  maskScratch: HTMLCanvasElement,
  layout: PackedAlphaLayout,
): boolean {
  const gl = getGlAlphaCompositor(canvas);
  return dispatchAlphaComposite(
    gl,
    () => gl!.compositePacked(video, layout),
    () => drawPackedAlphaComposite(video, canvas, maskScratch, layout),
  );
}

const pendingRedraws = new WeakSet<HTMLCanvasElement>();

export interface PackedAlphaRedrawOptions {
  deadlineMs?: number;
  now?: () => number;
  raf?: (cb: () => void) => void;
  draw?: (
    video: HTMLVideoElement,
    canvas: HTMLCanvasElement,
    maskScratch: HTMLCanvasElement,
    layout: PackedAlphaLayout,
  ) => boolean;
}

/**
 * split alpha の `scheduleSplitAlphaRedrawWhenReady` と同型のリトライ（scrub 直後の
 * decode-in-progress 対策）。packed は draw シグネチャが異なるため個別に持つ。
 */
export function schedulePackedAlphaRedrawWhenReady(
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement,
  maskScratch: HTMLCanvasElement,
  layout: PackedAlphaLayout,
  options?: PackedAlphaRedrawOptions,
): void {
  if (pendingRedraws.has(canvas)) return;
  pendingRedraws.add(canvas);
  const now = options?.now ?? (() => performance.now());
  const raf = options?.raf ?? ((cb: () => void) => { requestAnimationFrame(cb); });
  const draw = options?.draw ?? compositePackedAlpha;
  const deadline = now() + (options?.deadlineMs ?? 2000);
  const tick = (): void => {
    if (!canvas.isConnected) {
      pendingRedraws.delete(canvas);
      return;
    }
    if (draw(video, canvas, maskScratch, layout) || now() > deadline) {
      pendingRedraws.delete(canvas);
      return;
    }
    raf(tick);
  };
  raf(tick);
}

/** packed alpha 表示 ON/OFF（video / canvas の visibility）。split の setSplitAlphaPresentation と同型。 */
export function setPackedAlphaPresentation(
  video: HTMLVideoElement,
  companion: PackedAlphaCompanion,
  enabled: boolean,
  displayWidth: number,
  displayHeight: number,
): void {
  if (enabled) {
    video.style.opacity = "0";
    video.style.pointerEvents = "none";
    companion.canvas.style.display = "block";
    companion.canvas.style.width = `${displayWidth}px`;
    companion.canvas.style.height = `${displayHeight}px`;
  } else {
    video.style.opacity = "";
    video.style.pointerEvents = "none";
    companion.canvas.style.display = "none";
  }
}

/** packed alpha 合成 canvas が存在するか（export inline 判定用、split の hasSplitAlphaCanvas と同型）。 */
export function hasPackedAlphaCanvas(host: ParentNode): boolean {
  return host.querySelector(`canvas.${PACKED_ALPHA_CANVAS_CLASS}`) !== null;
}
