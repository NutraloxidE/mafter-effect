// §11.4b — プロキシ生成用の WebCodecs エンコーダ（webm/VP9）。
// exporter.ts の VideoEncoder + webm-muxer 利用と同型だが、export パイプラインとは独立
// （exporter の動作経路を一切変えないため別モジュールとして閉じる）。映像のみ・音声は原本維持。
//
// 注意: VideoEncoder / createImageBitmap / OffscreenCanvas はブラウザ専用。node/vitest では
// 実行できないため、本モジュールはランタイム検証（verify-*.mjs / 実機）でカバーする。
// 純粋な寸法計算（fitProxyDimensions）のみ単体テスト対象。

import { Muxer as WebmMuxer, ArrayBufferTarget as WebmTarget } from "webm-muxer";
import { RGBA_SOURCE_VIDEO_COLOR_SPACE } from "./videoColorSpace";

/** 長辺が maxDim に収まるよう縦横比保持で縮小した偶数寸法を返す（拡大はしない）。 */
export function fitProxyDimensions(
  srcW: number,
  srcH: number,
  maxDim: number,
): { width: number; height: number } {
  const longest = Math.max(srcW, srcH);
  const scale = longest > maxDim ? maxDim / longest : 1;
  const even = (n: number) => Math.max(2, Math.round(n)) & ~1;
  return { width: even(srcW * scale), height: even(srcH * scale) };
}

export interface ProxyEncodeOptions {
  width: number;
  height: number;
  fps: number;
  frameCount: number;
  /** VideoEncoder.bitrate。tier quality からおおよそ算出して渡す。 */
  bitrate: number;
  /** フレーム fi（0..frameCount-1）の描画済み映像を返す。寸法は width×height 前提。 */
  drawFrame: (fi: number) => Promise<CanvasImageSource> | CanvasImageSource;
  signal?: AbortSignal;
  /** WebCodecs stall 対策のウォッチドッグ（ms）。既定 max(15000, frameCount*500)。 */
  maxDurationMs?: number;
}

/** WebCodecs が使えない理由（使えれば null）。 */
export function webcodecsUnavailableReason(): string | null {
  if (typeof VideoEncoder === "undefined") {
    return "このブラウザは WebCodecs (VideoEncoder) に未対応です。Chrome / Edge 94+ で開いてください。";
  }
  return null;
}

async function configureForCodec(encoder: VideoEncoder, base: VideoEncoderConfig): Promise<void> {
  const prefs: (HardwareAcceleration | undefined)[] = ["prefer-hardware", undefined, "prefer-software"];
  for (const accel of prefs) {
    const cfg: VideoEncoderConfig = accel ? { ...base, hardwareAcceleration: accel } : { ...base };
    try {
      const support = await VideoEncoder.isConfigSupported(cfg);
      if (support.supported) {
        // exporter.ts の configureVideoEncoder と同じ理由: support.config は colorSpace を
        // 黙って落とすため、呼び出し側が指定した colorSpace は明示的に配り直す。
        const finalConfig = support.config ?? cfg;
        encoder.configure(base.colorSpace ? { ...finalConfig, colorSpace: base.colorSpace } : finalConfig);
        return;
      }
    } catch {
      /* 次の候補へ */
    }
  }
  throw new Error(`No supported proxy VideoEncoder config (${base.width}x${base.height})`);
}

/**
 * フレーム列を webm(VP9) にエンコードして Uint8Array を返す。
 * proxy 専用（編集用・byte 一致不要）。失敗時は例外。
 */
export async function encodeFramesToWebm(opts: ProxyEncodeOptions): Promise<Uint8Array> {
  const reason = webcodecsUnavailableReason();
  if (reason) throw new Error(reason);

  const { width, height, fps, frameCount, bitrate, drawFrame, signal } = opts;
  // WebCodecs エンコーダが（HW/環境問題で）出力を出さず stall する環境があるため、全体に
  // ウォッチドッグを掛ける。超過時は throw → 呼び出し側（ensureProxyTier / import）が原本へ
  // フォールバックする＝UI ハングを防ぐ。frameCount に比例（最低 15s / フレーム 0.5s 加算）。
  const watchdogMs = opts.maxDurationMs ?? Math.max(15000, frameCount * 500);
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    watchdog = setTimeout(() => reject(new Error(`proxy encode timed out after ${watchdogMs}ms`)), watchdogMs);
  });
  try {
    return await Promise.race([encodeInner(), timeout]);
  } finally {
    if (watchdog) clearTimeout(watchdog);
  }

  async function encodeInner(): Promise<Uint8Array> {
  const target = new WebmTarget();
  const muxer = new WebmMuxer({
    target,
    video: { codec: "V_VP9", width, height, frameRate: fps },
    firstTimestampBehavior: "offset",
  });

  let encError: Error | null = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta ?? undefined),
    error: (e) => { encError = e instanceof Error ? e : new Error(String(e)); },
  });

  try {
    await configureForCodec(encoder, {
      codec: "vp09.00.10.08",
      width,
      height,
      bitrate,
      framerate: fps,
      colorSpace: RGBA_SOURCE_VIDEO_COLOR_SPACE,
    });

    const usDuration = Math.round(1_000_000 / fps);
    for (let fi = 0; fi < frameCount; fi++) {
      if (signal?.aborted) throw new DOMException("aborted", "AbortError");
      if (encError) throw encError;
      if (encoder.state === "closed") throw new Error("Proxy VideoEncoder closed unexpectedly");

      const src = await drawFrame(fi);
      const vf = new VideoFrame(src, { timestamp: fi * usDuration, duration: usDuration });
      encoder.encode(vf, { keyFrame: fi === 0 || fi % 30 === 0 });
      vf.close();

      while (encoder.encodeQueueSize > 6) {
        await new Promise((r) => setTimeout(r, 16));
      }
    }

    await encoder.flush();
    if (encError) throw encError;
    muxer.finalize();
    return new Uint8Array(target.buffer);
  } finally {
    try {
      if (encoder.state !== "closed") encoder.close();
    } catch {
      /* ignore */
    }
  }
  }
}
