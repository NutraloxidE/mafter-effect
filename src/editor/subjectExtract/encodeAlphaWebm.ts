import { Muxer as WebmMuxer, ArrayBufferTarget } from "webm-muxer";
import { Muxer as Mp4Muxer, ArrayBufferTarget as Mp4Target } from "mp4-muxer";
import { clampVideoBitrate, DEFAULT_VIDEO_BITRATE } from "../../runtime/exportVideoEncode";
import {
  avcCodecString,
  configureVideoEncoder,
  encodeAudioToMuxer,
  type AudioMixResult,
} from "../../runtime/exporter";
import {
  packedLayoutFitsSizeLimit,
  packedVideoHeight,
  PACKED_ALPHA_GUTTER_PX,
  type PackedAlphaLayout,
} from "../../runtime/videoPackedAlpha";

export interface RgbaFrame {
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
}

export type SubjectWebmEncodeResult =
  | { mode: "unified"; webm: Uint8Array }
  | { mode: "split"; colorWebm: Uint8Array; alphaWebm: Uint8Array }
  | { mode: "packed"; bytes: Uint8Array; container: "mp4" | "webm"; layout: PackedAlphaLayout };

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

/** packed 用 H.264/mp4 の isConfigSupported チェック（サポートされなければ VP9/webm にフォールバック）。 */
async function isPackedH264Supported(w: number, h: number, fps: number): Promise<boolean> {
  if (typeof VideoEncoder === "undefined") return false;
  try {
    const support = await VideoEncoder.isConfigSupported({
      codec: avcCodecString(w, h, fps),
      width: w,
      height: h,
      bitrate: clampVideoBitrate(DEFAULT_VIDEO_BITRATE),
      framerate: fps,
    });
    return support.supported === true;
  } catch {
    return false;
  }
}

/**
 * §2.2 packed 1本化用 H.264/mp4 エンコード。既存 exporter.ts の runMp4 と同型（avcCodecString /
 * configureVideoEncoder / encodeAudioToMuxer を共有）。音声は元 footage から渡された AudioMixResult
 * をそのまま流す（無ければ映像のみの mp4）。
 */
async function encodeRgbaFramesToMp4H264(
  frames: RgbaFrame[],
  fps: number,
  audio: AudioMixResult | null,
  onProgress?: (current: number, total: number) => void,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  if (frames.length === 0) throw new Error("no frames to encode");

  const w = evenDim(frames[0]!.width);
  const h = evenDim(frames[0]!.height);

  const target = new Mp4Target();
  const muxer = new Mp4Muxer({
    target,
    video: { codec: "avc", width: w, height: h, frameRate: fps },
    ...(audio ? { audio: { codec: "aac", numberOfChannels: audio.numberOfChannels, sampleRate: audio.sampleRate } } : {}),
    fastStart: "in-memory",
    firstTimestampBehavior: "offset",
  });

  let encodeError: Error | null = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta ?? undefined),
    error: (e) => {
      encodeError = e instanceof Error ? e : new Error(String(e));
    },
  });

  await configureVideoEncoder(encoder, {
    codec: avcCodecString(w, h, fps),
    width: w,
    height: h,
    bitrate: clampVideoBitrate(DEFAULT_VIDEO_BITRATE),
    framerate: fps,
  });

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

    if (audio) {
      try {
        await encodeAudioToMuxer(
          audio,
          (chunk, meta) => muxer.addAudioChunk(chunk, meta ?? undefined),
          "mp4a.40.2",
          signal,
        );
      } catch {
        // 音声 encode 失敗時も映像だけは書き出す（split/unified と同様 best-effort）。
      }
    }

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
 * §2.2 — color の直下に grayscale mask を上下パックした 1 本の動画を生成する。
 * H.264/mp4 を優先し、非対応環境は VP9/webm にフォールバックする（1本化の利益は両方で残る）。
 * サイズ上限（packed 高さ <= 4096px）は呼び出し側（runSubjectExtract）で判定し、収まらない場合は
 * この関数を呼ばず split のまま扱う。
 */
export async function encodeRgbaFramesToPackedVideo(
  frames: RgbaFrame[],
  fps: number,
  audio: AudioMixResult | null,
  onProgress?: (current: number, total: number) => void,
  signal?: AbortSignal,
): Promise<{ bytes: Uint8Array; container: "mp4" | "webm"; layout: PackedAlphaLayout }> {
  if (frames.length === 0) throw new Error("no frames to encode");
  if (typeof VideoEncoder === "undefined") {
    throw new Error("WebCodecs VideoEncoder unavailable");
  }

  const contentWidth = frames[0]!.width;
  const contentHeight = frames[0]!.height;
  const gutterPx = PACKED_ALPHA_GUTTER_PX;
  const packedH = packedVideoHeight(contentHeight, gutterPx);
  const layout: PackedAlphaLayout = { contentHeight, gutterPx };

  const packedFrames: RgbaFrame[] = frames.map((f) => {
    const packed = new Uint8ClampedArray(f.width * packedH * 4);
    packed.set(toOpaqueRgbColor(f.rgba), 0);
    packed.set(toGrayscaleAlpha(f.rgba), (contentHeight + gutterPx) * f.width * 4);
    return { width: f.width, height: packedH, rgba: packed };
  });

  const h264Ok = await isPackedH264Supported(evenDim(contentWidth), packedH, fps);
  if (h264Ok) {
    const bytes = await encodeRgbaFramesToMp4H264(packedFrames, fps, audio, onProgress, signal);
    return { bytes, container: "mp4", layout };
  }

  // フォールバック: VP9/webm。既存 encodeRgbaFramesToVp9Webm を「ただの不透明フレーム列」として
  // 再利用する（packing 自体はピクセルレベルの前処理なので encoder は関知しない）。
  // 既知の制約: webm フォールバックは音声を含めない（split/unified と同様、v1 スコープ外）。
  const bytes = await encodeRgbaFramesToVp9Webm(
    packedFrames,
    fps,
    { alphaKeep: false, muxAlpha: false },
    onProgress,
    signal,
  );
  return { bytes, container: "webm", layout };
}

/**
 * Subject Extract 用 WebM/mp4 生成。
 * 優先順位: unified（VP9 alpha:keep）→ packed（1本化・サイズ上限内）→ split（2本分離、旧来）。
 */
export async function encodeRgbaFramesToSubjectWebm(
  frames: RgbaFrame[],
  fps: number,
  audio: AudioMixResult | null,
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

  if (packedLayoutFitsSizeLimit({ contentHeight: h, gutterPx: PACKED_ALPHA_GUTTER_PX })) {
    const packed = await encodeRgbaFramesToPackedVideo(frames, fps, audio, onProgress, signal);
    return { mode: "packed", ...packed };
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
