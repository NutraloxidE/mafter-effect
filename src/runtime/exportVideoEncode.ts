// §11.2 — ExportConfig から VideoEncoder 用 bitrate / latencyMode を解決する純関数。

import type { ExportConfig, ExportVideoQuality } from "../core/schema";

export const DEFAULT_VIDEO_BITRATE = 8_000_000;
export const MIN_VIDEO_BITRATE = 50_000;
export const MAX_VIDEO_BITRATE = 50_000_000;

const PRESET_BITRATES: Record<Exclude<ExportVideoQuality, "custom">, number> = {
  low: 1_000_000,
  medium: 4_000_000,
  high: DEFAULT_VIDEO_BITRATE,
  max: 20_000_000,
};

export interface ResolvedExportVideoEncode {
  bitrate: number;
  /** 未指定時は undefined（VideoEncoderConfig に載せない）。 */
  latencyMode: "quality" | "realtime" | undefined;
}

export function clampVideoBitrate(bps: number): number {
  if (!Number.isFinite(bps)) return DEFAULT_VIDEO_BITRATE;
  return Math.min(MAX_VIDEO_BITRATE, Math.max(MIN_VIDEO_BITRATE, Math.round(bps)));
}

export function presetVideoBitrate(quality: Exclude<ExportVideoQuality, "custom">): number {
  return PRESET_BITRATES[quality];
}

/** ExportConfig からエンコード設定を解決。フィールド省略時は現行互換（8 Mbps・latencyMode なし）。 */
export function resolveExportVideoEncode(config: Pick<ExportConfig, "videoQuality" | "videoBitrate" | "encodeLatencyMode">): ResolvedExportVideoEncode {
  const quality = config.videoQuality ?? "high";
  const bitrate = quality === "custom"
    ? clampVideoBitrate(config.videoBitrate ?? DEFAULT_VIDEO_BITRATE)
    : PRESET_BITRATES[quality];
  const latencyMode = config.encodeLatencyMode;
  return { bitrate, latencyMode };
}
