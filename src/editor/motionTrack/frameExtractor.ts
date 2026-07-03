import type { Frame, Project, SceneObject } from "../../core/schema";
import type { FileSystem } from "../../fs/FileSystem";
import { videoSeekTargetSec, waitForVideoFrame } from "../../runtime/videoElementSync";
import { ImageAssetCache } from "../../runtime/imageAssetCache";
import { applyRoiMask, type TrackRoi } from "./trackRoi";

export const MOTION_TRACK_TARGET_WIDTH = 640;

export interface ExtractedFrame {
  compFrame: Frame;
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
}

export interface FrameExtractOptions {
  videoUrl: string;
  fps: number;
  inPoint: Frame;
  trimStart: Frame;
  compFrames: Frame[];
  targetWidth?: number;
  /** 追跡範囲。ダウンサンプル後に ROI 外を黒塗り（画像サイズ不変）。 */
  roi?: TrackRoi;
  onProgress?: (current: number, total: number) => void;
  signal?: AbortSignal;
}

function readTrimStart(videoLayer: SceneObject): Frame {
  const vc = videoLayer.components.find((c) => c.type === "video");
  const raw = vc?.props["trimStart"];
  if (typeof raw === "number") return raw;
  return 0;
}

/** レイヤー in/out とソース尺の交差範囲で comp 絶対フレーム列を生成。 */
export function computeMotionTrackCompFrames(
  videoLayer: SceneObject,
  compFps: number,
  assetDurationSec: number | undefined,
  sampleInterval: number,
): Frame[] {
  const trimStart = readTrimStart(videoLayer);
  const inPoint = videoLayer.inPoint;
  const outPoint = videoLayer.outPoint;
  const assetFrames =
    assetDurationSec !== undefined && Number.isFinite(assetDurationSec)
      ? Math.floor(assetDurationSec * compFps)
      : undefined;

  const frames: Frame[] = [];
  for (let f = inPoint; f < outPoint; f += Math.max(1, sampleInterval)) {
    const sourceFrame = f - inPoint + trimStart;
    if (sourceFrame < 0) continue;
    if (assetFrames !== undefined && sourceFrame >= assetFrames) continue;
    frames.push(f);
  }
  return frames;
}

function downsampleDimensions(srcW: number, srcH: number, targetWidth: number): { w: number; h: number } {
  if (srcW <= 0 || srcH <= 0) return { w: targetWidth, h: Math.round(targetWidth * 0.75) };
  const scale = targetWidth / srcW;
  return { w: targetWidth, h: Math.max(1, Math.round(srcH * scale)) };
}

/**
 * hidden video + seek + canvas → ImageData（640 幅目安へダウンサンプル）。
 * ROI 指定時はダウンサンプル後に矩形外を黒塗り（mask）。画像サイズは変えない。
 */
export async function extractFramesForMotionTrack(
  opts: FrameExtractOptions,
): Promise<ExtractedFrame[]> {
  const targetWidth = opts.targetWidth ?? MOTION_TRACK_TARGET_WIDTH;
  const roi = opts.roi;
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.crossOrigin = "anonymous";
  video.style.cssText = "position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;opacity:0;pointer-events:none;";
  document.body.appendChild(video);
  video.src = opts.videoUrl;

  await new Promise<void>((resolve, reject) => {
    const onReady = () => {
      video.removeEventListener("loadeddata", onReady);
      video.removeEventListener("error", onErr);
      resolve();
    };
    const onErr = () => {
      video.removeEventListener("loadeddata", onReady);
      video.removeEventListener("error", onErr);
      reject(new Error("video load failed"));
    };
    video.addEventListener("loadeddata", onReady);
    video.addEventListener("error", onErr);
    video.load();
  });

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) {
    video.remove();
    throw new Error("2d context unavailable");
  }

  const { w, h } = downsampleDimensions(video.videoWidth, video.videoHeight, targetWidth);
  canvas.width = w;
  canvas.height = h;

  const out: ExtractedFrame[] = [];
  const total = opts.compFrames.length;

  try {
    for (let i = 0; i < opts.compFrames.length; i++) {
      if (opts.signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const compFrame = opts.compFrames[i]!;
      const sourceFrame = compFrame - opts.inPoint + opts.trimStart;
      const sourceSec = sourceFrame / opts.fps;
      const seekSec = videoSeekTargetSec(sourceSec, opts.fps);
      video.pause();
      try {
        video.currentTime = seekSec;
      } catch {
        /* best-effort */
      }
      await waitForVideoFrame(video, seekSec);
      ctx.drawImage(video, 0, 0, w, h);
      const imageData = ctx.getImageData(0, 0, w, h);
      const rgba = applyRoiMask(new Uint8ClampedArray(imageData.data), w, h, roi);
      out.push({
        compFrame,
        width: w,
        height: h,
        rgba,
      });
      opts.onProgress?.(i + 1, total);
    }
  } finally {
    video.pause();
    video.removeAttribute("src");
    video.load();
    video.remove();
  }

  return out;
}

export async function resolveVideoAssetUrl(
  project: Project,
  assetId: string,
  fs: FileSystem,
  cache?: ImageAssetCache,
): Promise<string | null> {
  const owned = cache ?? new ImageAssetCache();
  if (!cache) {
    await owned.loadFromProject(project, fs);
  }
  return owned.getUrl(assetId);
}
