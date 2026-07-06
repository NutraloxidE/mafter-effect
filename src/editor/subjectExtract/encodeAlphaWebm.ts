import { Muxer as WebmMuxer, ArrayBufferTarget } from "webm-muxer";
import { clampVideoBitrate, DEFAULT_VIDEO_BITRATE } from "../../runtime/exportVideoEncode";

export interface RgbaFrame {
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
}

export type SubjectWebmEncodeResult =
  | { mode: "unified"; webm: Uint8Array }
  | { mode: "split"; colorWebm: Uint8Array; alphaWebm: Uint8Array };

function evenDim(n: number): number {
  const v = Math.max(2, Math.round(n));
  return v % 2 === 0 ? v : v + 1;
}

function nextTick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

export function toOpaqueRgbColor(rgba: Uint8ClampedArray): Uint8ClampedArray {
  const out = new Uint8ClampedArray(rgba.length);
  for (let i = 0; i < rgba.length; i += 4) {
    out[i] = rgba[i]!;
    out[i + 1] = rgba[i + 1]!;
    out[i + 2] = rgba[i + 2]!;
    out[i + 3] = 255;
  }
  return out;
}

export function toGrayscaleAlpha(rgba: Uint8ClampedArray): Uint8ClampedArray {
  const out = new Uint8ClampedArray(rgba.length);
  for (let i = 0; i < rgba.length; i += 4) {
    const g = rgba[i + 3]!;
    out[i] = g;
    out[i + 1] = g;
    out[i + 2] = g;
    out[i + 3] = 255;
  }
  return out;
}

async function configureVideoEncoder(
  encoder: VideoEncoder,
  base: VideoEncoderConfig,
): Promise<void> {
  const prefs: (HardwareAcceleration | undefined)[] = [
    "prefer-hardware",
    undefined,
    "prefer-software",
  ];
  for (const accel of prefs) {
    const cfg: VideoEncoderConfig = accel ? { ...base, hardwareAcceleration: accel } : { ...base };
    try {
      const support = await VideoEncoder.isConfigSupported(cfg);
      if (support.supported) {
        encoder.configure(support.config ?? cfg);
        return;
      }
    } catch {
      /* try next */
    }
  }
  throw new Error(`No supported VideoEncoder config for ${base.codec} at ${base.width}x${base.height}`);
}

async function backpressureEncoderQueue(encoder: VideoEncoder): Promise<void> {
  while (encoder.encodeQueueSize > 4) {
    await nextTick();
  }
}

/** VP9 + alpha:keep が使えるか（Firefox 等）。Chrome は通常 false。 */
export async function isVp9AlphaEncodeSupported(
  width: number,
  height: number,
  fps: number,
): Promise<boolean> {
  if (typeof VideoEncoder === "undefined") return false;
  const w = evenDim(width);
  const h = evenDim(height);
  try {
    const support = await VideoEncoder.isConfigSupported({
      codec: "vp09.00.10.08",
      width: w,
      height: h,
      bitrate: clampVideoBitrate(DEFAULT_VIDEO_BITRATE),
      framerate: fps,
      alpha: "keep",
    });
    return support.supported === true;
  } catch {
    return false;
  }
}

