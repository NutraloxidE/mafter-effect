// §11.4b — アニメ WebP/GIF → webm プロキシ生成。可変 delay は等間隔 fps へリサンプル。
// ImageDecoder / canvas / WebCodecs はブラウザ専用。純粋なリサンプル計算のみ単体テスト対象。

import type { AnimatedRasterInfo } from "./animatedRasterDetect";
import { PROXY_TIER_PARAMS, type ProxyTier } from "./footageQuality";
import { encodeFramesToWebm, fitProxyDimensions } from "./webcodecsVideoEncode";

/** 可変 delay を等間隔再生する際の出力 fps を選ぶ（純関数）。1..30 にクランプ。 */
export function chooseProxyFps(info: AnimatedRasterInfo): number {
  if (info.durationSec <= 0) return 12;
  const avg = info.frameCount / info.durationSec;
  return Math.max(1, Math.min(30, Math.round(avg)));
}

/**
 * 出力フレーム fi（fps 等間隔）→ ソースフレーム index を写像（純関数）。
 * ソースの累積表示時間に基づき、その時刻を含むソースフレームを選ぶ。
 */
export function resampleFrameIndices(
  frameDurationsSec: readonly number[],
  outFps: number,
  outFrameCount: number,
): number[] {
  // ソース各フレームの終了時刻（累積）。
  const ends: number[] = [];
  let acc = 0;
  for (const d of frameDurationsSec) {
    acc += d;
    ends.push(acc);
  }
  const total = acc;
  const indices: number[] = [];
  for (let fi = 0; fi < outFrameCount; fi++) {
    const t = (fi + 0.5) / outFps;
    const clamped = total > 0 ? Math.min(t, total - 1e-6) : 0;
    let idx = ends.findIndex((e) => clamped < e);
    if (idx < 0) idx = frameDurationsSec.length - 1;
    indices.push(Math.max(0, idx));
  }
  return indices;
}

export interface RasterProxyResult {
  bytes: Uint8Array;
  mime: string;
  width: number;
  height: number;
  fps: number;
  frameCount: number;
  durationSec: number;
}

/**
 * アニメ WebP/GIF File を指定 tier の webm プロキシにエンコードする。
 * 失敗時は例外（呼び出し側でフォールバック＝原本のまま）。
 */
export async function buildAnimatedRasterProxy(
  file: File,
  info: AnimatedRasterInfo,
  tier: ProxyTier,
): Promise<RasterProxyResult> {
  const ImageDecoderCtor = (globalThis as { ImageDecoder?: typeof ImageDecoder }).ImageDecoder;
  if (typeof ImageDecoderCtor === "undefined") throw new Error("ImageDecoder unavailable");

  const params = PROXY_TIER_PARAMS[tier];
  const { width, height } = fitProxyDimensions(info.width, info.height, params.maxDim);
  const fps = chooseProxyFps(info);
  const outFrameCount = Math.max(1, Math.round(info.durationSec * fps));
  const srcIndices = resampleFrameIndices(info.frameDurationsSec, fps, outFrameCount);

  const mime = file.type || (file.name.toLowerCase().endsWith(".gif") ? "image/gif" : "image/webp");
  const buf = await file.arrayBuffer();
  const decoder = new ImageDecoderCtor({ data: buf, type: mime });
  await decoder.tracks.ready;

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    decoder.close();
    throw new Error("2d context unavailable");
  }

  // ソースフレームのデコードはキャッシュ（同一 index を複数出力フレームが参照するため）。
  const frameCache = new Map<number, VideoFrame>();
  const getSrc = async (idx: number): Promise<VideoFrame> => {
    const cached = frameCache.get(idx);
    if (cached) return cached;
    const { image } = await decoder.decode({ frameIndex: idx });
    frameCache.set(idx, image);
    return image;
  };

  try {
    const bytes = await encodeFramesToWebm({
      width,
      height,
      fps,
      frameCount: outFrameCount,
      bitrate: Math.round(width * height * fps * params.quality * 0.12),
      drawFrame: async (fi) => {
        const src = await getSrc(srcIndices[fi] ?? 0);
        ctx.clearRect(0, 0, width, height);
        ctx.drawImage(src, 0, 0, width, height);
        return canvas;
      },
    });
    return { bytes, mime: "video/webm", width, height, fps, frameCount: outFrameCount, durationSec: info.durationSec };
  } finally {
    for (const f of frameCache.values()) {
      try { f.close(); } catch { /* ignore */ }
    }
    try { decoder.close(); } catch { /* ignore */ }
  }
}