async function encodeRgbaFramesToVp9Webm(
  frames: RgbaFrame[],
  fps: number,
  opts: { alphaKeep: boolean; muxAlpha: boolean },
  onProgress?: (current: number, total: number) => void,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  if (frames.length === 0) throw new Error("no frames to encode");

  const srcW = frames[0]!.width;
  const srcH = frames[0]!.height;
  const w = evenDim(srcW);
  const h = evenDim(srcH);

  const target = new ArrayBufferTarget();
  const muxer = new WebmMuxer({
    target,
    video: { codec: "V_VP9", width: w, height: h, frameRate: fps, alpha: opts.muxAlpha },
  });

  let encodeError: Error | null = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta ?? undefined),
    error: (e) => {
      encodeError = e instanceof Error ? e : new Error(String(e));
    },
  });

  const bitrate = clampVideoBitrate(DEFAULT_VIDEO_BITRATE);
  const baseConfig: VideoEncoderConfig = {
    codec: "vp09.00.10.08",
    width: w,
    height: h,
    bitrate,
    framerate: fps,
  };
  if (opts.alphaKeep) {
    baseConfig.alpha = "keep";
  }
  await configureVideoEncoder(encoder, baseConfig);

  const usDuration = Math.round(1_000_000 / fps);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("canvas 2d unavailable");

  try {
    for (let i = 0; i < frames.length; i++) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      if (encodeError) throw encodeError;
      const f = frames[i]!;
      const copy = new Uint8ClampedArray(f.rgba);
      const img = new ImageData(copy, f.width, f.height);
      ctx.clearRect(0, 0, w, h);
      if (f.width === w && f.height === h) {
        ctx.putImageData(img, 0, 0);
      } else {
        const tmp = document.createElement("canvas");
        tmp.width = f.width;
        tmp.height = f.height;
        tmp.getContext("2d")!.putImageData(img, 0, 0);
        ctx.drawImage(tmp, 0, 0, w, h);
      }
      const bitmap = await createImageBitmap(canvas);
      const vf = new VideoFrame(bitmap, {
        timestamp: i * usDuration,
        duration: usDuration,
      });
      encoder.encode(vf, { keyFrame: i === 0 || i % 30 === 0 });
      vf.close();
      bitmap.close();
      await backpressureEncoderQueue(encoder);
      onProgress?.(i + 1, frames.length);
    }
    await encoder.flush();
    if (encodeError) throw encodeError;
    muxer.finalize();
    if (!target.buffer) throw new Error("muxer produced no output");
    return new Uint8Array(target.buffer);
  } finally {
    if (encoder.state !== "closed") {
      try {
        encoder.close();
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * Subject Extract 用 WebM 生成。
 * alpha:keep 非対応環境（Chrome 等）では color + alpha の 2 本 WebM に分割（§16.2）。
 */
export async function encodeRgbaFramesToSubjectWebm(
  frames: RgbaFrame[],
  fps: number,
  onProgress?: (current: number, total: number) => void,
  signal?: AbortSignal,
): Promise<SubjectWebmEncodeResult> {
  if (frames.length === 0) throw new Error("no frames to encode");
  if (typeof VideoEncoder === "undefined") {
    throw new Error("WebCodecs VideoEncoder unavailable");
  }

  const w = frames[0]!.width;
  const h = frames[0]!.height;
  const unifiedOk = await isVp9AlphaEncodeSupported(w, h, fps);

  if (unifiedOk) {
    const webm = await encodeRgbaFramesToVp9Webm(
      frames,
      fps,
      { alphaKeep: true, muxAlpha: true },
      onProgress,
      signal,
    );
    return { mode: "unified", webm };
  }

  const colorFrames: RgbaFrame[] = frames.map((f) => ({
    width: f.width,
    height: f.height,
    rgba: toOpaqueRgbColor(f.rgba),
  }));
  const alphaFrames: RgbaFrame[] = frames.map((f) => ({
    width: f.width,
    height: f.height,
    rgba: toGrayscaleAlpha(f.rgba),
  }));

  const totalSteps = frames.length * 2;
  let done = 0;
  const bump = () => {
    done++;
    onProgress?.(done, totalSteps);
  };

  const colorWebm = await encodeRgbaFramesToVp9Webm(
    colorFrames,
    fps,
    { alphaKeep: false, muxAlpha: false },
    () => bump(),
    signal,
  );
  const alphaWebm = await encodeRgbaFramesToVp9Webm(
    alphaFrames,
    fps,
    { alphaKeep: false, muxAlpha: false },
    () => bump(),
    signal,
  );

  return { mode: "split", colorWebm, alphaWebm };
}

/** @deprecated encodeRgbaFramesToSubjectWebm を使う。 */
export async function encodeRgbaFramesToAlphaWebm(
  frames: RgbaFrame[],
  fps: number,
  onProgress?: (current: number, total: number) => void,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const result = await encodeRgbaFramesToSubjectWebm(frames, fps, onProgress, signal);
  if (result.mode === "unified") return result.webm;
  return result.colorWebm;
}
